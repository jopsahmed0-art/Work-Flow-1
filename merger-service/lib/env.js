/**
 * تحميل .env يدويًا (بدون مكتبات خارجية) + الثوابت والحدود القابلة للضبط.
 * خالص CommonJS بدون أي خطوة بناء — يعمل على Vercel Serverless مباشرة.
 */
const fs = require("fs");
const path = require("path");

// تحميل .env إن وُجد (نحوّل كل سطر KEY=VALUE إلى process.env دون الكتابة فوق القيم الموجودة)
try {
  const envPath = path.join(__dirname, "..", ".env");
  if (fs.existsSync(envPath)) {
    for (const line of fs.readFileSync(envPath, "utf8").split(/\r?\n/)) {
      const m = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)\s*$/);
      if (m && process.env[m[1]] === undefined) {
        process.env[m[1]] = m[2].replace(/^['"]|['"]$/g, "");
      }
    }
  }
} catch { /* لا .env محليًا — سنقرأ من بيئة Vercel */ }

const LIMITS = {
  maxSources: parseInt(process.env.MAX_SOURCES || "10", 10),
  sourceMaxMB: parseInt(process.env.SOURCE_MAX_MB || "200", 10),
  outputMaxMB: parseInt(process.env.OUTPUT_MAX_MB || "150", 10),
  maxTotalDurationSec: parseInt(process.env.MAX_TOTAL_DURATION_SEC || "600", 10),
  ffmpegPreset: process.env.FFMPEG_PRESET || "medium",
};

/** حجم جزء الرفع (4MB تحت حد Vercel ≈ 4.5MB) */
const UPLOAD_CHUNK_BYTES = 4 * 1024 * 1024;
/** حجم صف Blob في Turso (حد الصف الآمن ≈ 2MB) */
const DB_CHUNK_BYTES = 2 * 1024 * 1024;
/** عدد الصفوف في صفحة القراءة */
const READ_PAGE_ROWS = 8;
/** عمر الملفات: 24 ساعة */
const TTL_MS = 24 * 60 * 60 * 1000;
const VERSION = "1.0.0";

module.exports = { LIMITS, UPLOAD_CHUNK_BYTES, DB_CHUNK_BYTES, READ_PAGE_ROWS, TTL_MS, VERSION };
