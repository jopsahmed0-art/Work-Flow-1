/**
 * POST /api/upload?job=<id>&seq=<n>&chunk=<k> — رفع أجزاء الملفات (ثنائي ≤4MB، octet-stream).
 * الواجهة تعيد المحاولة ×3 تلقائيًا عند فشل أي جزء.
 */
const { UPLOAD_CHUNK_BYTES } = require("../lib/env");
const { jobExists, saveSourceChunks, getJob, updateJob } = require("../lib/db");
const { json, error } = require("../lib/http");

module.exports = async (req, res) => {
  if (req.method === "OPTIONS") { json(res, 204, {}); return; }
  if (req.method !== "POST") return error(res, 405, "طريقة غير مسموحة — استخدم POST");

  try {
    const job = String(req.query.job ?? "");
    const seq = parseInt(String(req.query.seq ?? "0"), 10);
    const chunk = parseInt(String(req.query.chunk ?? "0"), 10);
    if (!job || Number.isNaN(seq) || Number.isNaN(chunk)) {
      return error(res, 400, "معاملات job و seq و chunk مطلوبة");
    }
    if (!(await jobExists(job))) return error(res, 404, "المهمة غير موجودة");

    const body = Buffer.isBuffer(req.body) ? req.body : Buffer.from(req.body ?? []);
    if (!body.length) return error(res, 400, "الجسم فارغ — أرسل البيانات الثنائية بـ Content-Type: application/octet-stream");
    if (body.length > UPLOAD_CHUNK_BYTES) {
      return error(res, 413, `حجم الجزء يتجاوز ${Math.floor(UPLOAD_CHUNK_BYTES / 1024 / 1024)}MB`);
    }

    await saveSourceChunks(job, seq, body);
    json(res, 200, { ok: true, job, seq, chunk, bytes: body.length });
  } catch (e) {
    error(res, 500, `تعذر حفظ الجزء: ${e.message}`);
  }
};
void getJob; void updateJob;
