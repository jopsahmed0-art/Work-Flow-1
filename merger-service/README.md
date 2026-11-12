# خدمة دمج الفيديوهات — Video Merger API v2

موقع كامل لدمج الفيديوهات مع **واجهة API عامة** للمطورين — Node.js خالص (CommonJS، بلا أي خطوة بناء) جاهز للنشر على Vercel، وكل شيء مخزّن في **Turso (libSQL)**: بيانات المهام، أجزاء ملفات المصادر، والفيديو الناتج (Blobs). لا S3 ولا خدمات خارجية.

- الواجهة: عربية RTL، ثيم داكن بتدرجات سماوي/بنفسجي، سحب وإفلات، إعادة ترتيب بالسحب أو ↑↓، شريط تقدم حقيقي، صفحة نتيجة بعدّاد تنازلي للصلاحية، توثيق API قابل للطي، واستئناف العرض عبر `#job=<id>`.
- المحرك: ffmpeg — توحيد كل المصادر (scale + pad إلى أكبر دقة حتى 1920×1080 بأبعاد زوجية، fps=30، yuv420p) ثم concat، مصدر بلا صوت يُعطى مسارًا صامتًا، الترميز libx264 **CRF 18** + AAC 192k/44100Hz + `+faststart` — MP4 عالي الجودة يعمل فورًا على الويب.
- الحذف التلقائي بعد **24 ساعة** (تنظيف كسول عند كل إنشاء/دمج + `/api/cron` يوميًا عبر `vercel.json`).

## الحدود العامة (قابلة للضبط بمتغيرات البيئة)

| الحد | القيمة الافتراضية |
|---|---|
| عدد المصادر | 10 كحد أقصى |
| حجم كل مصدر | 200MB |
| حجم الناتج | 150MB |
| مجموع مدد المقاطع | 600 ثانية |
| عمر الملفات | 24 ساعة (حذف تلقائي) |
| الناتج | MP4 (H.264 + AAC) حتى 1080p بجودة CRF 18 — لا resolution/fps، الناتج ثابت |

## 1) إنشاء قاعدة Turso والحصول على التوكن

```bash
# ثبّت CLI (مرة واحدة)
curl -sSfL https://get.tur.so/install.sh | bash

# أنشئ قاعدة مجانية
turso db create <اسم-القاعدة>

# اجلب رابط الاتصال
turso db show <اسم-القاعدة> --url
#   → libsql://<db-name>-<org>.turso.io

# أنشئ توكنًا بصلاحيات كتابة
turso db tokens create <اسم-القاعدة>
#   → انسخ التوكن (لا تشاركه أبدًا)
```

الجداول (`jobs`، `sources`، `source_chunks`، `output_chunks`) تُنشأ تلقائيًا بأول طلب (`CREATE TABLE IF NOT EXISTS`) — لا migrations ولا خطوات إضافية. كل Blob يُقسَّم إلى صفوف 2MB (حد HTTP في Turso) ويُقرأ تدفقيًا بصفحات من 8 صفوف.

## 2) النشر على Vercel خطوة بخطوة

1. ارفع هذا المجلد (`merger-service/`) كمشروع مستقل: Vercel → **Add New Project** → استورد المستودع.
2. في إعداد **Root Directory** اختر `merger-service` (مهم — حتى لا يُنشر مشروع Next.js الجذري بدلًا منه).
3. Framework Preset = **Other** (يتعرف تلقائيًا على ملفات `api/` — لا بناء).
4. **Settings → Environment Variables** أضف:
   - `TURSO_DATABASE_URL` = رابط القاعدة من الخطوة 1
   - `TURSO_AUTH_TOKEN` = التوكن من الخطوة 1
   - اختيارية: `MAX_SOURCES=10`، `SOURCE_MAX_MB=200`، `OUTPUT_MAX_MB=150`، `MAX_TOTAL_DURATION_SEC=600`، `FFMPEG_PRESET=medium`
5. **Deploy**. لا إعدادات أخرى — `vercel.json` يضبط `maxDuration: 300` لكل الدوال + cron يومي للتنظيف.
6. انسخ رابط المشروع (مثل `https://video-merger-xxx.vercel.app`) — هذا هو `MERGER_API_BASE` في المشروع الرئيسي.

> ملاحظات التشغيل: `/tmp` فقط أثناء المعالجة ويُنظَّف في `finally`؛ ثنائي ffmpeg يُنسخ عند الحاجة إلى `/tmp` بصلاحية 755 (`ensureExecutable`) لأن الاستضافة قد تفقد صلاحية التنفيذ.

## 3) اختبار الـ API بـ curl بعد النشر

