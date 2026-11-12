/**
 * محرك الدمج — جودة عالية إلزامية:
 *  - توحيد كل المصادر: scale + pad إلى أكبر دقة بين المدخلات (حد أقصى 1920×1080 بأبعاد زوجية)،
 *    fps=30، setsar=1، format=yuv420p ثم concat=n=:v=1:a=1.
 *  - مصدر بلا صوت → مسار صامت anullsrc بنفس مدته بدل أن يفشل الدمج.
 *  - الترميز: libx264 CRF 18 + AAC 192k/44100Hz + +faststart — MP4 عالي الجودة يعمل فورًا على الويب.
 *  - التقدم من -progress pipe:1 (out_time_us) مقابل المدة الإجمالية: 0–40 سحب، 40–90 ترميز، 100 اكتمال.
 *  - ffmpeg قد يفقد صلاحية التنفيذ في الاستضافة → ensureExecutable ينسخه إلى /tmp بصلاحية 755.
 */
const fs = require("fs");
const os = require("os");
const path = require("path");
const { spawn } = require("child_process");
const { LIMITS } = require("./env");

/* ============ ضمان صلاحية التنفيذ ============ */

function staticPath(mod) {
  try { return require(mod); } catch { return null; }
}

function resolveBinary(which) {
  // 1) حزمة static المثبتة  2) المتغير البيئي  3) ثنائي النظام
  const pkg = which === "ffmpeg" ? staticPath("ffmpeg-static") : staticPath("ffprobe-static");
  let p = null;
  if (which === "ffmpeg") p = typeof pkg === "string" ? pkg : null;
  else p = pkg && pkg.path ? pkg.path : null;
  if (process.env[which === "ffmpeg" ? "FFMPEG_PATH" : "FFPROBE_PATH"]) {
    p = process.env[which === "ffmpeg" ? "FFMPEG_PATH" : "FFPROBE_PATH"];
  }
  if (!p || !fs.existsSync(p)) {
    p = which; // نأمل في ثنائي نظام ffmpeg/ffprobe في PATH
    return { path: p, needsFix: false };
  }
  return { path: p, needsFix: !isExecutable(p) };
}

function isExecutable(p) {
  try { fs.accessSync(p, fs.constants.X_OK); return true; } catch { return false; }
}

const ensured = new Map();
/** نسخ الثنائي إلى /tmp بصلاحية 755 عند الحاجة ثم إرجاع المسار القابل للتنفيذ */
function ensureExecutable(which) {
  if (ensured.has(which)) return ensured.get(which);
  const { path: p, needsFix } = resolveBinary(which);
  let execPath = p;
  if (needsFix && p.includes("/") && fs.existsSync(p)) {
    const tmp = path.join(os.tmpdir(), `bin-${path.basename(p)}-${path.basename(path.dirname(p))}`);
    if (!fs.existsSync(tmp)) {
      fs.copyFileSync(p, tmp);
      fs.chmodSync(tmp, 0o755);
    }
    execPath = tmp;
  } else if (fs.existsSync(p) && !isExecutable(p)) {
    try { fs.chmodSync(p, 0o755); } catch { /* Vercel readonly — نتجاهل */ }
  }
  ensured.set(which, execPath);
  return execPath;
}

/* ============ تشغيل أوامر ============ */

function run(cmd, args, opts = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, { stdio: ["ignore", "pipe", "pipe"] });
    let out = "", err = "";
    child.stdout.on("data", (d) => { out += d; if (opts.onStdout) opts.onStdout(d); });
    child.stderr.on("data", (d) => { err += d; });
    child.on("error", reject);
    child.on("close", (code) => (code === 0 ? resolve({ out, err }) : reject(new Error(`${path.basename(cmd)} exited ${code}: ${err.slice(-800)}`))));
  });
}

/** ffprobe لكل مصدر: الدقة، fps، المدة، وجود صوت */
async function probeFile(filePath) {
  const ffprobe = ensureExecutable("ffprobe");
  const { out } = await run(ffprobe, [
    "-v", "error", "-print_format", "json", "-show_format", "-show_streams", filePath,
  ]);
  const meta = JSON.parse(out);
  const v = (meta.streams || []).find((s) => s.codec_type === "video");
  const a = (meta.streams || []).find((s) => s.codec_type === "audio");
  if (!v) throw new Error("المصدر لا يحتوي مسار فيديو صالح");
  const fps = v.avg_frame_rate && v.avg_frame_rate !== "0/0"
    ? parseFloat(v.avg_frame_rate.split("/")[0]) / (parseFloat(v.avg_frame_rate.split("/")[1]) || 1)
    : 30;
  return {
    width: v.width, height: v.height,
    fps: Number.isFinite(fps) && fps > 0 ? fps : 30,
    duration: parseFloat(meta.format?.duration || v.duration || "0"),
    hasAudio: Boolean(a),
  };
}

function even(n) { return Math.max(2, Math.floor(n / 2) * 2); }

