/**
 * مهايئ CometAPI — الأشكال التالية من التوثيق الرسمي الحالي (cometapi.com docs):
 *  - صور متزامنة متوافقة مع OpenAI: POST /v1/images/generations {model,prompt,...} → data[{url|b64_json}]
 *    (صفحة الموديل الرسمية تعرض الاسم "gpt-image-2.6-flare" — يُقبل التجاوز عبر COMETAPI_IMAGE_MODEL)
 *  - فيديو غير متزامن: POST /v1/videos (multipart: model,prompt,seconds,size[,input_reference])
 *      → {"id":"...","status":"queued","progress":0}
 *    الاستعلام: GET /v1/videos/{id} → {id,status,progress,...} وقد يأتي ملفوفًا في data
 *    حالات: queued|in_progress|completed|success|failed|error|FAILURE
 *  - تنزيل الناتج: GET /v1/videos/{id}/content (ثنائي — لكن قاعدتنا روابط فقط، لذا نعتمد حقل رابط عند الاكتمال)
 */
import { ProviderErrorImpl, providerFetch, type ProviderAdapter } from "./types";

const COMET_BASE = process.env.COMETAPI_BASE || "https://api.cometapi.com";

async function readJson(res: Response): Promise<Record<string, unknown>> {
  let body: Record<string, unknown> = {};
  try { body = (await res.json()) as Record<string, unknown>; } catch { /* جسم غير JSON */ }
  // بعض الأخطاء تأتي {"error":{"message":...}} على نمط OpenAI
  const errObj = body.error as { message?: string } | undefined;
  if (errObj?.message) throw new ProviderErrorImpl(res.status, errObj.message);
  if (typeof body.message === "string" && !res.ok) throw new ProviderErrorImpl(res.status, body.message);
  if (!res.ok && !body.data) throw new ProviderErrorImpl(res.status, `HTTP ${res.status}`);
  return body;
}

const DONE = new Set(["completed", "success", "succeeded", "finished"]);
const FAIL = new Set(["failed", "error", "failure", "cancelled", "FAILURE"]);

/** بحث دفاعي عن رابط عام في الاستجابة (تغير الأشكال بين المزودين/النسخ) */
function findUrlDeep(obj: unknown, depth = 0): string | null {
  if (depth > 5 || obj == null) return null;
  if (typeof obj === "string") return /^https?:\/\/\S+$/i.test(obj) ? obj : null;
  if (Array.isArray(obj)) { for (const x of obj) { const u = findUrlDeep(x, depth + 1); if (u) return u; } return null; }
  if (typeof obj === "object") {
    const rec = obj as Record<string, unknown>;
    for (const k of ["url", "video_url", "videoUrl", "output_url", "outputUrl", "result_url", "resultUrl", "download_url", "downloadUrl"]) {
      const v = rec[k];
      if (typeof v === "string" && /^https?:\/\//i.test(v)) return v;
    }
    for (const v of Object.values(rec)) { const u = findUrlDeep(v, depth + 1); if (u) return u; }
  }
  return null;
}

/** خريطة أبعاد الفيديو لصيغة size المتوافقة مع نقطة /v1/videos */
function sizeFromResolution(resolution?: string): string {
  switch (resolution) {
    case "1080p": return "1920x1080";
    case "720p": return "1280x720";
    case "480p":
    default: return "854x480";
  }
}

export const cometapiAdapter: ProviderAdapter = {
  /** صور متزامنة — النتيجة فورًا برابط أو b64 */
  async createImageSync(key, model, input) {
    const res = await providerFetch(`${COMET_BASE}/v1/images/generations`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "Authorization": `Bearer ${key}` },
      body: JSON.stringify({
        model,
        prompt: String(input.prompt ?? ""),
        n: 1,
        // نمرر المعطيات الاختيارية فقط إن حضرت — المزود يرفض غير المعروف أحيانًا
        ...(input.size ? { size: input.size } : {}),
      }),
      timeoutMs: 120000,
    });
    const body = await readJson(res);
    const data = (body.data ?? []) as Array<{ url?: string; b64_json?: string }>;
    const urls: string[] = [];
    for (const item of data) {
      if (item?.url && /^https?:\/\//i.test(item.url)) { urls.push(item.url); continue; }
      if (item?.b64_json) {
        // قاعدتنا: روابط فقط ولا تنزيل وسائط — لكن data URI يعرض مباشرة دون تخزين على السيرفر
        const dataUri = `data:image/png;base64,${item.b64_json}`;
        if (dataUri.length < 2 * 1024 * 1024) urls.push(dataUri); // نتجاوز حدود صفوف libSQL (~2MB)
      }
    }
    if (!urls.length) throw new ProviderErrorImpl(res.status, "CometAPI: لم يُعَد رابط صورة قابلًا للاستخدام");
    return { urls };
  },

  /** فيديو غير متزامن عبر نقطة المهام */
  async createTask(key, model, input) {
    const form = new FormData();
    form.append("model", model);
    form.append("prompt", String(input.prompt ?? ""));
    if (input.duration) form.append("seconds", String(input.duration));
    if (input.resolution) form.append("size", sizeFromResolution(String(input.resolution)));
    if (input.image_url) {
      // الوثائق تتوقع ملفًا؛ نمرر الرابط كحقل نصي فإذا رفضه المزود يُصنَّف provider ويُجرَّب المزود الآخر
      form.append("input_reference", String(input.image_url));
    }
    const res = await providerFetch(`${COMET_BASE}/v1/videos`, {
      method: "POST",
      headers: { "Authorization": `Bearer ${key}` },
      body: form,
      timeoutMs: 60000,
    });
    const body = await readJson(res);
    const data = (body.data ?? body) as Record<string, unknown>;
    const id = data.id ?? data.task_id ?? data.video_id;
    if (!id) throw new ProviderErrorImpl(res.status, "CometAPI: لم يُعَد معرّف مهمة الفيديو", 500);
    return { providerTaskId: String(id) };
  },

  async checkTask(key, providerTaskId) {
    const res = await providerFetch(`${COMET_BASE}/v1/videos/${encodeURIComponent(providerTaskId)}`, {
      method: "GET",
      headers: { "Authorization": `Bearer ${key}` },
      timeoutMs: 20000,
    });
    const body = await readJson(res);
    const data = ((body.data as Record<string, unknown>) ?? body) as Record<string, unknown>;
    const status = String(data.status ?? "").toLowerCase();
    const progress = typeof data.progress === "number" ? data.progress : undefined;
    if (DONE.has(status)) {
      const url = findUrlDeep(data);
      if (!url) {
        // الناتج ثنائي عبر /content فقط (يتطلب المفتاح) — لا يمكننا توفير رابط عام دون تنزيل، وقاعدتنا روابط فقط
        return { status: "failed", error: "CometAPI: اكتملت المهمة دون رابط عام للفيديو (الناتج عبر نقطة محمية)" };
      }
      return { status: "completed", urls: [url], progress: 100 };
    }
    if (FAIL.has(status)) {
      const errObj = data.error as { message?: string } | undefined;
      return { status: "failed", error: errObj?.message ?? `CometAPI: حالة ${status}` };
    }
    return { status: "processing", progress };
  },
};
