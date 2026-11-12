/**
 * مهايئ Google Gemini (AI Studio) — توليد صور متزامن عبر generateContent:
 *  POST https://generativelanguage.googleapis.com/v1beta/models/{model}:generateContent
 *  التوثيق: x-goog-api-key — الاستجابة تحمل الصورة في inlineData.data (base64).
 * المفتاح من: https://aistudio.google.com/apikey (يبدأ عادة AIza أو AQ.)
 * نموذج الصورة الحالي: gemini-2.5-flash-image (يُقبل التجاوز عبر GEMINI_IMAGE_MODEL).
 */
import { ProviderErrorImpl, providerFetch, type ProviderAdapter } from "./types";
import { saveMedia } from "../media";

const GEMINI_BASE = process.env.GEMINI_BASE || "https://generativelanguage.googleapis.com";

interface InlinePart { inlineData?: { mimeType?: string; data?: string } }

async function readJson(res: Response): Promise<Record<string, unknown>> {
  let body: Record<string, unknown> = {};
  try { body = (await res.json()) as Record<string, unknown>; } catch { /* جسم غير JSON */ }
  const errObj = body.error as { code?: number; message?: string } | undefined;
  if (errObj?.message) throw new ProviderErrorImpl(res.status ?? errObj.code, errObj.message);
  if (!res.ok) throw new ProviderErrorImpl(res.status, `HTTP ${res.status}`);
  return body;
}

export const geminiAdapter: ProviderAdapter = {
  /** صور متزامنة — الصورة تُخزَّن وتُخدَم برابط عام من /api/media */
  async createImageSync(key, model, input) {
    let text = String(input.prompt ?? "");
    const ar = String(input.aspect_ratio ?? "");
    if (ar && ar !== "auto") text += ` (aspect ratio ${ar})`;

    const modelPath = model.split("/").map(encodeURIComponent).join("/");
    const res = await providerFetch(`${GEMINI_BASE}/v1beta/models/${modelPath}:generateContent`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-goog-api-key": key },
      body: JSON.stringify({
        contents: [{ parts: [{ text }] }],
        generationConfig: { responseModalities: ["TEXT", "IMAGE"] },
      }),
      timeoutMs: 120000,
    });
    const data = await readJson(res);

    const candidates = (data.candidates ?? []) as Array<Record<string, unknown>>;
    const parts = ((candidates[0]?.content as Record<string, unknown> | undefined)?.parts ?? []) as InlinePart[];
    const img = parts.find((p) => p.inlineData?.data);
    if (!img?.inlineData?.data) {
      throw new ProviderErrorImpl(res.status, "gemini: لم تُعَد صورة في الاستجابة (قد يكون الطلب مرفوضًا لسياسات المحتوى)");
    }
    const url = await saveMedia(img.inlineData.mimeType || "image/png", img.inlineData.data);
    return { urls: [url] };
  },

  /** غير مدعوم: هذا المزود للصور فقط — الرسالة إنجليزية مقصودة لتُصنَّف provider ويُجرَّب المزود التالي */
  async createTask() {
    throw new ProviderErrorImpl(400, "gemini: model not supported here — image generation only");
  },

  async checkTask() {
    throw new ProviderErrorImpl(400, "gemini: model not supported here — image generation only");
  },
};
