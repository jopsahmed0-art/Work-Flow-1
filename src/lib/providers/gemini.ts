/**
 * مهايئ Google Gemini (AI Studio) — مفتاح API عادي (AIza أو AQ.) عبر generativelanguage.googleapis.com:
 *  - صور: POST /v1beta/models/{model}:generateContent → inlineData (base64)
 *  - فيديو: POST /v1beta/interactions (Interactions API — بديل Veo 3.1 Preview المتوقف منذ 2026-10-22)
 *    بنموذج gemini-omni-1.2-flash، وضع background غير متزامن + استعلام GET /v1beta/interactions/{id}
 *    الاستجابة تحمل الفيديو في steps[].content[] كـ uri (يُنزَّل بالمفتاح) أو data (base64) — يُخزَّن كرابط عام.
 * المفتاح من: https://aistudio.google.com/apikey
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

/** بحث دفاعي عن base64 الصورة — تغيّر الأشكال بين الإصدارات */
function findBase64Deep(obj: unknown, depth = 0): string | null {
  if (depth > 6 || obj == null) return null;
  if (typeof obj === "string") return null;
  if (Array.isArray(obj)) { for (const x of obj) { const v = findBase64Deep(x, depth + 1); if (v) return v; } return null; }
  if (typeof obj === "object") {
    const rec = obj as Record<string, unknown>;
    for (const k of ["base64", "b64_json", "b64", "image"]) {
      const v = rec[k];
      if (typeof v === "string" && v.length > 500 && !/^https?:\/\//i.test(v) && !v.startsWith("data:")) return v;
      if (typeof v === "string" && v.startsWith("data:")) return v.slice(v.indexOf(",") + 1);
    }
    for (const v of Object.values(rec)) { const r = findBase64Deep(v, depth + 1); if (r) return r; }
  }
  return null;
}

interface VideoOut { uri?: string; data?: string; mime?: string }

/** استخراج الفيديو من استجابة Interactions — content[] بنوع video يحمل uri أو data */
function extractInteractionVideo(obj: unknown, depth = 0): VideoOut | null {
  if (depth > 7 || obj == null) return null;
  if (Array.isArray(obj)) {
    for (const x of obj) { const r = extractInteractionVideo(x, depth + 1); if (r) return r; }
    return null;
  }
  if (typeof obj === "object") {
    const rec = obj as Record<string, unknown>;
    if (rec.type === "video") {
      const mime = typeof rec.mime_type === "string" ? rec.mime_type
        : typeof rec.mimeType === "string" ? rec.mimeType : "video/mp4";
      const uri = typeof rec.uri === "string" && /^https?:\/\//i.test(rec.uri) ? rec.uri : undefined;
      if (uri) return { uri, mime };
      const data = typeof rec.data === "string" && rec.data.length > 100 ? rec.data : undefined;
      if (data) return { data, mime };
      const inline = rec.inlineData as { data?: string; mimeType?: string } | undefined;
      if (inline?.data) return { data: inline.data, mime: inline.mimeType || mime };
    }
    for (const v of Object.values(rec)) { const r = extractInteractionVideo(v, depth + 1); if (r) return r; }
  }
  return null;
}

/** تحويل مخرج الفيديو إلى رابط عام ثابت: inline تُخزَّن مباشرة، وuri يتطلب تنزيلًا بالمفتاح (رابط files محمي) */
async function completeVideo(key: string, video: VideoOut): Promise<string> {
  const mime = video.mime || "video/mp4";
  if (video.data) return saveMedia(mime, video.data);
  if (video.uri) {
    const dl = await providerFetch(video.uri, { headers: { "x-goog-api-key": key }, timeoutMs: 120000 });
    if (!dl.ok) throw new ProviderErrorImpl(dl.status, `gemini: فشل تنزيل الفيديو (HTTP ${dl.status})`);
    return saveMedia(mime, Buffer.from(await dl.arrayBuffer()).toString("base64"));
  }
  throw new ProviderErrorImpl(undefined, "gemini: استجابة فيديو بلا محتوى");
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

  /** فيديو غير متزامن عبر Interactions API — background:true يعيد id نستعلم عنه في checkTask */
  async createTask(key, model, input) {
    const rf: Record<string, unknown> = { type: "video" };
    const ar = String(input.aspect_ratio ?? "");
    // Omni يقبل 16:9 و9:16 فقط — أي قيمة أخرى تُترك للافتراضي
    if (ar === "9:16" || ar === "16:9") rf.aspect_ratio = ar;
    const dur = Math.round(Number(input.duration ?? 8) || 8);
    rf.duration = `${Math.min(15, Math.max(3, dur))}s`;
    const resolution = String(input.resolution ?? "720p");
    rf.resolution = ["360p", "720p", "1080p", "4k"].includes(resolution) ? resolution : "720p";

    const r = await providerFetch(`${GEMINI_BASE}/v1beta/interactions`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-goog-api-key": key },
      body: JSON.stringify({
        model,
        background: true,
        input: [{ type: "text", text: String(input.prompt ?? "") }],
        response_format: [rf],
        generation_config: { video_config: { task: "text_to_video" } },
      }),
      timeoutMs: 60000,
    });
    const data = await readJson(r);
    const id = typeof data.id === "string" ? data.id : "";
    if (!id) throw new ProviderErrorImpl(r.status, "gemini: لم يُعَد معرّف تفاعل الفيديو");

    // لو الرد اكتمل فورًا (الوضع غير المتزامن غير مدعوم): نستخرج ونخزن ونعيد معرّفًا تركيبيًا يحمل الرابط
    if (data.status === "completed") {
      const vid = extractInteractionVideo(data);
      if (vid) return { providerTaskId: `done:${encodeURIComponent(await completeVideo(key, vid))}` };
    }
    return { providerTaskId: id };
  },

  /** استعلام تفاعل الفيديو — عند الاكتمال: تنزيل/تخزين ثم رابط عام */
  async checkTask(key, providerTaskId) {
    // معرّف تركيبي (اكتمل أثناء الإنشاء): الرابط النهائي محفوظ بداخله
    if (providerTaskId.startsWith("done:")) {
      return { status: "completed", urls: [decodeURIComponent(providerTaskId.slice(5))], progress: 100 };
    }
    const r = await providerFetch(`${GEMINI_BASE}/v1beta/interactions/${encodeURIComponent(providerTaskId)}`, {
      method: "GET",
      headers: { "x-goog-api-key": key },
      timeoutMs: 30000,
    });
    const data = await readJson(r);
    const status = String(data.status ?? "");
    if (status === "completed") {
      const vid = extractInteractionVideo(data);
      if (!vid) {
        return { status: "failed", error: "gemini: اكتمل التفاعل دون فيديو (قد يكون الطلب مرفوضًا لسياسات المحتوى)" };
      }
      return { status: "completed", urls: [await completeVideo(key, vid)], progress: 100 };
    }
    if (["failed", "error", "cancelled"].includes(status)) {
      const errObj = data.error as { message?: string } | undefined;
      return { status: "failed", error: errObj?.message ?? `gemini: حالة ${status}` };
    }
    return { status: "processing" };
  },
};
