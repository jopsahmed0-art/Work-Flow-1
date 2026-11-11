/**
 * GET /api/config — الحدود العامة + version (تُستخدم لفحص الجهوزية).
 */
const { LIMITS, UPLOAD_CHUNK_BYTES, VERSION } = require("../lib/env");
const { ensureSchema } = require("../lib/db");
const { json, error } = require("../lib/http");

module.exports = async (req, res) => {
  if (req.method !== "GET") return error(res, 405, "طريقة غير مسموحة — استخدم GET");
  try {
    await ensureSchema(); // الجهوزية تشمل توفر قاعدة البيانات
    json(res, 200, {
      version: VERSION,
      maxSources: LIMITS.maxSources,
      sourceMaxMB: LIMITS.sourceMaxMB,
      outputMaxMB: LIMITS.outputMaxMB,
      maxTotalDurationSec: LIMITS.maxTotalDurationSec,
      uploadChunkBytes: UPLOAD_CHUNK_BYTES,
      retentionHours: 24,
    });
  } catch (e) {
    error(res, 500, `الخدمة غير جاهزة: ${e.message}`);
  }
};
