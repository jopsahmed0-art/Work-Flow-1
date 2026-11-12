/**
 * منسّق التوليد — يدير المهام من الإنشاء حتى النتيجة مع التبديل التسلسلي الصامت للمفاتيح.
 *
 * القواعد الذهبية المنفَّذة هنا:
 *  - ترتيب المفاتيح تسلسلي صارم بترتيب الإضافة (created_at ASC, id ASC) — ليس round-robin.
 *  - عند أي خطأ مفتاح/رصيد: استئناف نفس المهمة بنفس task_id على المفتاح التالي فورًا.
 *  - مهمة فشلت على كل المفاتيح تبقى processing وتُعاد محاولتها مع كل get_task (تهدئة ~45 ثانية).
 *  - نموذج الذكاء الاصطناعي لا يرى أبدًا رسائل مفاتيح/رصيد — التبديل صامت من وجهة نظره.
 *  - فشل معطيات (params) يوقف كل شيء فورًا لأن تبديل المفاتيح لن يحلّه.
 */
import {
  getTask, updateTask, insertTask, getKey, updateKey,
  type AttemptRecord, type TaskRow, type TaskType,
} from "./turso";
import { getKeyPool, classifyProviderError } from "./keys";
import { findModel, type ModelDef, type ProviderId } from "./models";
import { isProviderError, type ProviderAdapter, type KeyMeta } from "./providers/types";
import { adapterFor } from "./providers/registry";
import {
  mergerConfigured, createMergeJob, processMergeJob, getMergeJob, MergerHttpError,
} from "./merger";

/** بيانات المزود المخصص من صف المفتاح — تُمرَّر للمهايئ مع كل نداء */
function keyMeta(k: { base_url?: string | null; dialect?: string | null; model_override?: string | null }): KeyMeta {
  return {
    baseUrl: k.base_url || undefined,
    dialect: k.dialect || undefined,
    modelOverride: k.model_override || undefined,
  };
}

const POLL_INTERVAL_MS = 3000;   // استعلام كل 3 ثوانٍ أثناء نافذة الانتظار
const RESUME_COOLDOWN_MS = 45_000; // تهدئة إعادة المحاولة عبر get_task
const RESUME_WINDOW_MS = 15_000;   // نافذة قصيرة عند الاستئناف عبر get_task (لن نُعلّق العميل طويلًا)

/** نمط رسائل مشكلات مفتاح/رصيد في منتصف المهمة (يستدعي التبديل الصامت) */
const KEY_BALANCE_PATTERN = /insufficient|balance|credit|quota|402|401|unauthorized|authentication/i;

/** أخطاء مزود عابرة (5xx مكافئ) — تُعاد المحاولة تلقائيًا بدل الفشل النهائي */
const TRANSIENT_FAIL_PATTERN = /internal error|internal server error|server error|service unavailable|server busy|temporarily|try again|please retry|timed?\s?out/i;

export interface NotifyFn {
  (p: { progress: number; total: number; message: string }): Promise<void>;
}

type GenParams = {
  prompt?: string;
  aspect_ratio?: string;
  resolution?: string;
  background?: string;
  output_format?: string;
  image_url?: string;
  enable_audio?: boolean;
  duration?: number;
  wait_seconds?: number;
};

type PollOutcome =
  | { kind: "completed" }
  | { kind: "failed-final" }
  | { kind: "key-failure" }
  | { kind: "timeout" };

