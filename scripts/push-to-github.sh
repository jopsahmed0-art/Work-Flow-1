#!/usr/bin/env bash
# سكربت الرفع إلى GitHub — يُمرَّر التوكن كوسيطة أولى (لا يُخزَّن في أي ملف)
# الاستخدام: bash scripts/push-to-github.sh ghp_XXXXXXXXXXXXXXXXXXXX
set -e
TOKEN="${1:?Usage: bash scripts/push-to-github.sh <GITHUB_TOKEN>}"
cd "$(dirname "$0")/.."
git push "https://x-access-token:${TOKEN}@github.com/jopsahmed0-art/Work-Flow-1.git" main
echo "تم الرفع بنجاح إلى https://github.com/jopsahmed0-art/Work-Flow-1"
