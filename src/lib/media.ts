/**
 * تخزين الوسائط المولدة (صور محولات تعيد base64 مثل NVIDIA و Gemini) في Turso
 * وتخديمها كروابط عامة ثابتة عبر /api/media/[id].
 * القرار المعماري: base64 يُقسَّم أجزاءً ~1MB لكل صف (حد صف libSQL ~2MB) وتُعاد تجميعها عند القراءة.
 */
import { getTurso, ensureSchema } from "./turso";

const CHUNK = 1_000_000; // أحرف base64 لكل صف — أمان بعيد عن حد حجم الصف

/** الرابط العام الأساسي — Vercel يضبط VERCEL_PROJECT_PRODUCTION_URL تلقائيًا في الإنتاج */
function baseUrl(): string {
  const v = process.env.APP_BASE_URL
    || process.env.VERCEL_PROJECT_PRODUCTION_URL
    || process.env.VERCEL_URL
    || "work-flow-1-suxx.vercel.app";
  const withProto = v.startsWith("http") ? v : `https://${v}`;
  return withProto.replace(/\/+$/, "");
}

/** حفظ وسيط base64 وإعادة رابطه العام الجاهز للعرض والمشاركة */
export async function saveMedia(mime: string, dataB64: string): Promise<string> {
  await ensureSchema();
  const id = crypto.randomUUID();
  const db = getTurso();
  for (let i = 0, part = 0; i < dataB64.length; i += CHUNK, part++) {
    await db.execute({
      sql: "INSERT INTO media_files (id, part, mime, data) VALUES (?, ?, ?, ?)",
      args: [id, part, mime, dataB64.slice(i, i + CHUNK)],
    });
  }
  return `${baseUrl()}/api/media/${id}`;
}

/** تجميع وسيط من أجزائه — يُستخدم من سكة الخدمة فقط */
export async function getMedia(id: string): Promise<{ mime: string; data: string } | null> {
  await ensureSchema();
  const r = await getTurso().execute({
    sql: "SELECT mime, data FROM media_files WHERE id = ? ORDER BY part ASC",
    args: [id],
  });
  if (!r.rows.length) return null;
  return { mime: String(r.rows[0].mime), data: r.rows.map((x) => String(x.data)).join("") };
}
