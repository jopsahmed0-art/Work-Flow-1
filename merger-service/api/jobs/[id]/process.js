/**
 * POST /api/jobs/<id>/process — تنفيذ الدمج كاملًا (متزامن):
 * ينزّل/يسحب المصادر ← يرمّز ← يحفظ الناتج في Turso، ويرجع مباشرة:
 *   {"status":"done","videoUrl","downloadUrl","size","duration","resolution","expiresAt"}
 * لو المهمة قيد المعالجة فعله يرجع 202.
 * التقدم: 0–40 سحب المصادر، 40–90 ترميز، 100 اكتمال.
 * لا ملفات دائمة — /tmp فقط أثناء المعالجة وتُنظَّف في finally.
 */
const fs = require("fs");
const os = require("os");
const path = require("path");
const { LIMITS } = require("../../../lib/env");
const { getJob, updateJob, readSourceBlob, countSourceChunks, saveOutputChunks, deleteSourceChunks } = require("../../../lib/db");
const { probeFile, mergeFiles, downloadToFile } = require("../../../lib/ffmpeg");
const { json, error } = require("../../../lib/http");

module.exports = async (req, res) => {
  if (req.method === "OPTIONS") { json(res, 204, {}); return; }
  if (req.method !== "POST") return error(res, 405, "طريقة غير مسموحة — استخدم POST");

  const id = req.query.id;
  if (!id) return error(res, 400, "معرّف المهمة مطلوب");

  let job;
  try { job = await getJob(id); } catch (e) { return error(res, 500, `تعذر قراءة المهمة: ${e.message}`); }
  if (!job) return error(res, 404, "المهمة غير موجودة (حُذفت أو انتهت صلاحيتها بعد 24 ساعة)");

  if (job.status === "processing") {
    return json(res, 202, { jobId: id, status: "processing", progress: job.progress });
  }
  if (job.status === "done") {
    return json(res, 200, donePayload(id, job, baseOf(req)));
  }
  if (job.status === "failed") {
    return error(res, 409, `المهمة فشلت سابقًا ولا يمكن إعادة تنفيذها: ${job.error ?? ""}`);
  }

  // مصادر ملفات لم تكتمل أجزاؤها بعد؟
  for (const s of job.sources) {
    if (s.kind === "file") {
      const { chunks } = await countSourceChunks(id, s.seq);
      if (!chunks) return error(res, 409, `المصدر رقم ${s.seq + 1} لم يُرفَع بعد — ارفع أجزاءه أولًا عبر /api/upload`);
    }
  }

  await updateJob(id, { status: "processing", progress: 1, error: null });
  const tmpFiles = [];
  try {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "merge-"));

    // 0–40%: سحب المصادر (تنزيل أو تجميع من قاعدة البيانات)
    const sources = [];
    const n = job.sources.length;
    for (let i = 0; i < n; i++) {
      const s = job.sources[i];
      const basePct = Math.floor(5 + (i / n) * 35);
      await updateJob(id, { progress: basePct });

      if (s.kind === "url") {
        const dest = path.join(tmpDir, `src-${i}${safeExt(s.url)}`);
        const bytes = await downloadToFile(s.url, dest);
        if (bytes > LIMITS.sourceMaxMB * 1024 * 1024) {
          throw new Error(`حجم المصدر ${i + 1} يتجاوز الحد (${LIMITS.sourceMaxMB}MB)`);
        }
        tmpFiles.push(dest);
        const p = await probeFile(dest);
        sources.push({ path: dest, ...p });
      } else {
        const blob = await readSourceBlob(id, s.seq);
        if (blob.length > LIMITS.sourceMaxMB * 1024 * 1024) {
          throw new Error(`حجم المصدر ${i + 1} يتجاوز الحد (${LIMITS.sourceMaxMB}MB)`);
        }
        const dest = path.join(tmpDir, `src-${i}${safeExt(null, s.name)}`);
        fs.writeFileSync(dest, blob);
        tmpFiles.push(dest);
        const p = await probeFile(dest);
        sources.push({ path: dest, ...p });
      }
    }

    // حدود المدة الإجمالية
    const totalDur = sources.reduce((a, s) => a + s.duration, 0);
    if (totalDur > LIMITS.maxTotalDurationSec) {
      throw new Error(`مجموع مدد المقاطع يتجاوز الحد (${LIMITS.maxTotalDurationSec} ثانية)`);
    }

    // 40–90%: الترميز عبر filter_complex موحّد + concat
    const outPath = path.join(tmpDir, "output.mp4");
    await mergeFiles(sources, outPath, (p) => {
      // نُثبّت التقدم في نطاق 40..90 أثناء الترميز
      void updateJob(id, { progress: Math.max(40, Math.min(90, p)) });
    });

    // حدود الناتج
    const size = fs.statSync(outPath).size;
    if (size > LIMITS.outputMaxMB * 1024 * 1024) {
      throw new Error(`حجم الناتج يتجاوز الحد (${LIMITS.outputMaxMB}MB)`);
    }

    // حفظ الناتج كصفوف 2MB ثم حذف أجزاء المصادر — الناتج فقط هو المطلوب
    await updateJob(id, { progress: 95 });
    await saveOutputChunks(id, outPath && fs.readFileSync(outPath));
    await deleteSourceChunks(id);

    const biggest = sources.reduce((a, s) => (s.width * s.height > a.width * a.height ? s : a), sources[0]);
    await updateJob(id, {
      status: "done",
      progress: 100,
      output_size: size,
      output_duration: Number(totalDur.toFixed(2)),
      output_resolution: `${biggest.width}x${biggest.height}`,
      output_mime: "video/mp4",
      error: null,
    });

    const fresh = await getJob(id);
    return json(res, 200, donePayload(id, fresh ?? job, baseOf(req)));
  } catch (e) {
    // فشل واضح برسالة عربية — وليس انهيار
    await updateJob(id, { status: "failed", error: e.message ?? "خطأ غير معروف أثناء الدمج" });
    return error(res, 500, e.message ?? "خطأ غير معروف أثناء الدمج");
  } finally {
    // تنظيف /tmp دائمًا
    for (const f of tmpFiles) { try { fs.unlinkSync(f); } catch { /* ignore */ } }
  }
};

function donePayload(id, job, base) {
  return {
    status: "done",
    jobId: id,
    videoUrl: `${base}/api/jobs/${id}/video`,
    downloadUrl: `${base}/api/jobs/${id}/video?download=1`,
    size: job.output_size,
    duration: job.output_duration,
    resolution: job.output_resolution,
    expiresAt: job.expires_at,
  };
}

function baseOf(req) {
  const proto = req.headers["x-forwarded-proto"] || "http";
  const host = req.headers["x-forwarded-host"] || req.headers.host || "localhost:3001";
  return `${proto}://${host}`;
}

function safeExt(url, name) {
  const src = (url || name || "").split("?")[0].toLowerCase();
  const m = src.match(/\.(mp4|mov|webm|mkv|avi|m4v|mpg|mpeg|3gp)$/);
  return m ? m[0] : ".mp4";
}
