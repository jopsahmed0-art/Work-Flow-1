/**
 * طبقة Turso: جداول jobs / sources / source_chunks / output_chunks بـ CREATE TABLE IF NOT EXISTS.
 * كل Blob يُقسَّم إلى صفوف 2MB (حد HTTP في Turso) ويُقرأ تدفقيًا بصفحات من 8 صفوف.
 * لا S3 ولا خدمات خارجية — كل شيء في Turso.
 */
const { createClient } = require("@libsql/client");
const { DB_CHUNK_BYTES, READ_PAGE_ROWS, TTL_MS } = require("./env");

let _db = null;
function db() {
  if (!_db) {
    const url = process.env.TURSO_DATABASE_URL;
    const token = process.env.TURSO_AUTH_TOKEN;
    if (!url || !token) throw new Error("TURSO_DATABASE_URL و TURSO_AUTH_TOKEN مطلوبان");
    _db = createClient({ url, authToken: token });
  }
  return _db;
}

let _schema = null;
async function ensureSchema() {
  if (_schema) return _schema;
  _schema = (async () => {
    const c = db();
    await c.execute(`CREATE TABLE IF NOT EXISTS jobs (
      id TEXT PRIMARY KEY,
      status TEXT NOT NULL DEFAULT 'queued',
      progress INTEGER NOT NULL DEFAULT 0,
      sources_total INTEGER NOT NULL DEFAULT 0,
      expected_files INTEGER NOT NULL DEFAULT 0,
      output_size INTEGER,
      output_duration REAL,
      output_resolution TEXT,
      output_mime TEXT DEFAULT 'video/mp4',
      error TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      expires_at TEXT NOT NULL
    )`);
    await c.execute(`CREATE TABLE IF NOT EXISTS sources (
      job_id TEXT NOT NULL,
      seq INTEGER NOT NULL,
      kind TEXT NOT NULL,
      url TEXT,
      name TEXT,
      mime TEXT,
      size INTEGER,
      duration REAL,
      width INTEGER,
      height INTEGER,
      has_audio INTEGER DEFAULT 0,
      PRIMARY KEY (job_id, seq)
    )`);
    await c.execute(`CREATE TABLE IF NOT EXISTS source_chunks (
      job_id TEXT NOT NULL,
      seq INTEGER NOT NULL,
      chunk INTEGER NOT NULL,
      data BLOB NOT NULL,
      PRIMARY KEY (job_id, seq, chunk)
    )`);
    await c.execute(`CREATE TABLE IF NOT EXISTS output_chunks (
      job_id TEXT NOT NULL,
      chunk INTEGER NOT NULL,
      data BLOB NOT NULL,
      PRIMARY KEY (job_id, chunk)
    )`);
    await c.execute(`CREATE INDEX IF NOT EXISTS idx_jobs_expires ON jobs(expires_at)`);
  })();
  return _schema;
}

/* ==================== المهام ==================== */

function newId() {
  // معرّف قصير قابل للقراءة (12 حرفًا) مثل معرفات الخدمة الموصوفة
  const alphabet = "abcdefghijklmnopqrstuvwxyz0123456789";
  let s = "";
  for (let i = 0; i < 12; i++) s += alphabet[Math.floor(Math.random() * alphabet.length)];
  return s;
}

async function createJob({ sources, expectedFiles }) {
  await ensureSchema();
  const id = newId();
  // expires_at = created_at + 24 ساعة
  await db().execute({
    sql: `INSERT INTO jobs (id, status, progress, sources_total, expected_files, expires_at)
          VALUES (?, ?, 0, ?, ?, datetime('now', '+24 hours'))`,
    args: [id, expectedFiles > 0 ? "uploading" : "queued", sources.length, expectedFiles],
  });
  for (let i = 0; i < sources.length; i++) {
    const s = sources[i];
    await db().execute({
      sql: `INSERT INTO sources (job_id, seq, kind, url, name, mime, size) VALUES (?, ?, ?, ?, ?, ?, ?)`,
      args: [id, i, s.kind, s.url ?? null, s.name ?? null, s.mime ?? null, s.size ?? null],
    });
  }
  return getJob(id);
}

async function getJob(id) {
  await ensureSchema();
  const r = await db().execute({ sql: "SELECT * FROM jobs WHERE id = ?", args: [id] });
  if (!r.rows.length) return null;
  const j = { ...r.rows[0] };
  const sources = await db().execute({
    sql: "SELECT seq, kind, url, name, mime, size, duration, width, height, has_audio FROM sources WHERE job_id = ? ORDER BY seq ASC",
    args: [id],
  });
  j.sources = sources.rows;
  return j;
}

async function jobExists(id) {
  const r = await db().execute({ sql: "SELECT 1 AS x FROM jobs WHERE id = ?", args: [id] });
  return r.rows.length > 0;
}

async function updateJob(id, patch) {
  const sets = [];
  const args = [];
  for (const k of ["status", "progress", "output_size", "output_duration", "output_resolution", "output_mime", "error"]) {
    if (patch[k] !== undefined) { sets.push(`${k} = ?`); args.push(patch[k]); }
  }
  if (!sets.length) return;
  args.push(id);
  await db().execute({ sql: `UPDATE jobs SET ${sets.join(", ")} WHERE id = ?`, args });
}

