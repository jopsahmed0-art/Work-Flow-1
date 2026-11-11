/**
 * POST /api/jobs — إنشاء مهمة دمج.
 * يقبل {"videos":["رابط1","رابط2"]} أو
 *      {"sources":[{"kind":"url","url":...},{"kind":"file","name":...,"size":...,"mime":...}]}
 * → 201 {jobId, status:"queued"|"uploading", statusUrl, processUrl, expiresAt}
 * وإن وُجدت ملفات يرجع uploads[] برابط رفع لكل مصدر + uploadChunkBytes.
 * التنظيف الكسول للمهام المنتهية يُنفَّذ هنا أيضًا.
 */
const { LIMITS, UPLOAD_CHUNK_BYTES } = require("../lib/env");
const { createJob, cleanupExpired } = require("../lib/db");
const { json, error } = require("../lib/http");

module.exports = async (req, res) => {
  if (req.method === "OPTIONS") { json(res, 204, {}); return; }
  if (req.method !== "POST") return error(res, 405, "طريقة غير مسموحة — استخدم POST");

  try {
    await cleanupExpired(); // تنظيف كسول

    const body = typeof req.body === "object" && !Buffer.isBuffer(req.body)
      ? req.body
      : JSON.parse(Buffer.isBuffer(req.body) ? req.body.toString("utf8") : req.body || "{}");

    let sources = [];
    if (Array.isArray(body.videos) && body.videos.length) {
      sources = body.videos.map((u) => ({ kind: "url", url: String(u).trim() }));
    } else if (Array.isArray(body.sources) && body.sources.length) {
      sources = body.sources.map((s) => ({
        kind: s.kind === "file" ? "file" : "url",
        url: s.kind === "file" ? null : String(s.url ?? "").trim(),
        name: s.name ?? null,
        mime: s.mime ?? null,
        size: s.size ?? null,
      }));
    } else {
      return error(res, 400, "الجسم يجب أن يحتوي مصفوفة videos (روابط مباشرة) أو sources مع kind=url|file");
    }

    // الحدود
    if (sources.length < 2) return error(res, 400, "الدمج يحتاج مقطعين على الأقل");
    if (sources.length > LIMITS.maxSources) {
      return error(res, 400, `أقصى عدد مقاطع للدمج هو ${LIMITS.maxSources}`);
    }
    const PUBLIC_URL_RE = /^https?:\/\/[^\s]+$/i;
    for (const s of sources) {
      if (s.kind === "url") {
        if (!PUBLIC_URL_RE.test(s.url || "")) {
          return error(res, 400, "كل الروابط يجب أن تكون روابط http/https مباشرة وعامة");
        }
      } else if (s.kind === "file") {
        if (!s.name) return error(res, 400, "المصادر المرفوعة يجب أن تحمل اسم ملف");
        if ((s.size ?? 0) > LIMITS.sourceMaxMB * 1024 * 1024) {
          return error(res, 413, `حجم المصدر يتجاوز الحد (${LIMITS.sourceMaxMB}MB لكل ملف)`);
        }
      }
    }

    const expectedFiles = sources.filter((s) => s.kind === "file").length;
    const job = await createJob({ sources, expectedFiles });

    const origin = req.headers["x-forwarded-proto"]
      ? `${req.headers["x-forwarded-proto"]}://${req.headers["x-forwarded-host"] || req.headers.host}`
      : `http://${req.headers.host || "localhost:3001"}`;

    const out = {
      jobId: job.id,
      status: job.status, // queued | uploading
      statusUrl: `${origin}/api/jobs/${job.id}`,
      processUrl: `${origin}/api/jobs/${job.id}/process`,
      expiresAt: job.expires_at,
    };
    if (expectedFiles > 0) {
      out.uploadChunkBytes = UPLOAD_CHUNK_BYTES;
      out.uploads = sources.map((s, i) => (s.kind === "file"
        ? { seq: i, uploadUrl: `${origin}/api/upload?job=${job.id}&seq=${i}&chunk=0` }
        : null)).filter(Boolean);
    }
    json(res, 201, out);
  } catch (e) {
    error(res, 500, `تعذر إنشاء المهمة: ${e.message}`);
  }
};
