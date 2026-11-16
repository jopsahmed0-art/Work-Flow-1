/**
 * مهايئ Replicate — Predictions API:
 *   POST https://api.replicate.com/v1/models/{owner}/{name}/predictions  الترويسة: Authorization: Bearer {token}
 *     body {"input": {...}} → {"id": "...", "status": "starting"}
 *   GET https://api.replicate.com/v1/predictions/{id}
 *     → {"status":"starting|processing|succeeded|failed|canceled","output":"https://…mp4" أو مصفوفة روابط,"error":…}
 * المفتاح من: https://replicate.com/account/api-tokens (يبدأ r8_) — دفع لكل استخدام، بلا اشتراك.
 * الموديل الافتراضي للفيديو: minimax/hailuo-2.3 (يُقبل التجاوز عبر REPLICATE_VIDEO_MODEL).
 * الموديل الافتراضي للصور: black-forest-labs/flux-schnell (يُقبل التجاوز عبر REPLICATE_IMAGE_MODEL).
 */
import { ProviderErrorImpl, providerFetch, type ProviderAdapter } from "./types";

const REPLICATE_BASE = "https://api.replicate.com/v1";

async function readReplicate(res: Response): Promise<Record<string, unknown>> {
  let body: Record<string, unknown> = {};
  try { body = (await res.json()) as Record<string, unknown>; } catch { /* جسم غير JSON */ }
  const d = body.detail;
  const detail = typeof d === "string" ? d : d ? JSON.stringify(d).slice(0, 300) : "";
  if (!res.ok) throw new ProviderErrorImpl(res.status, detail || `HTTP ${res.status}`);
  return body;
}

function repHeaders(key: string): HeadersInit {
  return { "Content-Type": "application/json", "Authorization": `Bearer ${key}` };
}

/** output قد يكون رابطًا واحدًا أو مصفوفة روابط */
function extractRepUrls(data: Record<string, unknown>): string[] {
  const out: string[] = [];
  const push = (v: unknown): void => {
    if (typeof v === "string" && /^https:\/\//i.test(v)) out.push(v);
    else if (Array.isArray(v)) v.forEach(push);
    else if (v && typeof v === "object") {
      const u = (v as Record<string, unknown>).url;
      if (typeof u === "string" && /^https:\/\//i.test(u)) out.push(u);
    }
  };
  push(data.output);
  return out;
}

export const replicateAdapter: ProviderAdapter = {
  async createTask(key, model, input) {
    const inp: Record<string, unknown> = { prompt: String(input.prompt ?? "") };
    const imageUrl = typeof input.image_url === "string" && /^https:\/\//i.test(input.image_url) ? input.image_url : "";
    if (imageUrl) inp.image = imageUrl; // الحقل الشائع لموديلات i2v على Replicate

    const modelPath = model.split("/").map(encodeURIComponent).join("/");
    const res = await providerFetch(`${REPLICATE_BASE}/models/${modelPath}/predictions`, {
      method: "POST",
      headers: repHeaders(key),
      body: JSON.stringify({ input: inp }),
      timeoutMs: 30000,
    });
    const data = await readReplicate(res);
    const id = typeof data.id === "string" ? data.id : "";
    if (!id) throw new ProviderErrorImpl(res.status, "replicate: لم يُعَد معرّف التوقع");
    return { providerTaskId: id };
  },

  async checkTask(key, providerTaskId) {
    const res = await providerFetch(`${REPLICATE_BASE}/predictions/${encodeURIComponent(providerTaskId)}`, {
      headers: repHeaders(key), timeoutMs: 20000,
    });
    const data = await readReplicate(res);
    const status = String(data.status ?? "");
    if (status === "succeeded") {
      const urls = extractRepUrls(data);
      if (!urls.length) return { status: "failed", error: "replicate: اكتمل التوقع دون روابط نتائج" };
      return { status: "completed", urls, progress: 100 };
    }
    if (status === "failed" || status === "canceled") {
      const err = typeof data.error === "string" && data.error ? data.error : `replicate: التوقع ${status}`;
      return { status: "failed", error: err };
    }
    return { status: "processing" };
  },
};
