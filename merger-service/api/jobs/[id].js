/**
 * GET    /api/jobs/<id> — الحالة + التقدم (0–100) + الرابط عند الاكتمال
 * DELETE /api/jobs/<id> — حذف فوري شامل (jobs + sources + source_chunks + output_chunks)
 */
const { getJob, deleteJob, outputBytes } = require("../../lib/db");
const { json, error } = require("../../lib/http");

module.exports = async (req, res) => {
  const id = req.query.id; // Vercel يضع معاملات المسار الديناميكي في req.query
  if (!id) return error(res, 400, "معرّف المهمة مطلوب");

  try {
    if (req.method === "GET") {
      const job = await getJob(id);
      if (!job) return error(res, 404, "المهمة غير موجودة (حُذفت أو انتهت صلاحيتها بعد 24 ساعة)");
      const out = {
        jobId: job.id,
        status: job.status, // queued | uploading | processing | done | failed
        progress: job.progress,
        sources: job.sources.map((s) => ({ seq: s.seq, kind: s.kind, name: s.name, url: s.url })),
        createdAt: job.created_at,
        expiresAt: job.expires_at,
      };
      if (job.status === "done") {
        out.size = job.output_size;
        out.duration = job.output_duration;
        out.resolution = job.output_resolution;
        out.videoUrl = `${baseOf(req)}/api/jobs/${job.id}/video`;
        out.downloadUrl = `${baseOf(req)}/api/jobs/${job.id}/video?download=1`;
      }
      if (job.status === "failed") out.error = job.error;
      json(res, 200, out);
      return;
    }

    if (req.method === "DELETE") {
      const job = await getJob(id);
      if (!job) return error(res, 404, "المهمة غير موجودة");
      await deleteJob(id);
      json(res, 200, { ok: true, deleted: id });
      return;
    }

    return error(res, 405, "طريقة غير مسموحة — استخدم GET أو DELETE");
  } catch (e) {
    error(res, 500, `خطأ داخلي: ${e.message}`);
  }
};

function baseOf(req) {
  const proto = req.headers["x-forwarded-proto"] || "http";
  const host = req.headers["x-forwarded-host"] || req.headers.host || "localhost:3001";
  return `${proto}://${host}`;
}
void outputBytes;
