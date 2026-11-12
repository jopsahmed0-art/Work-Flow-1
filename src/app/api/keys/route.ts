/**
 * إدارة المفاتيح للواجهة:
 * GET  /api/keys — القائمة كاملة مع إخفاء المفاتيح دائمًا (maskKey) — لا يُعاد المفتاح الكامل في أي استجابة.
 * POST /api/keys — {provider, api_key | api_keys[], label?} — يدعم الإضافة بالجملة (سطر لكل مفتاح)
 *                  مع رفض التكرار لنفس المزود وتقرير لكل مفتاح.
 */
import { listKeys, insertKey, findDuplicateKey } from "@/lib/turso";
import { safeKey, maskKey } from "@/lib/keys";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const MAX_BATCH = 50;
const PROVIDERS = ["kie", "cometapi", "nvidia", "gemini", "fal", "replicate", "custom"] as const;

/** استخراج قائمة المفاتيح من الحقل المفرد أو المصفوفة — يقبل الأسطر الجديدة والفواصل */
function parseKeyList(raw: unknown): string[] {
  const parts: string[] = [];
  const push = (v: unknown) => {
    if (typeof v !== "string") return;
    // فصل على الأسطر والفواصل والفواصل المنقوطة — المفتاح نفسه لا يحتوي هذه الرموز
    for (const p of v.split(/[\n\r;,]+/)) {
      const t = p.trim();
      if (t) parts.push(t);
    }
  };
  if (Array.isArray(raw)) raw.forEach(push);
  else push(raw);
  return parts.slice(0, MAX_BATCH);
}

export async function GET() {
  try {
    const keys = await listKeys();
    return Response.json({ keys: keys.map(safeKey) });
  } catch (e) {
    return Response.json({ error: `تعذر جلب المفاتيح: ${e instanceof Error ? e.message : String(e)}` }, { status: 500 });
  }
}

export async function POST(req: Request) {
  try {
    const body = (await req.json()) as {
      provider?: string; api_key?: string; api_keys?: string[]; label?: string;
      base_url?: string; dialect?: string; model_override?: string;
    };
    const provider = String(body.provider ?? "").trim().toLowerCase();
    const label = String(body.label ?? "").trim().slice(0, 80);

    if (!PROVIDERS.includes(provider as typeof PROVIDERS[number])) {
      return Response.json({ error: `المزود يجب أن يكون واحدًا من: ${PROVIDERS.join("، ")}` }, { status: 400 });
    }

    // المزود المخصص: رابط الـ API إلزامي (مثل https://api.deepinfra.com/v1/openai)
    const baseUrl = String(body.base_url ?? "").trim();
    const dialect = String(body.dialect ?? "").trim().toLowerCase() || "openai";
    const modelOverride = String(body.model_override ?? "").trim();
    if (provider === "custom" && !/^https?:\/\//i.test(baseUrl)) {
      return Response.json({ error: "لمزود مخصص: base_url مطلوب ويجب أن يبدأ http/https — مثل https://api.deepinfra.com/v1/openai" }, { status: 400 });
    }

    const keyList = parseKeyList(body.api_keys ?? body.api_key);
    if (keyList.length === 0) {
      return Response.json({ error: "مفتاح API مطلوب — الصق مفتاحًا أو أكثر (سطر لكل مفتاح)" }, { status: 400 });
    }

    const results: { masked: string; ok: boolean; reason?: string }[] = [];
    let added = 0;
    let skipped = 0;

    for (let i = 0; i < keyList.length; i++) {
      const apiKey = keyList[i];
      // تسمية مرقمة تلقائيًا عند إضافة عدة مفاتيح بنفس التسمية
      const effectiveLabel = keyList.length > 1 && label ? `${label} ${i + 1}` : label;
      const dup = await findDuplicateKey(provider, apiKey);
      if (dup) {
        skipped++;
        results.push({ masked: maskKey(apiKey), ok: false, reason: "مكرر — مضاف مسبقًا لنفس المزود" });
        continue;
      }
      const id = crypto.randomUUID();
      await insertKey({ id, provider, label: effectiveLabel, api_key: apiKey, base_url: baseUrl, dialect, model_override: modelOverride });
      added++;
      results.push({ masked: maskKey(apiKey), ok: true });
    }

    const keys = await listKeys();
    return Response.json({ ok: true, added, skipped, results, keys: keys.map(safeKey) }, { status: 201 });
  } catch (e) {
    return Response.json({ error: `تعذر إضافة المفتاح: ${e instanceof Error ? e.message : String(e)}` }, { status: 500 });
  }
}
