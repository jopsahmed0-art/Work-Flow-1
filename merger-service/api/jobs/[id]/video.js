/**
 * GET /api/jobs/<id>/video?download=1 — بث الناتج بدعم Range (206 + Content-Range)
 * ليعمل التقديم/الترجيع في المشغل، و?download=1 للتحميل المباشر.
 * صفوف الـ Blobs تُحوَّل إلى stream مع تقليم أول/آخر جزء حسب المدى المطلوب.
 */
const { outputBytes, outputChunkIterator } = require("../../../lib/db");
const { cors, error } = require("../../../lib/http");

module.exports = async (req, res) => {
  if (req.method !== "GET") return error(res, 405, "طريقة غير مسموحة — استخدم GET");
  const id = req.query.id;
  if (!id) return error(res, 400, "معرّف المهمة مطلوب");

  try {
    const { bytes } = await outputBytes(id);
    if (!bytes) return error(res, 404, "لا يوجد ناتج لهذه المهمة (لم تُنفَّذ أو انتهت صلاحيتها بعد 24 ساعة)");

    cors(res);
    const headers = {
      "Content-Type": "video/mp4",
      "Accept-Ranges": "bytes",
      "Cache-Control": "no-store",
    };
    if (req.query.download === "1") {
      headers["Content-Disposition"] = `attachment; filename="merged-${id}.mp4"`;
    }

    // تحليل Range: bytes=start-end | bytes=start- | bytes=-N
    const rangeHeader = req.headers.range;
    let start = 0, end = bytes - 1;
    let status = 200;
    if (rangeHeader) {
      const m = String(rangeHeader).match(/^bytes=(\d*)-(\d*)$/);
      if (m) {
        if (m[1] === "" && m[2] !== "") {
          // آخر N بايت
          const n = parseInt(m[2], 10);
          start = Math.max(0, bytes - n);
        } else {
          start = parseInt(m[1] || "0", 10);
          if (m[2] !== "") end = Math.min(parseInt(m[2], 10), bytes - 1);
        }
        if (start > end || start >= bytes) {
          res.writeHead(416, { "Content-Range": `bytes */${bytes}` });
          res.end();
          return;
        }
        status = 206;
        headers["Content-Range"] = `bytes ${start}-${end}/${bytes}`;
      }
    }
    headers["Content-Length"] = String(end - start + 1);
    res.writeHead(status, headers);

    // بث الصفوف مع تخطي المقدمة وتقليم النهاية حسب المدى
    let skipped = 0;
    for await (const buf of outputChunkIterator(id)) {
      if (skipped + buf.length <= start) { skipped += buf.length; continue; }
      let piece = buf;
      if (skipped < start) {
        piece = piece.subarray(start - skipped);
        skipped = start;
      }
      const remaining = end - skipped + 1;
      if (remaining <= 0) break;
      if (piece.length > remaining) piece = piece.subarray(0, remaining);
      skipped += piece.length;
      res.write(piece);
      if (skipped > end) break;
    }
    res.end();
  } catch (e) {
    error(res, 500, `تعذر بث الفيديو: ${e.message}`);
  }
};
