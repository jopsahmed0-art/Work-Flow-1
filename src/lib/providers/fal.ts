/**
 * مهايئ fal.ai — Queue API موحد لكل الموديلات (فيديو + صور غير متزامنة):
 *   POST https://queue.fal.run/{model_id}   الترويسة: Authorization: Key {FAL_KEY}
 *     → {"request_id","status":"IN_QUEUE","status_url","response_url"}
 *   GET {response_url}/status → {"status":"IN_QUEUE|IN_PROGRESS|COMPLETED"}
 *   GET {response_url}        → ناتج الموديل: فيديو {"video":{"url":"https://v3.fal.media/…mp4"}}
 *                                أو صور {"images":[{"url":…}]}
 * المفتاح من: https://fal.ai/dashboard/keys — التسعير بالثانية ($0.08/ث 480p، $0.14/ث 720p لفيديو grok).
 * موديل الفيديو الافتراضي: xai/grok-imagine-video/text-to-video (يُقبل التجاوز عبر FAL_VIDEO_MODEL).
 * موديل الصور الافتراضي: fal-ai/flux/schnell (يُقبل التجاوز عبر FAL_IMAGE_MODEL).
 */
import { ProviderErrorImpl, providerFetch, type ProviderAdapter } from "./types";

const FAL_QUEUE = "https://queue.fal.run";

async function readFal(res: Response): Promise<Record<string, unknown>> {
  let body: Record<string, unknown> = {};
  try { body = (await res.json()) as Record<string, unknown>; } catch { /* جسم غير JSON */ }
  const d = body.detail;
  const detail = typeof d === "string" ? d : d ? JSON.stringify(d).slice(0, 300) : "";
  if (!res.ok || detail) throw new ProviderErrorImpl(res.status, detail || `HTTP ${res.status}`);
  return body;
}

function falHeaders(key: string): HeadersInit {
  return { "Content-Type": "application/json", "Authorization": `Key ${key}` };
}

/** بحث دفاعي عن أول رابط نتيجة في ناتج fal (video.url / images[].url / أي رابط وسائط مباشر) */
function extractFalUrls(obj: unknown, depth = 0): string[] {
  if (depth > 6 || obj == null) return [];
  if (typeof obj === "string") {
    return /^https:\/\/.*\.(mp4|webm|mov|png|jpe?g|webp)(\?|$)/i.test(obj) ? [obj] : [];
  }
  if (Array.isArray(obj)) return obj.flatMap((x) => extractFalUrls(x, depth + 1));
  if (typeof obj === "object") {
    const rec = obj as Record<string, unknown>;
    const out: string[] = [];
    for (const k of ["url", "video_url", "image_url"]) {
      const v = rec[k];
      if (typeof v === "string" && /^https:\/\//i.test(v)) out.push(v);
    }
    if (out.length) return out;
    for (const v of Object.values(rec)) {
      const r = extractFalUrls(v, depth + 1);
      if (r.length) return r;
    }
  }
  return [];
}

export const falAdapter: ProviderAdapter = {
  async createTask(key, model, input) {
    // صورة مرجعية → نحوّل تلقائيًا لمسار image-to-video إن وُجد لنفس الموديل
    let effectiveModel = model;
    const imageUrl = typeof input.image_url === "string" && /^https:\/\//i.test(input.image_url) ? input.image_url : "";
    if (imageUrl && effectiveModel.endsWith("/text-to-video")) {
      effectiveModel = `${effectiveModel.slice(0, -"/text-to-video".length)}/image-to-video`;
    }

    const body: Record<string, unknown> = { prompt: String(input.prompt ?? "") };
    const ar = String(input.aspect_ratio ?? "");
    // القيم الآمنة التي تقبلها معظم موديلات fal — غير ذلك يُترك للافتراضي
    if (ar === "9:16" || ar === "16:9" || ar === "1:1") body.aspect_ratio = ar;
    if (imageUrl) body.image_url = imageUrl;

    const modelPath = effectiveModel.split("/").map(encodeURIComponent).join("/");
    const res = await providerFetch(`${FAL_QUEUE}/${modelPath}`, {
      method: "POST",
      headers: falHeaders(key),
      body: JSON.stringify(body),
      timeoutMs: 30000,
    });
    const data = await readFal(res);
    const responseUrl = typeof data.response_url === "string" && data.response_url
      ? data.response_url
      : typeof data.status_url === "string" && data.status_url
        ? data.status_url.replace(/\/status$/, "")
        : "";
    if (!responseUrl) throw new ProviderErrorImpl(res.status, "fal: لم يُعَد معرّف طلب التوليد");
    return { providerTaskId: responseUrl };
  },

  async checkTask(key, providerTaskId) {
    // providerTaskId = response_url الكامل المحفوظ عند الإنشاء
    const st = await providerFetch(`${providerTaskId}/status`, { headers: falHeaders(key), timeoutMs: 20000 });
    const sdata = await readFal(st);
    const status = String(sdata.status ?? "").toUpperCase();
    if (status !== "COMPLETED") {
      if (status === "ERROR") return { status: "failed", error: "fal: فشل الطلب في قائمة الانتظار" };
      return { status: "processing" };
    }
    const res = await providerFetch(providerTaskId, { headers: falHeaders(key), timeoutMs: 60000 });
    const data = await readFal(res);
    if (typeof data.error === "string" && data.error) return { status: "failed", error: data.error };
    const urls = extractFalUrls(data);
    if (!urls.length) return { status: "failed", error: "fal: اكتمل الطلب دون روابط نتائج" };
    return { status: "completed", urls, progress: 100 };
  },
};
