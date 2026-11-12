/**
 * إدارة المفاتيح للواجهة:
 * GET  /api/keys — القائمة كاملة مع إخفاء المفاتيح دائمًا (maskKey) — لا يُعاد المفتاح الكامل في أي استجابة.
 * POST /api/keys — {provider, api_key, label?} مع رفض التكرار لنفس المزود.
 */
import { listKeys, insertKey, findDuplicateKey } from "@/lib/turso";
import { safeKey } from "@/lib/keys";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

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
    const body = (await req.json()) as { provider?: string; api_key?: string; label?: string };
    const provider = String(body.provider ?? "").trim().toLowerCase();
    const apiKey = String(body.api_key ?? "").trim();
    const label = String(body.label ?? "").trim().slice(0, 80);

    if (provider !== "kie" && provider !== "cometapi") {
      return Response.json({ error: "المزود يجب أن يكون kie أو cometapi" }, { status: 400 });
    }
    if (!apiKey) {
      return Response.json({ error: "مفتاح API مطلوب" }, { status: 400 });
    }

    // رفض التكرار لنفس المزود
    const dup = await findDuplicateKey(provider, apiKey);
    if (dup) {
      return Response.json({ error: "هذا المفتاح مضاف مسبقًا لنفس المزود ولا يمكن تكراره" }, { status: 409 });
    }

    const id = crypto.randomUUID();
    await insertKey({ id, provider, label, api_key: apiKey });
    const keys = await listKeys();
    return Response.json({ ok: true, id, keys: keys.map(safeKey) }, { status: 201 });
  } catch (e) {
    return Response.json({ error: `تعذر إضافة المفتاح: ${e instanceof Error ? e.message : String(e)}` }, { status: 500 });
  }
}
