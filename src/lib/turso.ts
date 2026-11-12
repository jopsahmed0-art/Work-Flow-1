/**
 * طبقة قاعدة البيانات — Turso (libSQL) عبر HTTP فقط.
 * قرار معماري: لا ملفات SQLite محلية إطلاقًا للتوافق مع Vercel (serverless).
 * المخطط يُنشأ تلقائيًا عند أول وصول (CREATE TABLE IF NOT EXISTS) فلا حاجة لأداة migrations.
 */
import { createClient, type Client, type InValue } from "@libsql/client";

let _client: Client | null = null;

/** عميل واحد مشترك لكل العملية (يعاد بناؤه فقط إن تغيّرت المتغيرات أو انقطع) */
export function getTurso(): Client {
  if (_client) return _client;
  const url = process.env.TURSO_DATABASE_URL;
  const token = process.env.TURSO_AUTH_TOKEN;
  if (!url || !token) {
    throw new Error("TURSO_DATABASE_URL و TURSO_AUTH_TOKEN مطلوبان في متغيرات البيئة");
  }
  _client = createClient({ url, authToken: token });
  return _client;
}

let _schemaReady: Promise<void> | null = null;

/** ينشئ الجداول عند أول وصول فقط (يُخزَّن الوعد لتجنب تكرار الاستعلام بين الطلبات) */
export function ensureSchema(): Promise<void> {
  if (!_schemaReady) {
    _schemaReady = (async () => {
      const db = getTurso();
      await db.execute(`CREATE TABLE IF NOT EXISTS tasks (
        id TEXT PRIMARY KEY,
        provider TEXT,
        provider_task_id TEXT,
        key_id TEXT,
        model TEXT NOT NULL,
        type TEXT NOT NULL,
        prompt TEXT DEFAULT '',
        params_json TEXT DEFAULT '{}',
        status TEXT NOT NULL,
        progress INTEGER DEFAULT 0,
        result_urls_json TEXT,
        error_message TEXT,
        attempts_json TEXT DEFAULT '[]',
        created_at TEXT DEFAULT (datetime('now')),
        updated_at TEXT DEFAULT (datetime('now')),
        completed_at TEXT
      )`);
      await db.execute(`CREATE TABLE IF NOT EXISTS api_keys (
        id TEXT PRIMARY KEY,
        provider TEXT NOT NULL,
        label TEXT DEFAULT '',
        api_key TEXT NOT NULL,
        status TEXT DEFAULT 'active',
        usage_count INTEGER DEFAULT 0,
        success_count INTEGER DEFAULT 0,
        fail_count INTEGER DEFAULT 0,
        last_used_at TEXT,
        last_checked_at TEXT,
        last_error TEXT,
        created_at TEXT DEFAULT (datetime('now'))
      )`);
      // فهارس مساعدة بسيطة لترتيب القوائم
      await db.execute(`CREATE INDEX IF NOT EXISTS idx_tasks_created ON tasks(created_at DESC)`);
      await db.execute(`CREATE INDEX IF NOT EXISTS idx_keys_created ON api_keys(created_at ASC)`);
    })().catch((e) => { _schemaReady = null; throw e; });
  }
  return _schemaReady;
}

/** فحص جهوزية قاعدة البيانات: SELECT 1 */
export async function dbHealthy(): Promise<boolean> {
  try {
    await ensureSchema();
    const r = await getTurso().execute("SELECT 1 AS ok");
    return r.rows[0]?.ok === 1;
  } catch {
    return false;
  }
}

/* ============ أنواع الصفوف ============ */

export type TaskType = "image" | "video" | "merge";
export type TaskStatus = "pending" | "processing" | "completed" | "failed";

export interface AttemptRecord {
  provider: string;
  keyId?: string;
  keyLabel?: string;
  ok: boolean;
  errorClass?: string;
  error?: string;
  at: string;
}

export interface TaskRow {
  id: string;
  provider: string | null;
  provider_task_id: string | null;
  key_id: string | null;
  model: string;
  type: TaskType;
  prompt: string;
  params_json: string;
  status: TaskStatus;
  progress: number;
  result_urls_json: string | null;
  error_message: string | null;
  attempts_json: string;
  created_at: string;
  updated_at: string;
  completed_at: string | null;
  // حقل مشتق غير مخزّن: وقت آخر محاولة فاشلة لكل المفاتيح (لتهدئة 45 ثانية)
  next_retry_hint?: string;
}