/** الأبعاد الهدف: أكبر دقة بين المدخلات مقصودة إلى حد 1920×1080 بأبعاد زوجية */
function targetSize(probes) {
  let w = 0, h = 0;
  for (const p of probes) { if (p.width > w) { w = p.width; } if (p.height > h) { h = p.height; } }
  const cappedW = Math.min(w, 1920), cappedH = Math.min(h, 1080);
  // نحافظ على النسبة: إن تجاوز أحد البُعدين الحد ننزل بالكامل
  let tw = cappedW, th = cappedH;
  if (w > 1920 || h > 1080) {
    const scale = Math.min(1920 / w, 1080 / h);
    tw = Math.round(w * scale); th = Math.round(h * scale);
  }
  return { w: even(tw), h: even(th) };
}

function fmt(n) { return Number(n.toFixed(6)).toString(); }

/**
 * الدمج الكامل من ملفات محلية في /tmp إلى ملف MP4 واحد.
 * sources: [{path, duration, hasAudio, width, height}]
 * onProgress(pct 0..100)
 */
async function mergeFiles(sources, outPath, onProgress) {
  const ffmpeg = ensureExecutable("ffmpeg");
  const totalDur = sources.reduce((a, s) => a + s.duration, 0);
  const { w, h } = targetSize(sources);

  // 0–40%: التهيئة (سحب المصادر تم قبل الاستدعاء — هذه الشريحة تمثل التحضير)
  if (onProgress) onProgress(5);

  const args = ["-y", "-hide_banner", "-loglevel", "error"];
  // مدخلات الفيديو
  for (const s of sources) args.push("-i", s.path);
  // مدخلات الصمت لكل مصدر بلا صوت (بنفس مدته)
  const silentCount = sources.filter((s) => !s.hasAudio).length;
  if (silentCount > 0) {
    let si = 0;
    for (const s of sources) {
      if (!s.hasAudio) {
        args.push("-f", "lavfi", "-t", fmt(s.duration), "-i", "anullsrc=channel_layout=stereo:sample_rate=44100");
        void si;
      }
    }
  }

  // filter_complex: توحيد كل مصدر ثم concat — ترتيب مدخلات الصمت يطابق ترتيب المصادر بلا صوت
  const fparts = [];
  let silentCursor = sources.length; // مدخلات الصمت تبدأ بعد مدخلات الفيديو
  const concatInputs = [];
  sources.forEach((s, i) => {
    fparts.push(`[${i}:v]scale=${w}:${h}:force_original_aspect_ratio=decrease,pad=${w}:${h}:(ow-iw)/2:(oh-ih)/2,fps=30,setsar=1,format=yuv420p[v${i}]`);
    if (s.hasAudio) {
      fparts.push(`[${i}:a]aresample=44100,aformat=sample_fmts=fltp:channel_layouts=stereo[a${i}]`);
    } else {
      fparts.push(`[${silentCursor}:a]aresample=44100[a${i}]`);
      silentCursor++;
    }
    concatInputs.push(`[v${i}][a${i}]`);
  });
  fparts.push(`${concatInputs.join("")}concat=n=${sources.length}:v=1:a=1[vout][aout]`);
  const filter = fparts.join(";");

  args.push("-filter_complex", filter, "-map", "[vout]", "-map", "[aout]");
  args.push("-c:v", "libx264", "-crf", "18", "-preset", LIMITS.ffmpegPreset);
  args.push("-c:a", "aac", "-b:a", "192k", "-ar", "44100", "-ac", "2");
  args.push("-movflags", "+faststart");
  // تقدم الترميز عبر -progress
  args.push("-progress", "pipe:1", "-nostats", outPath);

  let lastPct = 40;
  if (onProgress) onProgress(lastPct);
  await run(ffmpeg, args, {
    onStdout: (d) => {
      // قراءة out_time_us من سطور -progress
      const text = d.toString();
      const m = text.match(/out_time_us=(\d+)/);
      if (m && totalDur > 0 && onProgress) {
        const done = Number(m[1]) / 1e6;
        const pct = Math.min(95, 40 + Math.floor((done / totalDur) * 50)); // 40–90 ترميز
        if (pct > lastPct) { lastPct = pct; onProgress(pct); }
      }
    },
  });
  if (onProgress) onProgress(100);
  return { width: w, height: h, duration: totalDur };
}

/** تنزيل مصدر URL إلى ملف مؤقت مع عدّاد بايتات لفرض حد 200MB */
async function downloadToFile(url, destPath, onBytes) {
  const maxBytes = LIMITS.sourceMaxMB * 1024 * 1024;
  const res = await fetch(url, { redirect: "follow" });
  if (!res.ok || !res.body) throw new Error(`تعذر تنزيل المصدر (HTTP ${res.status})`);
  const { pipeline } = require("stream/promises");
  const fs = require("fs");
  let bytes = 0;
  const reader = res.body;
  // قراءة يدوية لتتبع الحجم وفرض الحد
  const ws = fs.createWriteStream(destPath);
  for await (const chunk of reader) {
    bytes += chunk.length;
    if (bytes > maxBytes) {
      ws.destroy();
      throw new Error(`حجم المصدر يتجاوز الحد (${LIMITS.sourceMaxMB}MB)`);
    }
    if (onBytes) onBytes(bytes);
    if (!ws.write(chunk)) await new Promise((r) => ws.once("drain", r));
  }
  await new Promise((r) => ws.end(r));
  void pipeline;
  return bytes;
}

module.exports = { ensureExecutable, probeFile, mergeFiles, downloadToFile, targetSize, even };
