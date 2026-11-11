/**
 * GET /api/cron — حذف المهام المنتهية صلاحيتها (Cron يومي في vercel.json عند الساعة 03:00).
 * يُستدعى أيضًا يدويًا للصيانة.
 */
const { cleanupExpired } = require("../lib/db");
const { json, error } = require("../lib/http");

module.exports = async (req, res) => {
  if (req.method !== "GET" && req.method !== "POST") return error(res, 405, "طريقة غير مسموحة");
  try {
    const deleted = await cleanupExpired();
    json(res, 200, { ok: true, deleted });
  } catch (e) {
    error(res, 500, `تعذر التنظيف: ${e.message}`);
  }
};
