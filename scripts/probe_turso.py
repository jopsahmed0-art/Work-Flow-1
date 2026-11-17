# فحص شكل قيم Turso في الملف الملصق — لا يطبع أي قيمة أبدًا، ويكتب .env.local فقط إن كانت قيمًا حقيقية
import re, os

c = open("upload/Pasted Content_1794399226157.txt", encoding="utf-8", errors="replace").read()
u = re.search(r"^TURSO_DATABASE_URL=(\S+)", c, re.M)
t = re.search(r"^TURSO_AUTH_TOKEN=(\S+)", c, re.M)
u = u.group(1) if u else ""
t = t.group(1) if t else ""

print("URL  : len", len(u), "| فيه libsql؟", "libsql" in u, "| فيه turso.io؟", "turso.io" in u, "| يبدأ بـ <؟", u.startswith("<"))
print("TOKEN: len", len(t), "| يبدأ بـ <؟", t.startswith("<"), "| JWT حقيقي؟", t.startswith("eyJ") and len(t) > 40)

# يُكتب الملف فقط إن كانت القيمتين بصيغة حقيقية مؤكدة — ولا يُطبع محتواهما أبدًا
if "libsql" in u and "turso.io" in u and t.startswith("eyJ") and len(t) > 40:
    with open(".env.local", "w", encoding="utf-8") as f:
        f.write(f"TURSO_DATABASE_URL={u}\nTURSO_AUTH_TOKEN={t}\n")
    os.chmod(".env.local", 0o600)
    print("→ كُتب .env.local بقيم حقيقية (المحتوى لا يُطبع)")
else:
    print("→ لا قيم حقيقية مؤكدة في الملف — لن يُكتب .env.local")