```bash
BASE=https://<merger-project>.vercel.app

# الجهوزية والحدود
curl $BASE/api/config

# إنشاء مهمة من روابط مباشرة
curl -X POST $BASE/api/jobs \
  -H "Content-Type: application/json" \
  -d '{"videos":["https://a.com/clip1.mp4","https://b.com/clip2.mp4"]}'
# → 201 {"jobId":"...","status":"queued","statusUrl":"...","processUrl":"...","expiresAt":"..."}

# تنفيذ الدمج (متزامن — قد يستغرق دقائق للملفات الكبيرة)
curl -X POST $BASE/api/jobs/<id>/process
# → 200 {"status":"done","videoUrl":"...","downloadUrl":"...","size":...,"duration":...,"resolution":"WxH","expiresAt":"..."}
# → 202 إن كانت قيد المعالجة فعله

# الحالة والتقدم (0–100)
curl $BASE/api/jobs/<id>

# بث الناتج (يدعم Range — يعمل التقديم/الترجيع) أو تحميل مباشر
curl -o merged.mp4 "$BASE/api/jobs/<id>/video?download=1"

# رفع ملف من الجهاز على أجزاء 4MB
curl -X POST "$BASE/api/upload?job=<id>&seq=1&chunk=0" \
  -H "Content-Type: application/octet-stream" --data-binary @part0.bin

# حذف فوري شامل
curl -X DELETE $BASE/api/jobs/<id>
```

الأخطاء دائمًا `{"error":"..."}` برسائل عربية وكود صحيح: 400 مدخلات تالفة، 404 غير موجود، 409 حالة غير مناسبة، 413 تجاوز الحجم، 405 طريقة خاطئة. CORS مفتوح وبلا تسجيل دخول.

## 4) حدود الخطة المجانية التي يجب أن تعرفها

| البند | القيمة |
|---|---|
| مدة الدالة (Function Duration) | تصل 300 ثانية هنا (`maxDuration` في vercel.json) — المهام الأكبر قد تتوقف عند 300s |
| حجم الطلب الوارد | ≈ 4.5MB — لذا الرفع أجزاء POST ثنائية 4MB مع إعادة محاولة ×3 |
| حجم الاستجابة للبث | البث التدفيقي مع Range لا يحمّل الملف كاملًا في الذاكرة |
| حجم قاعدة Turso المجانية | 5GB تخزين و1 مليار قراءة صف/شهر تقريبًا — الفيديو الناتج يُحذف تلقائيًا بعد 24 ساعة فيقل الحجم |
| حجم حزمة الدالة | ffmpeg-static + ffprobe-static داخل الحزمة (~120MB مضغوطة تقريبًا) — ضمن حد 250MB غير مضغوطة |
| التنفيذات | خطط Vercel المجانية تحدد عدد ساعات التنفيذ شهريًا — الدمج يستهلك دقائق لكل مهمة |

## 5) التشغيل محليًا والاختبارات

```bash
npm install          # أو bun install
cp .env.example .env # واملأ متغيري Turso
npm run dev          # خادم تطوير على 3001 يحاكي Vercel (المسارات الديناميكية → req.query)
npm run test:unit    # 18 اختبارًا: توليد فيديوهين مختلفي الدقة، الدمج، الدقة/المدة/الصوت،
                     # تخزين Turso واسترجاع sha256، الأجزاء، الحذف الشامل
npm run test:http    # 24 اختبارًا: روابط → دمج → Range 206، مهمة مختلطة، حدود، حذف، 404، JSON تالف
```

## هيكل المشروع

```
api/
  jobs.js                 # POST إنشاء مهمة (videos أو sources)
  jobs/[id].js            # GET حالة+تقدم / DELETE حذف شامل
  jobs/[id]/process.js    # POST تنفيذ الدمج المتزامن (0–40 سحب، 40–90 ترميز، 100 اكتمال)
  jobs/[id]/video.js      # GET بث بدعم Range 206 + ?download=1
  upload.js               # POST أجزاء ثنائية ≤4MB
  config.js               # GET الحدود + version
  cron.js                 # GET حذف المهام المنتهية (يوميًا)
lib/
  db.js                   # Turso: 4 جداول + Blobs 2MB + قراءة بصفحات 8 صفوف
  ffmpeg.js               # ensureExecutable + ffprobe + filter_complex موحد + تقدم الترميز
  env.js                  # تحميل .env يدويًا + الحدود القابلة للضبط
  http.js                 # CORS مفتوح + أخطاء {"error":"..."} عربية
public/index.html         # الواجهة العربية RTL الكاملة (ملف واحد)
scripts/
  dev-server.js           # خادم تطوير يحاكي Vercel (المسارات الديناميكية → req.query)
  test-unit.mjs           # اختبارات الوحدات
  test-http.mjs           # اختبارات HTTP الكاملة
```
