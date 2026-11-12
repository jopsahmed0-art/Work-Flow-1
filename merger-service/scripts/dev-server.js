/**
 * خادم تطوير محلي يحاكي بيئة Vercel:
 *  - يخدم الواجهة الثابتة من public/
 *  - يحلّل المسارات الديناميكية ويضعها في req.query (مثل Vercel)
 *  - يجهّز req.body: JSON ككائن، الثنائي كـ Buffer
 * تشغيل: node scripts/dev-server.js  (افتراضيًا على المنفذ 3001)
 */
const http = require("http");
const fs = require("fs");
const path = require("path");

const PORT = parseInt(process.env.PORT || "3001", 10);
const ROOT = path.join(__dirname, "..");

const jobsIndex = require("../api/jobs.js");
const jobId = require("../api/jobs/[id].js");
const jobProcess = require("../api/jobs/[id]/process.js");
const jobVideo = require("../api/jobs/[id]/video.js");
const uploadFn = require("../api/upload.js");
const configFn = require("../api/config.js");
const cronFn = require("../api/cron.js");

const MIME = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".ico": "image/x-icon",
};

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on("data", (c) => {
      size += c.length;
      if (size > 10 * 1024 * 1024) { reject(new Error("body too large")); req.destroy(); return; }
      chunks.push(c);
    });
    req.on("end", () => resolve(Buffer.concat(chunks)));
    req.on("error", reject);
  });
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host}`);
  const pathname = decodeURIComponent(url.pathname);

  // محاكاة دوال Vercel على الاستجابة (status().json())
  if (!res.status) {
    res.status = (code) => { res._statusCode = code; return res; };
    res.json = (obj) => {
      const body = JSON.stringify(obj);
      res.writeHead(res._statusCode ?? 200, { "Content-Type": "application/json; charset=utf-8" });
      res.end(body);
      return res;
    };
  }

  // إعدادات req تحاكي Vercel: المسارات الديناميكية في req.query
  req.query = Object.fromEntries(url.searchParams);

  try {
    /* ============ API ============ */
    if (pathname.startsWith("/api/")) {
      const ct = (req.headers["content-type"] || "").toLowerCase();
      const raw = await readBody(req);
      if (ct.includes("application/json")) {
        try { req.body = raw.length ? JSON.parse(raw.toString("utf8")) : {}; }
        catch { res.writeHead(400, { "Content-Type": "application/json" }); res.end(JSON.stringify({ error: "JSON تالف" })); return; }
      } else {
        req.body = raw; // ثنائي (octet-stream) أو فارغ
      }

      let m;
      if (pathname === "/api/config") return void configFn(req, res);
      if (pathname === "/api/upload") return void uploadFn(req, res);
      if (pathname === "/api/cron") return void cronFn(req, res);
      if (pathname === "/api/jobs") return void jobsIndex(req, res);
      if ((m = pathname.match(/^\/api\/jobs\/([^/]+)\/process$/))) { req.query.id = m[1]; return void jobProcess(req, res); }
      if ((m = pathname.match(/^\/api\/jobs\/([^/]+)\/video$/))) { req.query.id = m[1]; return void jobVideo(req, res); }
      if ((m = pathname.match(/^\/api\/jobs\/([^/]+)$/))) { req.query.id = m[1]; return void jobId(req, res); }

      res.writeHead(404, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "المسار غير موجود" }));
      return;
    }

    /* ============ الواجهة الثابتة ============ */
    let file = pathname === "/" ? "/index.html" : pathname;
    const full = path.join(ROOT, "public", path.normalize(file).replace(/^([.][.][/\\])+/, ""));
    if (fs.existsSync(full) && fs.statSync(full).isFile()) {
      res.writeHead(200, { "Content-Type": MIME[path.extname(full)] || "application/octet-stream" });
      res.end(fs.readFileSync(full));
      return;
    }
    res.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" });
    res.end("404");
  } catch (e) {
    res.writeHead(500, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: e.message }));
  }
});

server.listen(PORT, () => {
  console.log(`[merger-dev] يعمل على http://localhost:${PORT}`);
});
