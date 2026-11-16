/**
 * مهايئ مزود مخصص متوافق مع OpenAI — للصور فقط حاليًا.
 * يخدم أي موقع يعرض POST {base}/images/generations بمصادقة Bearer، مثل:
 *   DeepInfra:  https://api.deepinfra.com/v1/openai
 *   AI/ML API:  https://api.aimlapi.com/v1
 *   Novita:     https://api.novita.ai/v3/openai
 * يتطلب لكل مفتاح: base_url (تُضبط من لوحة الإدارة) + model_override باسم الموديل لدى ذلك الموقع.
 * الاستجابة تقبل url مباشرًا (عام) أو b64_json (يُخزَّن كرابط عام عبر saveMedia).
 */
import { ProviderErrorImpl, providerFetch, type ProviderAdapter, type KeyMeta } from "./types";
import { saveMedia } from "../media";

/** بناء رابط نقطة الصور حسب نهاية base_url — يدعم الأشكال الشائعة (/v1، /v1/openai، /v3/openai) */
function imagesEndpoint(baseUrl: string): string {
  const b = baseUrl.trim().replace(/\/+$/, "");
  if (/\/(v1|openai|v1\/openai|v3\/openai)$/i.test(b)) return `${b}/images/generations`;
  return `${b}/v1/images/generations`;
}

/** تحويل نسبة الأبعاد إلى أحجام OpenAI الشائعة */
function openAiSize(ar: string): string {
  if (ar === "16:9" || ar === "3:2") return "1536x1024";
  if (ar === "9:16" || ar === "2:3" || ar === "3:4") return "1024x1536";
  return "1024x1024";
}

export function customAdapter(meta: KeyMeta): ProviderAdapter {
  const baseUrl = (meta.baseUrl ?? "").trim();
  return {
    async createImageSync(key, model, input) {
      if (!baseUrl || !/^https?:\/\//i.test(baseUrl)) {
        throw new ProviderErrorImpl(500, "custom: المفتاح بلا base_url صالح — أضف رابط الـ API من لوحة الإدارة");
      }
      const ar = String(input.aspect_ratio ?? "");
      const res = await providerFetch(imagesEndpoint(baseUrl), {
        method: "POST",
        headers: { "Content-Type": "application/json", "Authorization": `Bearer ${key}` },
        body: JSON.stringify({
          model,
          prompt: String(input.prompt ?? ""),
          size: openAiSize(ar),
          n: 1,
        }),
        timeoutMs: 180000,
      });
      let body: Record<string, unknown> = {};
      try { body = (await res.json()) as Record<string, unknown>; } catch { /* جسم غير JSON */ }
      const errObj = body.error as { message?: string } | undefined;
      if (!res.ok || errObj?.message) {
        throw new ProviderErrorImpl(res.status, errObj?.message ?? `HTTP ${res.status}`);
      }
      const arr = Array.isArray(body.data) ? (body.data as Array<Record<string, unknown>>) : [];
      const first = arr[0] ?? {};
      if (typeof first.url === "string" && /^https:\/\//i.test(first.url)) return { urls: [first.url] };
      if (typeof first.b64_json === "string" && first.b64_json.length > 100) {
        return { urls: [await saveMedia("image/png", first.b64_json)] };
      }
      throw new ProviderErrorImpl(res.status, "custom: لم تُعَد صورة في الاستجابة");
    },

    async createTask() {
      // رسالة إنجليزية مقصودة لتُصنَّف provider ويُجرَّب المزود التالي
      throw new ProviderErrorImpl(400, "custom: model not supported here — openai-images only");
    },

    async checkTask() {
      throw new ProviderErrorImpl(400, "custom: model not supported here — openai-images only");
    },
  };
}
