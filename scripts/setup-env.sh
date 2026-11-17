#!/usr/bin/env bash
# إعداد متغيرات الاتصال بقاعدة Turso للتشغيل المحلي — يكتب .env.local (مستثنى من git ولا يُرفع أبدًا)
# الاستخدام: bash scripts/setup-env.sh
set -euo pipefail
cd "$(dirname "$0")/.."

if [ -f .env.local ]; then
  echo "⚠️  .env.local موجود بالفعل — لن يُستبدل. احذفه أولًا إن أردت الإعداد من جديد."
  exit 0
fi

echo "== إعداد قاعدة البيانات (Turso) =="
echo "القيمتان موجودتان في المشروع المنشور الأصلي: Vercel → Settings → Environment Variables"
echo "أو من Turso CLI: turso db show <db> ثم turso db tokens create <db>"
echo ""

read -rp "1) الصق TURSO_DATABASE_URL: " DB_URL
read -rsp "2) الصق TURSO_AUTH_TOKEN (الإدخال مخفي): " DB_TOKEN
echo ""

case "$DB_URL" in
  libsql://*|https://*) ;;
  *) echo "❌ الرابط يجب أن يبدأ بـ libsql:// أو https:// — لم يُكتب أي ملف."; exit 1 ;;
esac
[ -n "$DB_TOKEN" ] || { echo "❌ التوكن مطلوب — لم يُكتب أي ملف."; exit 1; }

printf 'TURSO_DATABASE_URL=%s\nTURSO_AUTH_TOKEN=%s\n' "$DB_URL" "$DB_TOKEN" > .env.local
chmod 600 .env.local
echo "✅ تم إنشاء .env.local بأذونات مقصورة (600) — شغّل بعدها: npm run dev"
echo "ملاحظة: الملف مستثنى من git (.env*) ولن يُرفع إلى GitHub أبدًا."
