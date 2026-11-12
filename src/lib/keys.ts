/**
 * نظام المفاتيح المتسلسلة — قلب المشروع.
 * 1) ترتيب تسلسلي صارم بترتيب الإضافة (created_at ASC, id ASC) — ليس round-robin.
 * 2) تصنيف موحد للأخطاء يحدد المصير: تعطيل المفتاح / استنزافه / خطأ معطيات / خطأ مؤقت.
 * 3) إخفاء المفاتيح إلزامي في كل الاستجابات (maskKey).
 */
import { getTurso, ensureSchema, type KeyRow } from "./turso";

/** جلب مسبحة المفاتيح لمزودات الموديل — المستنزف يبقى في القائمة، والتعطيل يدوي فقط.
 * الترتيب: مواقع المزودين في models.ts أولًا (كما هو موثّق)، ثم وقت إضافة المفتاح داخل كل مزود */
export async function getKeyPool(providers: string[]): Promise<KeyRow[]> {
  await ensureSchema();
  if (!providers.length) return [];
  const placeholders = providers.map(() => "?").join(", ");
  const cases = providers.map((p, i) => `WHEN ? THEN ${i}`).join(" ");
  const r = await getTurso().execute({
    sql: `SELECT * FROM api_keys
          WHERE status != 'disabled' AND provider IN (${placeholders})
          ORDER BY CASE provider ${cases} END, created_at ASC, id ASC`,
    args: [...providers, ...providers],
  });
  return r.rows.map((x) => x as unknown as KeyRow);
}

export type ErrorClass = "disabled" | "exhausted" | "provider" | "params" | "temporary";

/** أنماط الرسائل المعروفة — تُفحص case-insensitive */
// "unusual account activity": الحساب نفسه معلّق من المزود (مقاسة من kie.ai) — لا طلب سيمرّ به فالتعطيل تلقائيًا أفضل من تكرار المحاولة للأبد
const AUTH_PATTERNS = /invalid api key|unauthorized|forbidden|authentication|api key.*(invalid|not valid|incorrect)|invalid.*(token|key)|unusual account activity/i;
const BALANCE_PATTERNS = /insufficient|quota|balance|credit|out of credits|exhausted|充值|billing|payment required|no enough/i;
const MODEL_PATTERNS = /model not found|unsupported model|not supported.*model|model.*(not supported|does not exist|not found)|unknown model/i;

/**
 * تصنيف خطأ المزود حسب جدول القواعد.
 * ملاحظة مقاسة: kie.ai يعيد HTTP 200 دائمًا مع رمز الحالة الحقيقي داخل الجسم
 * ({code:401,...}) — لذا «الحالة الفعالة» هنا هي body.code إن وُجد وإلا حالة HTTP.
 * ترتيب الفحص مقصود: نفاد الرصيد قبل 400 لأن بعض المزودين يرسلونه بحالة 400.
 */
export function classifyProviderError(httpStatus: number | undefined, message: string, bodyCode?: number): ErrorClass {
  const effective = bodyCode ?? httpStatus ?? 0;
  const msg = String(message ?? "");

  // 1) مصادقة → المفتاح مرفوض
  if (effective === 401 || effective === 403 || AUTH_PATTERNS.test(msg)) return "disabled";

  // 2) نفاد رصيد (قبل فحص 400 عمدًا)
  if (effective === 402 || BALANCE_PATTERNS.test(msg)) return "exhausted";

  // 3) موديل غير مدعوم لدى هذا المزود → انتقل للمفتاح/المزود التالي
  if (MODEL_PATTERNS.test(msg) && [400, 404, 422].includes(effective)) return "provider";

  // 4) معطيات الطلب → توقف فورًا (تبديل المفاتيح لن يحل خطأ معطيات)
  if (effective === 400 || effective === 422) return "params";

  // 5) مؤقت: 429 أو 5xx أو أي شيء آخر غير معروف → انتقل للتالي الآن
  return "temporary";
}

/** إخفاء المفتاح: أول 7 أحرف + نقاط + آخر 4 — للمفاتيح القصيرة أول 3 + نقاط */
export function maskKey(key: string): string {
  if (!key) return "";
  if (key.length >= 14) return `${key.slice(0, 7)}••••••••${key.slice(-4)}`;
  return `${key.slice(0, 3)}••••`;
}

/** نسخة آمنة من المفتاح للعرض — لا يُعاد المفتاح الكامل في أي استجابة */
export function safeKey(k: KeyRow): Record<string, unknown> {
  return {
    id: k.id,
    provider: k.provider,
    label: k.label || "",
    masked: maskKey(k.api_key),
    status: k.status,
    usage_count: k.usage_count,
    success_count: k.success_count,
    fail_count: k.fail_count,
    last_used_at: k.last_used_at,
    last_checked_at: k.last_checked_at,
    last_error: k.last_error,
    created_at: k.created_at,
    // بيانات المزودات المخصصة (ليست سرية)
    base_url: k.base_url || "",
    dialect: k.dialect || "",
    model_override: k.model_override || "",
  };
}
