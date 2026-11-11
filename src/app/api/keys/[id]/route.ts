/**
 * PATCH  /api/keys/[id] — تعطيل/تنشيط يدوي {status: "active" | "disabled"}
 * DELETE /api/keys/[id] — حذف نهائي
 */
import { getKey, updateKey, deleteKey } from "@/lib/turso";
import { safeKey } from "@/lib/keys";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type Ctx = { params: Promise<{ id: string }> };

export async function PATCH(req: Request, ctx: Ctx) {
  const { id } = await ctx.params;
  try {
    const body = (await req.json()) as { status?: string };
    const status = String(body.status ?? "");
    if (status !== "active" && status !== "disabled") {
      return Response.json({ error: "الحالة المسموحة: active أو disabled (تعطيل/تنشيط يدوي)" }, { status: 400 });
    }
    const key = await getKey(id);
    if (!key) return Response.json({ error: "المفتاح غير موجود" }, { status: 404 });
    await updateKey(id, { status, last_error: status === "active" ? null : undefined });
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