export type KeyStatus = "active" | "exhausted" | "disabled";

export interface KeyRow {
  id: string;
  provider: string;
  label: string;
  api_key: string;
  status: KeyStatus;
  usage_count: number;
  success_count: number;
  fail_count: number;
  last_used_at: string | null;
  last_checked_at: string | null;
  last_error: string | null;
  created_at: string;
}

/* ============ عمليات المهام ============ */

function rowToTask(r: Record<string, unknown>): TaskRow {
  return r as unknown as TaskRow;
}

/** تسجيل المهمة في Turso قبل أي نداء خارجي — بقيت قابلة للتتبع حتى لو انقطع الاتصال */
export async function insertTask(t: {
  id: string; type: TaskType; model: string; prompt?: string;
  params?: Record<string, unknown>; status?: TaskStatus; provider?: string;
}): Promise<void> {
  await ensureSchema();
  await getTurso().execute({
    sql: `INSERT INTO tasks (id, type, model, prompt, params_json, status, provider, progress)
          VALUES (?, ?, ?, ?, ?, ?, ?, 0)`,
    args: [t.id, t.type, t.model, t.prompt ?? "", JSON.stringify(t.params ?? {}), t.status ?? "pending", t.provider ?? null],
  });
}

export async function getTask(id: string): Promise<TaskRow | null> {
  await ensureSchema();
  const r = await getTurso().execute({ sql: "SELECT * FROM tasks WHERE id = ?", args: [id] });
  return r.rows.length ? rowToTask(r.rows[0] as Record<string, unknown>) : null;
}

/** ترقيع جزئي للمهمة: يضيف المحاولات وضبط completed_at تلقائيًا عند الاكتمال */
export async function updateTask(
  id: string,
  patch: Partial<{
    provider: string | null; provider_task_id: string | null; key_id: string | null;
    status: TaskStatus; progress: number; result_urls: string[] | null;
    error_message: string | null; new_attempt: AttemptRecord;
  }>
): Promise<void> {
  await ensureSchema();
  const sets: string[] = [];
  const args: InValue[] = [];

  if (patch.provider !== undefined) { sets.push("provider = ?"); args.push(patch.provider); }
  if (patch.provider_task_id !== undefined) { sets.push("provider_task_id = ?"); args.push(patch.provider_task_id); }
  if (patch.key_id !== undefined) { sets.push("key_id = ?"); args.push(patch.key_id); }
  if (patch.status !== undefined) { sets.push("status = ?"); args.push(patch.status); }
  if (patch.progress !== undefined) { sets.push("progress = ?"); args.push(Math.max(0, Math.min(100, Math.round(patch.progress)))); }
  if (patch.result_urls !== undefined) {
    sets.push("result_urls_json = ?");
    args.push(patch.result_urls ? JSON.stringify(patch.result_urls) : null);
  }
  if (patch.error_message !== undefined) { sets.push("error_message = ?"); args.push(patch.error_message); }
  if (patch.new_attempt) {
    // نقرأ المحاولات الحالية ونضيف لها (الجدول حقل attempts_json نصي)
    sets.push("attempts_json = ?");
    args.push("__ATTEMPTS__");
  }
  if (patch.status === "completed") { sets.push("completed_at = datetime('now')"); }

  if (!sets.length) return;

  if (patch.new_attempt) {
    const cur = await getTurso().execute({ sql: "SELECT attempts_json FROM tasks WHERE id = ?", args: [id] });
    let list: AttemptRecord[] = [];
    try { list = JSON.parse(String(cur.rows[0]?.attempts_json ?? "[]")) as AttemptRecord[]; } catch { list = []; }
    list.push(patch.new_attempt);
    // نستبدل العلامة المؤقتة داخل args (وليس sets) — والعلامة موضوعها في args
    const idx = args.indexOf("__ATTEMPTS__");
    if (idx >= 0) args[idx] = JSON.stringify(list.slice(-50));
    else args.push(JSON.stringify(list.slice(-50)));
  }

  sets.push("updated_at = datetime('now')");
  args.push(id);
  await getTurso().execute({ sql: `UPDATE tasks SET ${sets.join(", ")} WHERE id = ?`, args });
}

