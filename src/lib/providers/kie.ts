/**
 * مهايئ kie.ai — Jobs API الموحد (الأشكال أدناه مقاسة فعليًا بنداءات حقيقية، ليست مُخترعة):
 *   POST https://api.kie.ai/api/v1/jobs/createTask  → {"code":200,"msg":"success","data":{"taskId":"..."}}
 *   GET  https://api.kie.ai/api/v1/jobs/recordInfo?taskId=... → {"code":200,"data":{"state":"waiting|queuing|generating|success|fail",
 *          "resultJson":"{\"resultUrls\":[\"...\"]}" (نص JSON داخل JSON يحتاج JSON.parse ثانيًا),
 *          "failMsg":..., "response":{"resultUrls":[...]}}}
 * ملاحظة مقاسة: kie يعيد HTTP 200 دائمًا مع رمز الحالة الحقيقي داخل الجسم code —
 *   مفتاح خاطئ → {"code":401,"msg":"Unauthorized – Authentication failed..."}
 *   موديل غير مدعوم → {"code":422,"msg":"The model name you specified is not supported..."}
 */
import { ProviderErrorImpl, providerFetch, type ProviderAdapter } from "./types";

const KIE_BASE = "https://api.kie.ai";

/** قراءة استجابة kie وتحويل أي code != 200 إلى ProviderError بالرمز الحقيقي */
async function readKieBody(res: Response): Promise<Record<string, unknown>> {
  let body: Record<string, unknown> = {};
  try { body = (await res.json()) as Record<string, unknown>; } catch { /* جسم غير JSON */ }
  const code = typeof body.code === "number" ? body.code : undefined;
  const msg = typeof body.msg === "string" ? body.msg : `HTTP ${res.status}`;
  if ((code !== undefined && code !== 200) || (code === undefined && !res.ok)) {
    throw new ProviderErrorImpl(res.status, msg, code);
  }
  return body;
}

function kieHeaders(key: string): HeadersInit {
  return {
    "Content-Type": "application/json",
    "Authorization": `Bearer ${key}`,
  };
}

/** استخراج روابط النتائج من حقول الاستجابة المتعددة الأشكال (resultJson نصي أو response مباشر) */
function extractKieUrls(data: Record<string, unknown>): string[] {
  // الشكل الجديد: data.response.resultUrls
  const resp = data.response as Record<string, unknown> | undefined;
  if (resp && Array.isArray(resp.resultUrls) && resp.resultUrls.length) {
    return resp.resultUrls.map(String).filter((u) => /^https?:\/\//i.test(u));
  }
  // الشكل الموثق: data.resultJson نص JSON يحتاج parse ثانيًا
  if (typeof data.resultJson === "string" && data.resultJson.trim()) {
    try {
      const inner = JSON.parse(data.resultJson) as { resultUrls?: unknown };
      if (Array.isArray(inner.resultUrls) && inner.resultUrls.length) {
        return inner.resultUrls.map(String).filter((u) => /^https?:\/\//i.test(u));
      }
    } catch { /* تجاهل — سنفشل أدناه برسالة واضحة */ }
  }
  // احتياط: resultUrls مباشرة في الجسم
  if (Array.isArray(data.resultUrls) && data.resultUrls.length) {
    return data.resultUrls.map(String).filter((u) => /^https?:\/\//i.test(u));
  }
  return [];
}

export const kieAdapter: ProviderAdapter = {
  async createTask(key, model, input) {
    const res = await providerFetch(`${KIE_BASE}/api/v1/jobs/createTask`, {
      method: "POST",
      headers: kieHeaders(key),
      body: JSON.stringify({ model, input }),
      timeoutMs: 30000,
    });
    const body = await readKieBody(res);
    const data = body.data as { taskId?: string } | undefined;
    const taskId = data?.taskId;
    if (!taskId) throw new ProviderErrorImpl(res.status, "kie: لم يُعَد taskId في الاستجابة", 500);
    return { providerTaskId: taskId };
  },

  async checkTask(key, providerTaskId) {
    const res = await providerFetch(
      `${KIE_BASE}/api/v1/jobs/recordInfo?taskId=${encodeURIComponent(providerTaskId)}`,
      { method: "GET", headers: kieHeaders(key), timeoutMs: 20000 }
    );
    const body = await readKieBody(res);
    const data = (body.data ?? {}) as Record<string, unknown>;
    const state = String(data.state ?? "");
    if (state === "success") {
      const urls = extractKieUrls(data);
      if (!urls.length) {
        // نجح بحالة بلا روابط — نعامله كفشل معلن من المزود
        return { status: "failed", error: "kie: اكتملت المهمة دون روابط نتائج" };
      }
      return { status: "completed", urls, progress: 100 };
    }
    if (state === "fail") {
      const failMsg = String(data.failMsg ?? "فشل غير معروف لدى kie.ai");
      return { status: "failed", error: failMsg };
    }
    // waiting | queuing | generating — لا يوجد نسبة عددية مقاسة لدى kie
    return { status: "processing" };
  },
};