/** حذف شامل في batch واحد: jobs + sources + source_chunks + output_chunks */
async function deleteJob(id) {
  await ensureSchema();
  await db().batch([
    { sql: "DELETE FROM jobs WHERE id = ?", args: [id] },
    { sql: "DELETE FROM sources WHERE job_id = ?", args: [id] },
    { sql: "DELETE FROM source_chunks WHERE job_id = ?", args: [id] },
    { sql: "DELETE FROM output_chunks WHERE job_id = ?", args: [id] },
  ]);
}

/** تنظيف كسول: حذف كل المهام المنتهية — يُنفَّذ عند كل إنشاء/دمج + نقطة cron */
async function cleanupExpired() {
  await ensureSchema();
  const r = await db().execute({
    sql: "SELECT id FROM jobs WHERE expires_at <= datetime('now') LIMIT 50",
  });
  let n = 0;
  for (const row of r.rows) {
    await deleteJob(row.id);
    n++;
  }
  return n;
}

/* ==================== تخزين Blobs المقطّعة ==================== */

/** تقسيم Buffer إلى صفوف 2MB وحفظها (للمصادر المرفوعة) */
async function saveSourceChunks(jobId, seq, buf) {
  const chunks = Math.ceil(buf.length / DB_CHUNK_BYTES);
  const stmts = [];
  for (let i = 0; i < chunks; i++) {
    stmts.push({
      sql: "INSERT OR REPLACE INTO source_chunks (job_id, seq, chunk, data) VALUES (?, ?, ?, ?)",
      args: [jobId, seq, i, new Uint8Array(buf.subarray(i * DB_CHUNK_BYTES, (i + 1) * DB_CHUNK_BYTES))],
    });
  }
  // دفعات صغيرة لتجنب تجاوز حدود الطلب
  for (let i = 0; i < stmts.length; i += 4) {
    await db().batch(stmts.slice(i, i + 4));
  }
}

/** قراءة كل أجزاء مصدر وتجميعها في Buffer */
async function readSourceBlob(jobId, seq) {
  const parts = [];
  let page = 0;
  for (;;) {
    const r = await db().execute({
      sql: "SELECT chunk, data FROM source_chunks WHERE job_id = ? AND seq = ? ORDER BY chunk ASC LIMIT ? OFFSET ?",
      args: [jobId, seq, READ_PAGE_ROWS, page * READ_PAGE_ROWS],
    });
    if (!r.rows.length) break;
    for (const row of r.rows) parts.push(Buffer.from(row.data));
    if (r.rows.length < READ_PAGE_ROWS) break;
    page++;
  }
  return Buffer.concat(parts);
}

async function countSourceChunks(jobId, seq) {
  const r = await db().execute({
    sql: "SELECT COUNT(*) AS n, COALESCE(SUM(LENGTH(data)),0) AS bytes FROM source_chunks WHERE job_id = ? AND seq = ?",
    args: [jobId, seq],
  });
  return { chunks: Number(r.rows[0].n), bytes: Number(r.rows[0].bytes) };
}

/** حفظ الناتج المرمّز كصفوف 2MB */
async function saveOutputChunks(jobId, buf) {
  const chunks = Math.ceil(buf.length / DB_CHUNK_BYTES);
  for (let i = 0; i < chunks; i++) {
    await db().execute({
      sql: "INSERT OR REPLACE INTO output_chunks (job_id, chunk, data) VALUES (?, ?, ?)",
      args: [jobId, i, new Uint8Array(buf.subarray(i * DB_CHUNK_BYTES, (i + 1) * DB_CHUNK_BYTES))],
    });
  }
  return chunks;
}

/** حجم الناتج المخزّن */
async function outputBytes(jobId) {
  const r = await db().execute({
    sql: "SELECT COALESCE(SUM(LENGTH(data)),0) AS bytes, COUNT(*) AS n FROM output_chunks WHERE job_id = ?",
    args: [jobId],
  });
  return { bytes: Number(r.rows[0].bytes), chunks: Number(r.rows[0].n) };
}

/** قارئ تدفقي للناتج بصفحات 8 صفوف — يُستخدم لبث الفيديو مع Range */
async function* outputChunkIterator(jobId) {
  let page = 0;
  for (;;) {
    const r = await db().execute({
      sql: "SELECT chunk, data FROM output_chunks WHERE job_id = ? ORDER BY chunk ASC LIMIT ? OFFSET ?",
      args: [jobId, READ_PAGE_ROWS, page * READ_PAGE_ROWS],
    });
    if (!r.rows.length) return;
    for (const row of r.rows) yield Buffer.from(row.data);
    if (r.rows.length < READ_PAGE_ROWS) return;
    page++;
  }
}

/** بعد نجاح الدمج: الناتج فقط هو المطلوب — نحذف أجزاء المصادر */
async function deleteSourceChunks(jobId) {
  await db().execute({ sql: "DELETE FROM source_chunks WHERE job_id = ?", args: [jobId] });
}

module.exports = {
  db, ensureSchema, newId,
  createJob, getJob, jobExists, updateJob, deleteJob, cleanupExpired,
  saveSourceChunks, readSourceBlob, countSourceChunks,
  saveOutputChunks, outputBytes, outputChunkIterator, deleteSourceChunks,
  TTL_MS,
};
