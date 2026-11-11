# MCP Media Generator

خادم **MCP** لتوليد الصور والفيديو بالذكاء الاصطناعي ودمج المقاطع — مع **لوحة إدارة عربية RTL**، وتبديل تسلسلي صامت تلقائي بين مفاتيح API.

> هذا المستودع يحوي مشروعين يُنشران كمشروعين منفصلين على Vercel:
>
> | المجلد | المشروع | التقنية |
> |---|---|---|
> | الجذر `/` | خادم MCP على `/mcp` + لوحة الإدارة | Next.js 16 (App Router) + TypeScript |
> | `merger-service/` | خدمة دمج الفيديوهات (Video Merger API v2) | Node.js خالص (CommonJS) + ffmpeg |

---

## القدرات الثلاث

1. **توليد صور** من وصف نصي — الموديل: `gpt-image-2-6/flare-text-to-image`.
2. **توليد فيديو** بصوت متزامن أصلي — الموديل: `grok-imagine-video-1-5-preview`.
3. **دمج عدة مقاطع** في مقطع واحد عالي الجودة (MP4 — H.264 + AAC، حتى 1080p، CRF 18).

## القواعد الجوهرية

- **روابط فقط** — لا يُنزَّل أي ملف وسائط على السيرفر إطلاقًا؛ نخزّن روابط النتائج فقط في قاعدة البيانات.
- **ترتيب المفاتيح تسلسلي صارم** بترتيب الإضافة (`created_at ASC, id ASC`) — ليس round-robin.
- **لا توقف عند نفاد الرصيد** — انتقال تلقائي للمفتاح التالي واستئناف **نفس المهمة بنفس `task_id`**.
- **نموذج الذكاء الاصطناعي لا يرى أخطاء المفاتيح/الرصيد أبدًا** — التبديل صامت من وجهة نظه.
- مهمة فشلت على كل المفاتيح تبقى `processing` وتُعاد محاولتها تلقائيًا مع كل `get_task` (تهدئة ~45 ثانية) — لو شحنت رصيد أي مفتاح تكتمل من تلقاء نفسها.
- أخطاء خدمة الدمج المعلنة (HTTP 4xx/5xx) = فشل حتمي فوري؛ أخطاء شبكتنا = مؤقتة.
- ملفات الدمج تُحذف بعد **24 ساعة** — مذكورة في وصف الأداة وفي تعليمات الخادم.
- إخفاء المفاتيح إلزامي في كل الاستجابات (`ABCD123••••••••WXYZ`).
- `.env*` مُستثنى من Git منذ أول commit — لا أسرار في المستودع.

## خادم MCP — الأدوات الخمس على `/mcp`

| الأداة | الوظيفة |
|---|---|
| `generate_image` | توليد صورة — تعيد الرابط جاهزًا إن اكتملت خلال نافذة الانتظار وإلا `task_id` |
| `generate_video` | توليد فيديو (صوت متزامن، image-to-video اختياري) — `task_id` فورًا مع بث تقدم حي |
| `merge_videos` | دمج 2–10 مقاطع بالترتيب — عبر `urls` مباشرة أو `task_ids` لمهام مكتملة |
| `get_task` | تتبع أي مهمة (توليد أو دمج) — يستعلم كل ~10 ثوانٍ حتى الاكتمال |
| `list_media` | أحدث الوسائط المخزنة بروابطها — استرجاع دون إعادة توليد |

النقل: **Streamable HTTP** حسب مواصفة MCP (بروتوكول `2025-03-26`) عبر النقل الرسمي `WebStandardStreamableHTTPServerTransport` في وضع **stateless** — الخيار الصحيح لبيئة serverless على Vercel (لا جلسات في الذاكرة تنكسر بين النسخ)، والإشعارات التقدمية تُبَث عبر استجابة POST نفسها (SSE).

## الواجهة (لوحة الإدارة)

صفحة واحدة عربية RTL بثيم داكن:

- **مدير المفاتيح**: إضافة (kie.ai / CometAPI) + تسمية، عرض مقنّع، شارات حالة (نشط أخضر / مستنزف كهرماني / معطّل رمادي)، عدّادات استخدام/نجاح/فشل، آخر خطأ، تعطيل–تنشيط، حذف، ورفض التكرار.
- **لوحة المهام**: شرائح إحصائيات (إجمالي/مكتملة/فاشلة/جارية) + قائمة تتحدث تلقائيًا كل ~5 ثوانٍ مع شريط تقدم وروابط فتح النتائج وعدد المحاولات.
- **ربط السيرفر**: رابط `<origin>/mcp` بزر نسخ + تبويبات JSON جاهزة (ChatGPT / Claude Desktop / Cursor-Windsurf-Cline) + رقائق الأدوات الخمس + ملاحظة الفيديو غير المتزامن.

## التشغيل محليًا

```bash
bun install            # أو npm install
cp .env.example .env.local   # ثم املأ القيم الحقيقية
bun run dev            # http://localhost:3000
```

- الخدمة نفسها تعمل أيضًا كخادم تطوير مستقل: `cd merger-service && npm install && npm run dev` (المنفذ 3001) — واضبط `MERGER_API_BASE=http://localhost:3001` في `.env.local` لتجربة الدمج محليًا.