export async function listRecentTasks(
  limit = 20,
  filter: { type?: string; status?: string } = {}
): Promise<TaskRow[]> {
  await ensureSchema();
  const where: string[] = [];
  const args: InValue[] = [];
  if (filter.type) { where.push("type = ?"); args.push(filter.type); }
  if (filter.status) { where.push("status = ?"); args.push(filter.status); }
  args.push(limit);
  const r = await getTurso().execute({
    sql: `SELECT * FROM tasks ${where.length ? "WHERE " + where.join(" AND ") : ""} ORDER BY created_at DESC, id DESC LIMIT ?`,
    args,
  });
  return r.rows.map((x) => rowToTask(x as Record<string, unknown>));
}

export async function taskStats(): Promise<{ total: number; completed: number; failed: number; processing: number }> {
  await ensureSchema();
  const r = await getTurso().execute(`
    SELECT
      COUNT(*) AS total,
      SUM(CASE WHEN status='completed' THEN 1 ELSE 0 END) AS completed,
      SUM(CASE WHEN status='failed' THEN 1 ELSE 0 END) AS failed,
      SUM(CASE WHEN status IN ('processing','pending') THEN 1 ELSE 0 END) AS processing
    FROM tasks`);
  const x = r.rows[0] ?? {};
  return {
    total: Number(x.total ?? 0), completed: Number(x.completed ?? 0),
    failed: Number(x.failed ?? 0), processing: Number(x.processing ?? 0),
  };
}

/* ============ عمليات المفاتيح ============ */

export async function insertKey(k: { id: string; provider: string; label: string; api_key: string }): Promise<void> {
  await ensureSchema();
  await getTurso().execute({
    sql: `INSERT INTO api_keys (id, provider, label, api_key, status, usage_count, success_count, fail_count)
          VALUES (?, ?, ?, ?, 'active', 0, 0, 0)`,
    args: [k.id, k.provider, k.label, k.api_key],
  });
}

export async function listKeys(): Promise<KeyRow[]> {
  await ensureSchema();
  const r = await getTurso().execute("SELECT * FROM api_keys ORDER BY created_at ASC, id ASC");
  return r.rows.map((x) => x as unknown as KeyRow);
}

export async function getKey(id: string): Promise<KeyRow | null> {
  await ensureSchema();
  const r = await getTurso().execute({ sql: "SELECT * FROM api_keys WHERE id = ?", args: [id] });
  return r.rows.length ? (r.rows[0] as unknown as KeyRow) : null;
}

export async function updateKey(id: string, patch: Partial<Pick<KeyRow, "status" | "last_error" | "last_used_at" | "last_checked_at">> & {
  usage_delta?: number; success_delta?: number; fail_delta?: number;
}): Promise<void> {
  await ensureSchema();
  const sets: string[] = [];
  const args: InValue[] = [];
  if (patch.status !== undefined) { sets.push("status = ?"); args.push(patch.status); }
  if (patch.last_error !== undefined) { sets.push("last_error = ?"); args.push(patch.last_error); }
  if (patch.last_used_at !== undefined) { sets.push("last_used_at = ?"); args.push(patch.last_used_at); }
  if (patch.last_checked_at !== undefined) { sets.push("last_checked_at = ?"); args.push(patch.last_checked_at); }
  if (patch.usage_delta) { sets.push("usage_count = usage_count + ?"); args.push(patch.usage_delta); }
  if (patch.success_delta) { sets.push("success_count = success_count + ?"); args.push(patch.success_delta); }
  if (patch.fail_delta) { sets.push("fail_count = fail_count + ?"); args.push(patch.fail_delta); }
  if (!sets.length) return;
  args.push(id);
  await getTurso().execute({ sql: `UPDATE api_keys SET ${sets.join(", ")} WHERE id = ?`, args });
}

export async function deleteKey(id: string): Promise<void> {
  await ensureSchema();
  await getTurso().execute({ sql: "DELETE FROM api_keys WHERE id = ?", args: [id] });
}

export async function findDuplicateKey(provider: string, apiKey: string): Promise<KeyRow | null> {
  await ensureSchema();
  const r = await getTurso().execute({
    sql: "SELECT * FROM api_keys WHERE provider = ? AND api_key = ? LIMIT 1",
    args: [provider, apiKey],
  });
  return r.rows.length ? (r.rows[0] as unknown as KeyRow) : null;
}

/** حذف مهام قديمة (تنظيف آثار الاختبار أو الصيانة) */
export async function deleteTask(id: string): Promise<void> {
  await ensureSchema();
  await getTurso().execute({ sql: "DELETE FROM tasks WHERE id = ?", args: [id] });
}
