/**
 * مهايئ NVIDIA NIM (build.nvidia.com) — توليد صور متزامن عبر نقاط genai:
 *  POST https://ai.api.nvidia.com/v1/genai/{model}  (مثل black-forest-labs/flux.1-dev)
 *  التوثيق: Bearer nvapi-… — الاستجابة تُعيد الصورة base64 (artifacts/image/b64_json حسب النسخة).
 * المفتاح من: https://build.nvidia.com (nvapi-…)
 * الجسم يبقى بسيطًا عمدًا (prompt + اختياري) — المزود يطبّق قيمه الافتراضية ويقل ذلك رفض التحقق.
 */
import { ProviderErrorImpl, providerFetch, type ProviderAdapter } from "./types";
import { saveMedia } from "../media";

const NVIDIA_BASE = process.env.NVIDIA_BASE || "https://ai.api.nvidia.com";

/** النسب المدعومة رسميًا لدى نقاط NIM للصور — غير المدرجة تُهمل (يرد المزود 422 على قيم غير معروفة) */
const ASPECTS = new Set(["1:1", "16:9", "9:16", "4:3", "3:4", "3:2", "2:3", "21:9"]);

async function readJson(res: Response): Promise<Record<string, unknown>> {
  let body: Record<string, unknown> = {};
  try { body = (await res.json()) as Record<string, unknown>; } catch { /* جسم غير JSON */ }
  const errObj = body.error as { message?: string } | undefined;
  if (errObj?.message) throw new ProviderErrorImpl(res.status, errObj.message);
  if (typeof body.message === "string" && body.message.toLowerCase().includes("error")) {
    throw new ProviderErrorImpl(res.status, body.message);
  }
  if (!res.ok) {
    // NIM يعيد أخطاء التحقق في "detail" (نص أو مصفوفة FastAPI) — نُظهرها للتشخيص
    const detail = typeof body.detail === "string"
      ? body.detail
      : Array.isArray(body.detail)
        ? JSON.stringify(body.detail).slice(0, 300)
        : "";
    throw new ProviderErrorImpl(res.status, detail ? `NVIDIA ${res.status}: ${detail}` : `HTTP ${res.status}`);
  }
  return body;
}

/** بحث دفاعي عن base64 الصورة — تغيّر الأشكال بين نقاط NIM (artifacts/b64_json/image) */
function findBase64Deep(obj: unknown, depth = 0): string | null {
  if (depth > 6 || obj == null) return null;
  if (typeof obj === "string") return null;
  if (Array.isArray(obj)) { for (const x of obj) { const v = findBase64Deep(x, depth + 1); if (v) return v; } return null; }
  if (typeof obj === "object") {
    const rec = obj as Record<string, unknown>;
    for (const k of ["base64", "b64_json", "b64", "image"]) {
      const v = rec[k];
      if (typeof v === "string" && v.length > 500 && !/^https?:\/\//i.test(v) && !v.startsWith("data:")) return v;
      // بعض النقاط تعيد data URI جاهزًا
      if (typeof v === "string" && v.startsWith("data:")) return v.slice(v.indexOf(",") + 1);
    }
    for (const v of Object.values(rec)) { const r = findBase64Deep(v, depth + 1); if (r) return r; }
  }
  return null;
}

function mimeFromFormat(fmt: string): string {
  switch (fmt) {
    case "jpeg": case "jpg": return "image/jpeg";
    case "webp": return "image/webp";
    default: return "image/png";
  }
}

export const nvidiaAdapter: ProviderAdapter = {
  /** صور متزامنة — base64 يُخزَّن ويُخدَم برابط عام من /api/media */
  async createImageSync(key, model, input) {
    const fmt = String(input.output_format ?? "png");
    const body: Record<string, unknown> = { prompt: String(input.prompt ?? ""), mode: "base", output_format: fmt };
    const ar = String(input.aspect_ratio ?? "");
    if (ASPECTS.has(ar)) body.aspect_ratio = ar;

    // ملاحظة: اسم الموديل يحتوي شرطة مائلة (black-forest-labs/flux.1-dev) — نشفّر كل مقطع منفردًا
    // (encodeURIComponent على الاسم الكامل يشفر "/" نفسها فيلغي المسار → 404)
    const modelPath = model.split("/").map(encodeURIComponent).join("/");
    const res = await providerFetch(`${NVIDIA_BASE}/v1/genai/${modelPath}`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "Accept": "application/json", "Authorization": `Bearer ${key}` },
      body: JSON.stringify(body),
      timeoutMs: 120000,
    });
    const data = await readJson(res);
    const b64 = findBase64Deep(data);
    if (!b64) throw new ProviderErrorImpl(res.status, "NVIDIA: لم يُعَد صورة في الاستجابة");
    const url = await saveMedia(mimeFromFormat(fmt), b64);
    return { urls: [url] };
  },

  /** غير مدعوم: هذا المزود للصور فقط — الرسالة إنجليزية مقصودة لتُصنَّف provider ويُجرَّب المزود التالي */
  async createTask() {
    throw new ProviderErrorImpl(400, "nvidia: model not supported here — image generation only");
  },

  async checkTask() {
    throw new ProviderErrorImpl(400, "nvidia: model not supported here — image generation only");
  },
};