function nowIso(): string {
  return new Date().toISOString();
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

/** قفل في الذاكرة لمنع ازدواج إعادة المحاولة/تنفيذ process بين نداءات متزامنة (لكل نسخة serverless) */
const g = globalThis as unknown as {
  __resumeInFlight?: Set<string>;
  __processInFlight?: Set<string>;
};
const resumeInFlight = g.__resumeInFlight ?? (g.__resumeInFlight = new Set<string>());
const processInFlight = g.__processInFlight ?? (g.__processInFlight = new Set<string>());

/** تحويل خطأ غير معروف إلى تصنيف + رسالة */
function classifyUnknown(e: unknown): { cls: ReturnType<typeof classifyProviderError>; msg: string } {
  if (isProviderError(e)) {
    const cls = classifyProviderError(e.status, e.message, e.bodyCode);
    return { cls, msg: e.message };
  }
  const msg = e instanceof Error ? e.message : String(e);
  return { cls: "temporary" as const, msg };
}

async function recordAttempt(taskId: string, rec: AttemptRecord): Promise<void> {
  await updateTask(taskId, { new_attempt: rec });
}

async function markKey(keyId: string, label: string, cls: string, msg: string, ok: boolean): Promise<void> {
  await updateKey(keyId, {
    fail_delta: ok ? 0 : 1,
    success_delta: 0,
    usage_delta: 0,
    last_error: ok ? undefined : msg,
    last_checked_at: nowIso(),
    // التعطيل الآلي للمفتاح المرفوض فقط — المستنزف يبقى exhausted ويعاد تجريبه لاحقًا (قد يشحن رصيده)
    status: cls === "disabled" ? "disabled" : cls === "exhausted" ? "exhausted" : undefined,
  });
  void label;
}

/** بناء معطيات الإدخال المرسلة للمزود (بدون حقول داخلية) */
function buildProviderInput(type: TaskType, params: GenParams): Record<string, unknown> {
  if (type === "image") {
    return {
      prompt: params.prompt ?? "",
      aspect_ratio: params.aspect_ratio ?? "auto",
      resolution: params.resolution ?? "1K",
      background: params.background ?? "auto",
      output_format: params.output_format ?? "png",
    };
  }
  return {
    prompt: params.prompt ?? "",
    image_url: params.image_url,
    aspect_ratio: params.aspect_ratio ?? "auto",
    resolution: params.resolution ?? "480p",
    enable_audio: params.enable_audio ?? true,
    duration: params.duration ?? 8,
  };
}

/** تقدير تقدم مرئي: نفضل نسبة المزود إن وُجدت وإلا تقدير زمني هادئ 10..95 */
function estimateProgress(elapsedMs: number, windowMs: number, providerProgress?: number): number {
  const timeBased = 10 + Math.min(85, Math.floor((elapsedMs / Math.max(1, windowMs)) * 85));
  const p = providerProgress !== undefined && providerProgress > 0 ? providerProgress : timeBased;
  return Math.max(5, Math.min(95, Math.round(p)));
}

/**
 * نافذة استعلام المهمة لدى المزود مع بث تقدم كل ~3 ثوانٍ.
 * النتائج: اكتمال / فشل نهائي / فشل مفتاح (→ استئناف على التالي) / انتهاء النافذة.
 */
async function pollWindow(
  taskId: string,
  provider: ProviderId,
  keyId: string,
  keyLabel: string,
  apiKey: string,
  providerTaskId: string,
  deadlineMs: number,
  notify?: NotifyFn,
  meta?: KeyMeta
): Promise<PollOutcome> {
  const adapter = adapterFor(provider, meta);
  if (!adapter) return { kind: "key-failure" };
  const started = Date.now();
  let lastNotifiedProgress = -1;

  while (Date.now() < deadlineMs) {
    await sleep(POLL_INTERVAL_MS);
    let check: Awaited<ReturnType<ProviderAdapter["checkTask"]>>;
    try {
      check = await adapter.checkTask(apiKey, providerTaskId);
    } catch (e) {
      const { cls, msg } = classifyUnknown(e);
      if (cls === "disabled" || cls === "exhausted") {
        // المفتاح مرفوض أو مستنزف أثناء المتابعة → تبديل صامت للمفتاح التالي
        await markKey(keyId, keyLabel, cls, msg, false);
        await recordAttempt(taskId, { provider, keyId, keyLabel, ok: false, errorClass: cls, error: msg, at: nowIso() });
        await updateKey(keyId, { usage_delta: 1 });
        return { kind: "key-failure" };
      }
      if (cls === "provider") {
        // المزود لم يعد يخدم هذا الموديل → انتقل للمفتاح/المزود التالي
        await recordAttempt(taskId, { provider, keyId, keyLabel, ok: false, errorClass: cls, error: msg, at: nowIso() });
        await updateKey(keyId, { fail_delta: 1, last_error: msg, last_checked_at: nowIso() });
        return { kind: "key-failure" };
      }
      if (cls === "params") {
        await updateTask(taskId, { status: "failed", error_message: `معطيات الطلب غير مقبولة — ${msg}` });
        return { kind: "failed-final" };
      }
      // temporary (429/شبكة/مهلة) → نبقى نستعلم حتى انتهاء النافذة والمفتاح يبقى سليمًا
      continue;
    }

    if (check.status === "completed" && check.urls?.length) {
      await updateTask(taskId, { status: "completed", progress: 100, result_urls: check.urls, error_message: null });
      await updateKey(keyId, { success_delta: 1, last_checked_at: nowIso() });
      return { kind: "completed" };
    }
    if (check.status === "failed") {
      const msg = check.error ?? "فشل غير معروف لدى المزود";
      if (KEY_BALANCE_PATTERN.test(msg)) {
        // فشل منتصف المهمة بنمط مفتاح/رصيد → استئناف نفس المهمة على المفتاح التالي
        const cls = classifyProviderError(undefined, msg);
        await markKey(keyId, keyLabel, cls, msg, false);
        await recordAttempt(taskId, { provider, keyId, keyLabel, ok: false, errorClass: cls, error: msg, at: nowIso() });
        return { kind: "key-failure" };
      }
      if (TRANSIENT_FAIL_PATTERN.test(msg)) {
        // خطأ مزود عابر (مثل Internal Error) → إعادة إنشاء نفس المهمة بنفس task_id على المفتاح التالي/المحاولة القادمة
        await recordAttempt(taskId, { provider, keyId, keyLabel, ok: false, errorClass: "temporary", error: msg, at: nowIso() });
        return { kind: "key-failure" };
      }
      // فشل حقيقي (انتهاك سياسة/معطيات/محتوى) → نهائي
      await updateTask(taskId, { status: "failed", error_message: msg });
      return { kind: "failed-final" };
    }

    // جارية — بث تقدم
    const progress = estimateProgress(Date.now() - started, Math.max(1, deadlineMs - started), check.progress);
    if (progress !== lastNotifiedProgress) {
      lastNotifiedProgress = progress;
      await updateTask(taskId, { progress });
      await notify?.({ progress, total: 100, message: `قيد التوليد… ${progress}%` });
    }
  }
  return { kind: "timeout" };
}

/**
 * جوهر التشغيل: تجريب مسبحة المفاتيح بالترتيب الصارم لإنشاء نفس المهمة (نفس task_id)
 * ثم متابعة النافذة. تُستخدم من runGeneration (بداية 0) ومن الاستئناف عبر get_task.
 */
async function attemptPool(
  taskId: string,
  type: TaskType,
  model: ModelDef,
  params: GenParams,
  windowMs: number,
  startFromKeyIndex: number,
  notify?: NotifyFn
): Promise<TaskRow> {
  // مسبحة المفاتيح: نحتفظ فقط بالمفاتيح التي لها مهايئ مسجّل (تتسع تلقائيًا مع كل مزود جديد)
  const pool = (await getKeyPool(model.providers)).filter((k) => !!adapterFor(k.provider, keyMeta(k)));
  const deadlineMs = Date.now() + windowMs;

  await updateTask(taskId, { status: "processing", progress: 5 });

  for (let i = Math.max(0, startFromKeyIndex); i < pool.length; i++) {
    const key = pool[i];
    const provider = key.provider as ProviderId;
    const adapter = adapterFor(provider, keyMeta(key));
    if (!adapter) continue;
    // تجاوز الموديل على مستوى المفتاح له الأولوية (يلزم للمزودات المخصصة)
    const providerModel = key.model_override?.trim() || model.providerModel[provider] || model.canonical;
    const meta = keyMeta(key);

    // محاولة الإنشاء لدى المزود — كل محاولة تُسجَّل مع عدّادات المفتاح دائمًا
    await updateKey(key.id, { usage_delta: 1, last_used_at: nowIso() });
    let providerTaskId = "";
    let syncUrls: string[] | null = null;
    try {
      if (type === "image" && adapter.createImageSync) {
        // مزود يدعم صورًا متزامنة (CometAPI والمزود المخصص) — النتيجة فورًا
        syncUrls = (await adapter.createImageSync(key.api_key, providerModel, buildProviderInput(type, params), meta)).urls;
        providerTaskId = "sync";
      } else {
        providerTaskId = (await adapter.createTask(key.api_key, providerModel, buildProviderInput(type, params), meta)).providerTaskId;
      }
    } catch (e) {
      const { cls, msg } = classifyUnknown(e);
      await markKey(key.id, key.label ?? "", cls, msg, false);
      await recordAttempt(taskId, { provider, keyId: key.id, keyLabel: key.label ?? "", ok: false, errorClass: cls, error: msg, at: nowIso() });
      if (cls === "params") {
        // توقف فورًا — تبديل المفاتيح لن يحل خطأ معطيات
        await updateTask(taskId, { status: "failed", error_message: `معطيات الطلب غير مقبولة — ${msg}` });
        return (await getTask(taskId)) as TaskRow;
      }
      // disabled/exhausted/provider/temporary → انتقل للمفتاح التالي فورًا
      continue;
    }

    // نجح الإنشاء — اربط المهمة بالمزود والمفتاح
    await recordAttempt(taskId, { provider, keyId: key.id, keyLabel: key.label ?? "", ok: true, at: nowIso() });
    await updateTask(taskId, { provider, provider_task_id: providerTaskId, key_id: key.id, status: "processing", progress: 10 });

    if (syncUrls) {
      await updateTask(taskId, { status: "completed", progress: 100, result_urls: syncUrls });
      return (await getTask(taskId)) as TaskRow;
    }

    const outcome = await pollWindow(taskId, provider, key.id, key.label ?? "", key.api_key, providerTaskId, deadlineMs, notify, meta);
    if (outcome.kind === "completed" || outcome.kind === "failed-final" || outcome.kind === "timeout") {
      return (await getTask(taskId)) as TaskRow;
    }
    // key-failure → استئناف نفس المهمة بنفس task_id على المفتاح التالي (الحلقة تكمل تلقائيًا)
  }

  // فشل الإنشاء على كل المفاتيح → المهمة تبقى processing (وليست failed): بانتظار مفتاح صالح،
  // وتُعاد المحاولة تلقائيًا مع كل get_task بعد تهدئة — رسائل المفاتيح لا تخرج للعميل إطلاقًا.
  await updateTask(taskId, { status: "processing", progress: 5 });
  return (await getTask(taskId)) as TaskRow;
}

/** إنشاء مهمة توليد جديدة (تُسجَّل في Turso قبل أي نداء خارجي) */
export async function runGeneration(opts: {
  type: "image" | "video";
  model: ModelDef;
  params: GenParams;
  waitSeconds: number;
  notify?: NotifyFn;
}): Promise<TaskRow> {
  const taskId = crypto.randomUUID();
  await insertTask({
    id: taskId,
    type: opts.type,
    model: opts.model.canonical,
    prompt: opts.params.prompt ?? "",
    params: { ...opts.params, wait_seconds: opts.waitSeconds },
    status: "pending",
  });
  return attemptPool(taskId, opts.type, opts.model, opts.params, opts.waitSeconds * 1000, 0, opts.notify);
}

/**
 * استئناف مهمة قائمة بنفس task_id على المفتاح التالي (يُستخدم عند فشل مفتاح/رصيد في منتصف المهمة،
 * أو عند إعادة المحاولة التلقائية عبر get_task بعد التهدئة).
 */
async function resumeTask(task: TaskRow, notify?: NotifyFn): Promise<TaskRow> {
  const model = findModel(task.model);
  if (!model) {
    await updateTask(task.id, { status: "failed", error_message: "الموديل غير معروف في سجل الموديلات الحالي" });
    return (await getTask(task.id)) as TaskRow;
  }
  if (resumeInFlight.has(task.id)) return task; // قفل ضد النداءات المتزامنة
  resumeInFlight.add(task.id);
  try {
    const pool = await getKeyPool(model.providers);
    const lastIdx = pool.findIndex((k) => k.id === task.key_id);
    // إن عُطل آخر مفتاح فسيُستبعد من المسبحة (disabled) — لذا نبدأ من عنصر يلي موقع الأخير إن وُجد
    let start = lastIdx >= 0 ? lastIdx + 1 : 0;
    if (start >= pool.length) start = 0; // حلقة جديدة كاملة (قد يكفي: المفتاح المستنزف قد يكون أُعيد تنشيطه)
    const params = safeParseParams(task.params_json);
    // نافذة قصيرة عند الاستئناف عبر get_task حتى لا نُعلّق العميل طويلًا — الباقي تابعه بالنداءات التالية
    return await attemptPool(task.id, task.type as "image" | "video", model, params, RESUME_WINDOW_MS, start, notify);
  } finally {
    resumeInFlight.delete(task.id);
  }
}

function safeParseParams(json: string): GenParams {
  try { return JSON.parse(json) as GenParams; } catch { return {}; }
}

/** إعادة المحاولة إن انتهت التهدئة (45 ثانية منذ آخر تحديث) */
function cooldownElapsed(task: TaskRow): boolean {
  const t = new Date(String(task.updated_at).replace(" ", "T") + "Z").getTime();
  if (Number.isNaN(t)) return true;
  return Date.now() - t >= RESUME_COOLDOWN_MS;
}

/**
 * refreshTask — يستخدمه get_task: يحدّث المهمة الجارية حية من المزود/خدمة الدمج
 * مع نفس منطق إعادة المحاولة/التبديل، ثم يعيد الصف المحدث.
 */
export async function refreshTask(taskId: string, notify?: NotifyFn): Promise<TaskRow | null> {
  let task = await getTask(taskId);
  if (!task) return null;
  if (task.status === "completed" || task.status === "failed") return task;

  if (task.type === "merge") return refreshMergeTask(task, notify);

  // جارية ومربوطة بمهمة مزود → استعلام واحد سريع
  if (task.provider_task_id && task.provider && task.provider !== "merger") {
    const provider = task.provider as ProviderId;
    const key = task.key_id ? await getKey(task.key_id) : null;
    const adapter = key ? adapterFor(provider, keyMeta(key)) : null;
    if (adapter && key && key.status !== "disabled") {
      try {
        const check = await adapter.checkTask(key.api_key, task.provider_task_id, keyMeta(key));
        if (check.status === "completed" && check.urls?.length) {
          await updateTask(task.id, { status: "completed", progress: 100, result_urls: check.urls, error_message: null });
        } else if (check.status === "failed") {
          const msg = check.error ?? "فشل غير معروف لدى المزود";
          if (KEY_BALANCE_PATTERN.test(msg)) {
            await updateKey(key.id, {
              fail_delta: 1,
              last_error: msg,
              last_checked_at: nowIso(),
              status: /401|unauthorized|authentication/i.test(msg) ? "disabled" : "exhausted",
            });
            await recordAttempt(task.id, { provider, keyId: key.id, keyLabel: key.label ?? "", ok: false, errorClass: "exhausted", error: msg, at: nowIso() });
            task = await resumeTask(await getTask(task.id) as TaskRow, notify);
          } else if (TRANSIENT_FAIL_PATTERN.test(msg)) {
            // خطأ عابر → إعادة المحاولة عبر الاستئناف (نفس task_id)
            await recordAttempt(task.id, { provider, keyId: key.id, keyLabel: key.label ?? "", ok: false, errorClass: "temporary", error: msg, at: nowIso() });
            task = await resumeTask(await getTask(task.id) as TaskRow, notify);
          } else {
            await updateTask(task.id, { status: "failed", error_message: msg });
          }
        } else {
          if (check.progress !== undefined) await updateTask(task.id, { progress: check.progress });
        }
      } catch (e) {
        const { cls, msg } = classifyUnknown(e);
        if (cls === "disabled" || cls === "exhausted" || cls === "provider") {
          await markKey(key.id, key.label ?? "", cls, msg, false);
          await recordAttempt(task.id, { provider, keyId: key.id, keyLabel: key.label ?? "", ok: false, errorClass: cls, error: msg, at: nowIso() });
          task = await resumeTask(await getTask(task.id) as TaskRow, notify);
        }
        // temporary → لا شيء؛ النداء القادم سيعيد الاستعلام
      }
    }
    return await getTask(task.id);
  }

  // بلا مهمة مزود (فشلت كل المفاتيح سابقًا) → أعد المحاولة بعد التهدئة
  if (!task.provider_task_id && cooldownElapsed(task)) {
    return await resumeTask(task, notify);
  }
  return task;
}

/* ==================== الدمج ==================== */

const PUBLIC_URL_RE = /^https?:\/\/[^\s]+$/i;
const PRIVATE_HOST_RE = /^(localhost|127\.|0\.|10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.|::1|\[::1\]|.*\.local)$/i;

/** تدفق runMerge وقواعده — انظر قسم 7 من المواصفة */
export async function runMerge(opts: {
  urls?: string[];
  taskIds?: string[];
  waitSeconds: number;
  notify?: NotifyFn;
}): Promise<{ reply: string; isError?: boolean; task?: TaskRow }> {
  if (!mergerConfigured()) {
    return { reply: "❌ خدمة الدمج غير مضبوطة بعد — اضبط MERGER_API_BASE على رابط خدمة الدمج المنشورة ثم أعد المحاولة.", isError: true };
  }

  // 1) حل روابط task_ids أولًا (بالترتيب) — مكتملة فيديو فقط
  const details: string[] = [];
  const resolvedUrls: string[] = [];
  for (const tid of opts.taskIds ?? []) {
    const t = await getTask(String(tid).trim());
    const urls = t && t.status === "completed" && t.type === "video" ? safeUrls(t.result_urls_json) : [];
    if (urls.length) {
      resolvedUrls.push(urls[0]);
    } else {
      details.push(`- ${tid}: ${!t ? "غير موجودة" : t.status !== "completed" ? `حالتها ${t.status}` : t.type !== "video" ? `نوعها ${t.type}` : "بلا روابط"}`);
    }
  }
  const direct = (opts.urls ?? []).map((u) => String(u).trim());
  const combined = [...resolvedUrls, ...direct]; // روابط task_ids أولًا ثم urls المباشرة بنفس ترتيبها

  // 2) تحقق صارم
  if (combined.length < 2) {
    return {
      reply: "❌ الدمج يحتاج مقطعَين على الأقل. مرّر urls (روابط مباشرة) أو task_ids لمهام مكتملة."
        + (details.length ? `\n\nتفاصيل المعرّفات غير الصالحة:\n${details.join("\n")}` : ""),
      isError: true,
    };
  }
  if (combined.length > 10) {
    return { reply: "❌ أقصى عدد مقاطع للدمج هو 10 (خدمة الدمج تقبل 10 مقاطع كحد أقصى).", isError: true };
  }
  const bad = combined.filter((u) => !PUBLIC_URL_RE.test(u) || PRIVATE_HOST_RE.test(safeHost(u)));
  if (bad.length) {
    return {
      reply: `❌ كل المقاطع يجب أن تكون روابط http/https مباشرة وعامة. روابط غير صالحة:\n${bad.map((u) => `- ${u}`).join("\n")}`,
      isError: true,
    };
  }

  // 3) سجّل مهمة الدمج في Turso أولًا
  const taskId = crypto.randomUUID();
  await insertTask({
    id: taskId, type: "merge", model: "video-merger",
    prompt: `دمج ${combined.length} مقاطع`, params: { urls: combined, task_ids: opts.taskIds ?? [] }, status: "pending",
  });
  await updateTask(taskId, { provider: "merger", status: "processing", progress: 5 });

  // 4) أنشئ مهمة لدى الخدمة ثم أطلق process خلفيًا وبمرة واحدة فقط
  try {
    const { jobId } = await createMergeJob(combined);
    await updateTask(taskId, { provider_task_id: jobId });
    fireProcess(jobId, taskId);
  } catch (e) {
    if (e instanceof MergerHttpError) {
      // خطأ HTTP معلن من الخدمة = فشل نهائي فوري
      await updateTask(taskId, { status: "failed", error_message: `خطأ نهائي من خدمة الدمج — ${e.message}` });
    } else {
      // خطأ شبكة مؤقت — تبقى processing وتُنشأ/تُنفَّذ عند أول get_task
    }
    const task = (await getTask(taskId)) as TaskRow;
    return { reply: formatTaskReply(task), task, isError: task.status === "failed" };
  }

  // 5) نافذة استعلام مع بث تقدم — كل تحديث يُكتب في Turso فورًا
  const deadline = Date.now() + opts.waitSeconds * 1000;
  while (Date.now() < deadline) {
    await sleep(POLL_INTERVAL_MS);
    const job = await getTask(taskId);
    if (!job) break;
    if (job.status === "completed" || job.status === "failed") break;
    try {
      const st = await getMergeJob(String(job.provider_task_id));
      await updateTask(taskId, { progress: Math.max(10, st.progress) });
      await opts.notify?.({ progress: Math.max(10, st.progress), total: 100, message: `قيد الدمج… ${Math.max(10, st.progress)}%` });
      if (st.status === "done" && st.videoUrl) {
        await updateTask(taskId, { status: "completed", progress: 100, result_urls: [st.videoUrl], error_message: null });
        break;
      }
      if (st.status === "failed") {
        await updateTask(taskId, { status: "failed", error_message: `${st.error ?? "خطأ من خدمة الدمج"}` });
        break; // فشل حتمي — لا إعادة محاولة
      }
    } catch (e) {
      if (e instanceof MergerHttpError) {
        await updateTask(taskId, { status: "failed", error_message: e.message });
        break;
      }
      // خطأ شبكتنا → مؤقت: استمر بالاستعلام حتى انتهاء النافذة
    }
  }
  const task = (await getTask(taskId)) as TaskRow;
  return { reply: formatTaskReply(task), task, isError: task.status === "failed" };
}

export function safeUrls(json: string | null): string[] {
  try { const a = JSON.parse(json ?? "[]"); return Array.isArray(a) ? a.map(String) : []; } catch { return []; }
}
function safeHost(url: string): string {
  try { return new URL(url).hostname.toLowerCase(); } catch { return "invalid"; }
}

/** إطلاق process مرة واحدة لكل jobId (قفل في الذاكرة + منع تكرار النجاح السابق) */
function fireProcess(jobId: string, taskId: string): void {
  if (processInFlight.has(jobId)) return;
  processInFlight.add(jobId);
  void (async () => {
    try {
      await processMergeJob(jobId);
    } catch (e) {
      if (e instanceof MergerHttpError) {
        // خطأ HTTP معلن من الخدمة = فشل نهائي فوري — لا إعادة محاولة
        await updateTask(taskId, { status: "failed", error_message: e.message });
      }
      // خطأ شبكتنا → مؤقت؛ get_task القادم سيكرر التنفيذ لأن القفل تحرر
    } finally {
      processInFlight.delete(jobId);
    }
  })();
}

/** refreshMergeTask — get_task لمهمة دمج */
async function refreshMergeTask(task: TaskRow, notify?: NotifyFn): Promise<TaskRow> {
  if (!mergerConfigured()) {
    await updateTask(task.id, { status: "failed", error_message: "خدمة الدمج غير مضبوطة (MERGER_API_BASE)" });
    return (await getTask(task.id)) as TaskRow;
  }
  const jobId = task.provider_task_id;
  if (!jobId) {
    // لم تُنشأ مهمة الخدمة بعد (فشل مؤقت سابق) → أنشئها الآن ثم أطلق process
    const params = safeParseParams(task.params_json) as unknown as { urls?: string[] };
    const urls = params.urls ?? [];
    if (urls.length < 2) {
      await updateTask(task.id, { status: "failed", error_message: "لا توجد روابط دمج محفوظة" });
      return (await getTask(task.id)) as TaskRow;
    }
    try {
      const { jobId: j } = await createMergeJob(urls);
      await updateTask(task.id, { provider_task_id: j });
      fireProcess(j, task.id);
    } catch (e) {
      if (e instanceof MergerHttpError) {
        await updateTask(task.id, { status: "failed", error_message: e.message });
      }
      // مؤقت → النداء القادم يعيد المحاولة بعد التهدئة
    }
    return (await getTask(task.id)) as TaskRow;
  }

  try {
    const st = await getMergeJob(jobId);
    if (st.status === "done" && st.videoUrl) {
      await updateTask(task.id, { status: "completed", progress: 100, result_urls: [st.videoUrl], error_message: null });
      return (await getTask(task.id)) as TaskRow;
    }
    if (st.status === "failed") {
      await updateTask(task.id, { status: "failed", error_message: `${st.error ?? "خطأ من خدمة الدمج"}` });
      return (await getTask(task.id)) as TaskRow;
    }
    // processing: إن لم يُنفَّذ process بعد فنفّذه الآن (بحماية القفل)
    if (st.status === "processing" && st.progress <= 0) fireProcess(jobId, task.id);
    await updateTask(task.id, { progress: Math.max(10, st.progress) });
    await notify?.({ progress: Math.max(10, st.progress), total: 100, message: `قيد الدمج… ${Math.max(10, st.progress)}%` });
  } catch (e) {
    if (e instanceof MergerHttpError) {
      // 404 → فشل نهائي برسالة عربية محددة (مهمة حُذفت أو انتهت صلاحيتها)
      await updateTask(task.id, { status: "failed", error_message: e.message });
    }
    // خطأ شبكتنا → مؤقت؛ لا نغيّر الحالة
  }
  return (await getTask(task.id)) as TaskRow;
}

/* ==================== الصياغة العربية ==================== */

/** صياغة عربية جاهزة للعرض لعميل MCP — لا تذكر المفاتيح أو الرصيد إطلاقًا */
export function formatTaskReply(task: TaskRow): string {
  const urls = safeUrls(task.result_urls_json);
  if (task.status === "completed" && urls.length) {
    if (task.type === "image") {
      return `✅ تم توليد الصورة بنجاح\n\n![image](${urls[0]})\n\nالرابط المباشر: ${urls[0]}`;
    }
    if (task.type === "video") {
      const list = urls.length === 1 ? urls[0] : urls.map((u) => `- ${u}`).join("\n");
      return `✅ تم توليد الفيديو بنجاح\n\nالرابط المباشر: ${list}`;
    }
    // merge
    return `✅ تم دمج المقاطع بنجاح\n\nالرابط المباشر: ${urls[0]}\n\n⚠️ ملف الدمج يُحذف من خدمة الدمج بعد ~24 ساعة — شاهده/نزّله سريعًا.`;
  }
  if (task.status === "failed") {
    return `❌ فشلت المهمة: ${task.error_message ?? "سبب غير معروف"}`;
  }
  const pct = task.progress && task.progress > 0 ? ` (${task.progress}%)` : "";
  return `⏳ المهمة قيد المعالجة${pct} — task_id: ${task.id}\n\nتابع بـ get_task كل ~10 ثوانٍ حتى تكتمل.`;
}

/** إرسال إشعارات التقدم أثناء نافذة الانتظار (إن زوّد العميل الطلب بـ progressToken) */
export async function sendProgress(
  notify: NotifyFn | undefined,
  progress: number,
  message: string
): Promise<void> {
  if (!notify) return;
  try { await notify({ progress, total: 100, message }); } catch { /* الإشعار اختياري */ }
}
