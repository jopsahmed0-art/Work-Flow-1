/**
 * اختبار HTTP كامل ضد خادم التطوير المحلي (محيط يحاكي Vercel):
 *  1) إنشاء مهمة من روابط → دمج → بث مع Range 206
 *  2) مهمة مختلطة (رابط + ملف مرفوع على أجزاء)
 *  3) حذف → 404
 *  4) JSON تالف → 400
 *  5) رفض مقطع واحد وأكثر من الحد → رسائل عربية
 *  6) /api/config و /api/cron
 */
const BASE = process.env.MERGER_BASE || "http://localhost:3001";
let pass = 0, fail = 0;

function ok(name, cond, extra = "") {
  if (cond) { pass++; console.log(`  ✔ ${name}`); }
  else { fail++; console.log(`  ✘ ${name} ${extra}`); }
}

async function j(method, path, body, headers = {}) {
  const res = await fetch(BASE + path, {
    method,
    headers: { ...(body && !(body instanceof Buffer) ? { "Content-Type": "application/json" } : {}), ...headers },
    body: body instanceof Buffer ? body : body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  let json = null;
  try { json = JSON.parse(text); } catch { json = null; }
  return { status: res.status, json, text, headers: res.headers };
}

const URLS = [
  "https://www.w3schools.com/html/mov_bbb.mp4",
  "https://test-videos.co.uk/vids/bigbuckbunny/mp4/h264/360/Big_Buck_Bunny_360_10s_1MB.mp4",
];

async function main() {
  console.log("== 1) config & cron ==");
  const cfg = await j("GET", "/api/config");
  ok("config 200", cfg.status === 200 && cfg.json?.maxSources === 10);
  const cron = await j("GET", "/api/cron");
  ok("cron 200", cron.status === 200 && cron.json?.ok === true);

  console.log("== 2) تحقق صارم: مقطع واحد + أكثر من الحد + JSON تالف ==");
  const one = await j("POST", "/api/jobs", { videos: [URLS[0]] });
  ok("مقطع واحد → 400 برسالة عربية", one.status === 400 && /مقطعين|الدمج/.test(one.text));
  const many = await j("POST", "/api/jobs", { videos: Array(11).fill(URLS[0]) });
  ok("11 مقاطع → 400 برسالة عربية", many.status === 400 && /أقصى عدد/.test(many.text));
  const bad = await fetch(BASE + "/api/jobs", { method: "POST", headers: { "Content-Type": "application/json" }, body: "{oops" });
  ok("JSON تالف → 400", bad.status === 400);

  console.log("== 3) مهمة من روابط → دمج → ناتج ==");
  const t0 = Date.now();
  const create = await j("POST", "/api/jobs", { videos: URLS });
  ok("create 201 + queued", create.status === 201 && ["queued", "uploading"].includes(create.json?.status), create.text.slice(0, 200));
  ok("statusUrl/processUrl/expiresAt موجودة", Boolean(create.json?.statusUrl && create.json?.processUrl && create.json?.expiresAt));
  const jobId = create.json.jobId;

  // بث التقدم عبر GET قبل المعالجة
  const pre = await j("GET", `/api/jobs/${jobId}`);
  ok("GET حالة أولية", pre.status === 200 && ["queued", "processing"].includes(pre.json?.status));

  const proc = await j("POST", `/api/jobs/${jobId}/process`);
  ok("process 200 + done", proc.status === 200 && proc.json?.status === "done", JSON.stringify(proc.json).slice(0, 300));
  ok("videoUrl/downloadUrl على نطاق الخدمة", String(proc.json?.videoUrl || "").includes(BASE) && String(proc.json?.downloadUrl || "").includes(BASE));
  ok("size/duration/resolution موجودة", Boolean(proc.json?.size && proc.json?.duration && proc.json?.resolution));
  console.log(`   (استغرق الدمج ${Math.round((Date.now() - t0) / 1000)} ثانية — ${JSON.stringify(proc.json?.resolution)} — ${proc.json?.duration}s)`);

  // بث الفيديو: 200 كامل + Range 206
  const full = await fetch(BASE + `/api/jobs/${jobId}/video`);
  ok("بث كامل 200 video/mp4", full.status === 200 && full.headers.get("content-type") === "video/mp4");
  const range = await fetch(BASE + `/api/jobs/${jobId}/video`, { headers: { Range: "bytes=0-1023" } });
  ok("Range → 206 + Content-Range", range.status === 206 && /bytes 0-1023\//.test(range.headers.get("content-range") || ""));
  const rangeBody = Buffer.from(await range.arrayBuffer());
  ok("طول قطعة Range = 1024", rangeBody.length === 1024);
  const dl = await fetch(BASE + `/api/jobs/${jobId}/video?download=1`);
  ok("download=1 → Content-Disposition", /attachment/.test(dl.headers.get("content-disposition") || ""));
  void dl;

  console.log("== 4) مهمة مختلطة (رابط + ملف مرفوع على أجزاء) ==");
  // توليد ملف فيديو محلي صغير 320x240 بـ ffmpeg (ثنائي النظام أو static)
  const { execFileSync } = await import("node:child_process");
  const os = await import("node:os");
  const path = await import("node:path");
  const fs = await import("node:fs");
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "merger-test-"));
  const small = path.join(tmp, "small.mp4");
  let ffmpegBin = "ffmpeg";
  try { ffmpegBin = require("ffmpeg-static"); } catch { /* نظام */ }
  execFileSync(ffmpegBin, ["-y", "-hide_banner", "-loglevel", "error", "-f", "lavfi",
    "-i", "testsrc=size=320x240:rate=15:duration=3", "-f", "lavfi", "-i", "sine=frequency=440:duration=3",
    "-c:v", "libx264", "-preset", "veryfast", "-c:a", "aac", "-pix_fmt", "yuv420p", small]);
  const buf = fs.readFileSync(small);
  const mixed = await j("POST", "/api/jobs", {
    sources: [{ kind: "url", url: URLS[0] }, { kind: "file", name: "small.mp4", size: buf.length, mime: "video/mp4" }],
  });
  ok("مهمة مختلطة 201 + uploading", mixed.status === 201 && mixed.json?.status === "uploading");
  ok("uploads[] + uploadChunkBytes", Array.isArray(mixed.json?.uploads) && mixed.json.uploads.length === 1 && mixed.json.uploadChunkBytes > 0);
  const mid = mixed.json.jobId;
  const CHUNK = mixed.json.uploadChunkBytes;
  const nChunks = Math.ceil(buf.length / CHUNK);
  let uploaded = true;
  for (let k = 0; k < nChunks; k++) {
    const part = buf.subarray(k * CHUNK, (k + 1) * CHUNK);
    const up = await fetchRetryBinary(`${BASE}/api/upload?job=${mid}&seq=1&chunk=${k}`, part);
    if (up.status !== 200) { uploaded = false; console.log("   upload part", k, up.status); }
  }
  ok(`رفع ${nChunks} جزء(أجزاء) بنجاح`, uploaded);
  const mproc = await j("POST", `/api/jobs/${mid}/process`);
  ok("دمج مختلط → done", mproc.status === 200 && mproc.json?.status === "done", JSON.stringify(mproc.json).slice(0, 200));
  // URL[0] (mov_bbb) هو 320x240 والملف المولد 320x240 → أكبر دقة مدخل = 320x240
  ok("دقة الناتج = أكبر دقة مدخل (320x240)", mproc.json?.resolution === "320x240", mproc.json?.resolution);
  // نظّف مهمة الاختبار المختلط
  const mdel = await j("DELETE", `/api/jobs/${mid}`);
  ok("حذف المهمة المختلطة", mdel.status === 200);

  console.log("== 5) الحذف → 404 ==");
  const del = await j("DELETE", `/api/jobs/${jobId}`);
  ok("DELETE 200", del.status === 200);
  const gone = await j("GET", `/api/jobs/${jobId}`);
  ok("بعد الحذف → 404 برسالة عربية", gone.status === 404 && /غير موجودة/.test(gone.text));
  const goneVideo = await fetch(BASE + `/api/jobs/${jobId}/video`);
  ok("بث الناتج بعد الحذف → 404", goneVideo.status === 404);

  console.log(`\nالنتيجة: ${pass} ناجح / ${fail} فاشل`);
  process.exit(fail ? 1 : 0);
}

async function fetchRetryBinary(url, buf, tries = 3) {
  for (let i = 0; i < tries; i++) {
    try {
      return await fetch(url, { method: "POST", headers: { "Content-Type": "application/octet-stream" }, body: buf });
    } catch (e) { await new Promise((r) => setTimeout(r, 500)); }
  }
  return { status: -1 };
}

main().catch((e) => { console.error("فشل الاختبار:", e); process.exit(1); });
