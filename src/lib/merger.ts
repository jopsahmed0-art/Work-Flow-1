/**
 * عميل خدمة دمج الفيديو — Video Merger API v2 (بلا مفاتيح أو توثيق).
 * المخرجات: MP4 (H.264 + AAC) — لا معاملات resolution/fps، الناتج ثابت.
 * القيود: 10 مقاطع كحد أقصى، 200MB لكل مصدر، 150MB للناتج، 600 ثانية إجمالًا، الحذف بعد 24 ساعة.
 *
 * قاعدة حتمية: أي خطأ HTTP معلن من الخدمة (4xx/5xx بجسم error) = فشل نهائي فوري — لا إعادة محاولة.
 * أخطاء شبكتنا نحن (timeout/fetch) = مؤقتة → استمر بالاستعلام حتى انتهاء النافذة.
 */

const MERGER_BASE = (process.env.MERGER_API_BASE || "").replace(/\/+$/, "");

export class MergerHttpError extends Error {
  status: number;
  constructor(status: number, message: string) {
    super(message);
    this.name = "MergerHttpError";
    this.status = status;
  }
}

/** نداء fetch موحد: أخطاء HTTP المعلنة → MergerHttpError (نهائي)، أخطاء الشبكة → رمي عادي (مؤقت) */
async function mergerFetch(url: string, init: RequestInit & { timeoutMs?: number } = {}): Promise<Response> {
  const { timeoutMs = 30000, ...rest } = init;
  try {
    return await fetch(url, { ...rest, signal: AbortSignal.timeout(timeoutMs) });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    throw new Error(`network: ${msg}`); // مؤقت — لا تحمل status
  }
}

async function readBody(res: Response): Promise<Record<string, unknown>> {
  try { return (await res.json()) as Record<string, unknown>; } catch { return {}; }
}

export function mergerConfigured(): boolean {
  return Boolean(MERGER_BASE) && !MERGER_BASE.includes("xxxxxxxx");
}

export function mergerBase(): string {
  return MERGER_BASE;
}

/** فحص الجهوزية: GET /api/config بمهلة 4 ثوانٍ */
export async function mergerHealthy(): Promise<boolean> {
  if (!mergerConfigured()) return false;
  try {
    const res = await mergerFetch(`${MERGER_BASE}/api/config`, { timeoutMs: 4000 });
    return res.ok;
  } catch {
    return false;
  }
}

export interface MergerJob {
  jobId: string;
  status: "queued" | "processing" | "done" | "failed";
  progress: number; // 0..100 مُطبَّع
  videoUrl?: string;
  downloadUrl?: string;
  error?: string;
}

const DONE_STATES = new Set(["done", "completed", "complete", "success", "succeeded", "finished"]);
const FAIL_STATES = new Set(["error", "failed", "failure", "cancelled"]);

/** تحليل حالة دفاعي: قد يرد الجسم فيه error بدون حقل status → عاملها failed فورًا */
function parseJob(json: Record<string, unknown>): MergerJob {
  const statusRaw = String(json.status ?? "").toLowerCase();
  const hasError = typeof json.error === "string" && json.error.length > 0;

  let status: MergerJob["status"];
  if (DONE_STATES.has(statusRaw)) status = "done";
  else if (FAIL_STATES.has(statusRaw) || (!statusRaw && hasError)) status = "failed";
  else status = "processing"; // queued | processing | أياً كان الباقي

  // progress قد يأتي كسرًا 0..1 → اضربه في 100
  let progress = typeof json.progress === "number" ? json.progress : 0;
  if (progress > 0 && progress <= 1) progress *= 100;
  if (status === "done") progress = 100;

  // رابط النتيجة: فضّل videoUrl ثم downloadUrl، وإن غابا فاضبط مسار /video القياسي
  const videoUrl = typeof json.videoUrl === "string" && json.videoUrl ? json.videoUrl : undefined;
  const downloadUrl = typeof json.downloadUrl === "string" && json.downloadUrl ? json.downloadUrl : undefined;
  const jobId = String(json.jobId ?? "");

  return {
    jobId,
    status,
    progress: Math.max(0, Math.min(100, Math.round(progress))),
    videoUrl: videoUrl || (status === "done" && jobId ? `${MERGER_BASE}/api/jobs/${jobId}/video` : undefined),
    downloadUrl,
    error: hasError ? String(json.error) : undefined,
  };
}

/** إنشاء مهمة دمج */
export async function createMergeJob(urls: string[]): Promise<{ jobId: string }> {
  const res = await mergerFetch(`${MERGER_BASE}/api/jobs`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ videos: urls }),
    timeoutMs: 30000,
  });
  const body = await readBody(res);
  if (hasDeclaredError(res, body)) {
    throw new MergerHttpError(res.status, String(body.error ?? `HTTP ${res.status}`));
  }
  const jobId = body.jobId ?? body.id;
  if (!jobId) throw new MergerHttpError(res.status, "خدمة الدمج لم تُعَد jobId");
  return { jobId: String(jobId) };
}

/** تنفيذ الدمج (blocking ~10–15 ثانية) — يُستدعى مرة واحدة فقط بخلفية الكود */
export async function processMergeJob(jobId: string): Promise<void> {
  const res = await mergerFetch(`${MERGER_BASE}/api/jobs/${encodeURIComponent(jobId)}/process`, {
    method: "POST",
    timeoutMs: 120000,
  });
  const body = await readBody(res);
  if (hasDeclaredError(res, body)) {
    throw new MergerHttpError(res.status, String(body.error ?? `HTTP ${res.status}`));
  }
  if (res.status >= 400) throw new MergerHttpError(res.status, `HTTP ${res.status}`);
}

function hasDeclaredError(res: Response, body: Record<string, unknown>): boolean {
  // خطأ HTTP معلن = جسم فيه error (4xx/5xx بجسم error) → نهائي
  return res.status >= 400 && (typeof body.error === "string" || res.status >= 400);
}

/** استعلام حالة مهمة الدمج */
export async function getMergeJob(jobId: string): Promise<MergerJob> {
  const res = await mergerFetch(`${MERGER_BASE}/api/jobs/${encodeURIComponent(jobId)}`, {
    method: "GET",
    timeoutMs: 20000,
  });
  const body = await readBody(res);
  if (res.status === 404) {
    throw new MergerHttpError(404, "مهمة الدمج غير موجودة في الخدمة (حُذفت أو انتهت صلاحيتها بعد 24 ساعة)");
  }
  if (res.status >= 400) {
    throw new MergerHttpError(res.status, String(body.error ?? `HTTP ${res.status}`));
  }
  body.jobId = body.jobId ?? jobId;
  return parseJob(body);
}

/** حذف مهمة من خدمة الدمج (تنظيف اختياري) */
export async function deleteMergeJob(jobId: string): Promise<void> {
  try {
    await mergerFetch(`${MERGER_BASE}/api/jobs/${encodeURIComponent(jobId)}`, { method: "DELETE", timeoutMs: 15000 });
  } catch { /* التنظيف اختياري — لا نرمي هنا */ }
}
