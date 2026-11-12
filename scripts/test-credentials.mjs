// اختبار بيانات الاعتماد الحقيقية: Turso ثم إنشاء المخطط إنتاجيًا
import { createClient } from "@libsql/client";

const url = process.env.TURSO_DATABASE_URL;
const token = process.env.TURSO_AUTH_TOKEN;

if (!url || !token) { console.error("missing env"); process.exit(1); }
console.log("URL host:", url);

const db = createClient({ url, authToken: token });

const t0 = Date.now();
const r = await db.execute("SELECT 1 AS ok");
console.log("SELECT 1 =>", r.rows[0].ok, "| latency ms:", Date.now() - t0);

const schema = [
  `CREATE TABLE IF NOT EXISTS tasks (
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
  )`,
  `CREATE TABLE IF NOT EXISTS api_keys (
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
  )`,
];
for (const sql of schema) await db.execute(sql);
console.log("schema ensured");

const kc = await db.execute("SELECT COUNT(*) AS n FROM api_keys");
const tc = await db.execute("SELECT COUNT(*) AS n FROM tasks");
console.log("api_keys count:", kc.rows[0].n, "| tasks count:", tc.rows[0].n);
