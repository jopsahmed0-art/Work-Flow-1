/**
 * PATCH  /api/keys/[id] — تعطيل/تنشيط يدوي {status} أو نقل المفتاح لمزود آخر {provider}
 * DELETE /api/keys/[id] — حذف نهائي
 */
import { getKey, updateKey, deleteKey } from "@/lib/turso";
import { safeKey } from "@/lib/keys";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type Ctx = { params: Promise<{ id: string }> };

const PROVIDERS = ["kie", "cometapi", "nvidia", "gemini"] as const;

export async function PATCH(req: Request, ctx: Ctx) {
  const { id } = await ctx.params;
  try {
    const body = (await req.json()) as { status?: string; provider?: string };
    const status = body.status !== undefined ? String(body.status) : undefined;
    const provider = body.provider !== undefined ? String(body.provider).trim().toLowerCase() : undefined;

    if (status === undefined && provider === undefined) {
      return Response.json({ error: "مرّر status (active/disabled) أو provider لنقل المفتاح لمزود آخر" }, { status: 400 });
    }
    if (status !== undefined && status !== "active" && status !== "disabled") {
      return Response.json({ error: "الحالة المسموحة: active أو disabled (تعطيل/تنشيط يدوي)" }, { status: 400 });
    }
    if (provider !== undefined && !PROVIDERS.includes(provider as typeof PROVIDERS[number])) {
      return Response.json({ error: `المزود يجب أن يكون واحدًا من: ${PROVIDERS.join("، ")}` }, { status: 400 });
    }

    const key = await getKey(id);
    if (!key) return Response.json({ error: "المفتاح غير موجود" }, { status: 404 });

    await updateKey(id, {
      ...(status !== undefined ? { status, last_error: status === "active" ? null : undefined } : {}),
      // نقل المزود يمسح الخطأ القديم لأنه كان يخص المنصة السابقة
      ...(provider !== undefined ? { provider, last_error: null } : {}),
    });
    const updated = await getKey(id);
    return Response.json({ ok: true, key: updated ? safeKey(updated) : null });
  } catch (e) {
    return Response.json({ error: `تعذر تحديث المفتاح: ${e instanceof Error ? e.message : String(e)}` }, { status: 500 });
  }
}

export async function DELETE(_req: Request, ctx: Ctx) {
  const { id } = await ctx.params;
  try {
    const key = await getKey(id);
    if (!key) return Response.json({ error: "المفتاح غير موجود" }, { status: 404 });
    await deleteKey(id);
    return Response.json({ ok: true });
  } catch (e) {
    return Response.json({ error: `تعذر حذف المفتاح: ${e instanceof Error ? e.message : String(e)}` }, { status: 500 });
  }
}