## متغيرات البيئة

```bash
# إلزامية (المشروع الرئيسي وخدمة الدمج كلاهما)
TURSO_DATABASE_URL=libsql://<db-name>-<org>.turso.io
TURSO_AUTH_TOKEN=<Turso token بصلاحيات كتابة>

# خدمة الدمج (الرابط بعد نشر merger-service على Vercel)
MERGER_API_BASE=https://<merger-project>.vercel.app

# اختيارية
MCP_ACCESS_TOKEN=            # إن ضُبط يُطلب Authorization: Bearer <token> على /mcp
KIE_IMAGE_MODEL=             # تجاوز أسماء الموديلات إن لزم
KIE_VIDEO_MODEL=
COMETAPI_IMAGE_MODEL=
COMETAPI_VIDEO_MODEL=
```

## النشر على Vercel (مشروعان)

1. **خدمة الدمج أولًا**: Vercel → Add New Project → استورد المستودع → **Root Directory = `merger-service`** → أضف `TURSO_DATABASE_URL` و `TURSO_AUTH_TOKEN` (Environment Variables) → Deploy. انسخ رابط النشر.
2. **المشروع الرئيسي**: Add New Project مرة أخرى → نفس المستودع → **Root Directory = جذر المستودع** → أضف المتغيرين السابقين + `MERGER_API_BASE=<رابط خدمة الدمج من الخطوة 1>` → Deploy.
3. افتح اللوحة، أضف مفاتيح kie.ai / CometAPI من بطاقة «مدير المفاتيح»، ثم اربط أي عميل MCP برابط `<origin>/mcp`.

## اختبار سريع بـ curl

```bash
# تهيئة (وضع stateless — لا حاجة لجلسة)
curl -s -X POST https://<origin>/mcp \
  -H 'Content-Type: application/json' \
  -H 'Accept: application/json, text/event-stream' \
  -d '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-03-26","capabilities":{},"clientInfo":{"name":"curl","version":"1.0"}}}'

# قائمة الأدوات
curl -s -X POST https://<origin>/mcp \
  -H 'Content-Type: application/json' -H 'Accept: application/json, text/event-stream' \
  -d '{"jsonrpc":"2.0","id":2,"method":"tools/list"}'

# استدعاء أداة
curl -s -X POST https://<origin>/mcp \
  -H 'Content-Type: application/json' -H 'Accept: application/json, text/event-stream' \
  -d '{"jsonrpc":"2.0","id":3,"method":"tools/call","params":{"name":"generate_image","arguments":{"prompt":"a red circle"}}}'
```

## البنية

```
src/
  app/
    mcp/route.ts              # خادم MCP — الأدوات الخمس (نقل Streamable HTTP)
    api/health/route.ts       # جهوزية: قاعدة البيانات + الموديلات + خدمة الدمج
    api/keys/route.ts         # GET (مقنّع) / POST (رفض تكرار)
    api/keys/[id]/route.ts    # PATCH تعطيل/تنشيط / DELETE حذف
    api/tasks/route.ts        # أحدث المهام + الإحصائيات للوحة
    page.tsx                  # لوحة الإدارة العربية RTL
  lib/
    turso.ts                  # طبقة قاعدة البيانات (المخطط يُنشأ تلقائيًا)
    models.ts                 # سجل الموديلات (canonical + aliases + مزودون)
    keys.ts                   # المسبحة التسلسلية + تصنيف الأخطاء + maskKey
    providers/kie.ts          # Jobs API الموحد لـ kie.ai (أشكال مقاسة فعليًا)
    providers/cometapi.ts     # صور متزامنة + فيديو مهام (توثيق cometapi.com)
    orchestrator.ts           # runGeneration/refreshTask/runMerge — التبديل الصامت
    merger.ts                 # عميل خدمة الدمج v2 (فشل حتمي/مؤقت)
merger-service/               # مشروع خدمة الدمج المستقل (انظر README داخله)
```

## ملاحظات تنفيذية موثقة بالقياس

- **kie.ai يعيد HTTP 200 دائمًا** مع رمز الحالة الحقيقي داخل الجسم (`{code:401,...}`) — المصنّف يقرأ `body.code` أولًا وإلا حالة HTTP.
- `recordInfo` يعيد `resultJson` **نصًا** يحتاج `JSON.parse` ثانيًا (مدعوم أيضًا الشكل الجديد `response.resultUrls`).
- الفيديو على kie.ai قد يفشل أحيانًا بخطأ `Internal Error` عابر — يُعامل كخطأ مؤقت ويُعاد إنشاؤه تلقائيًا بنفس `task_id` دون أن يرى العميل شيئًا.
- CometAPI: الصور متزامنة عبر `/v1/images/generations` (الاسم الموثق حاليًا للموديل `gpt-image-2.6-flare`)، والفيديو عبر مهام `/v1/videos` (multipart). أسماء الموديلات قابلة للتجاوز بمتغيرات البيئة.
- خدمة الدمج لا تدعم `resolution/fps` — الناتج ثابت (أكبر دقة مدخلات، حتى 1080p، 30fps، H.264+AAC).
