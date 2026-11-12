/**
 * GET /api/media/[id] — تخديم وسيط مولّد (صورة) مخزّن في Turso كأجزاء base64.
 * رابط ثابت عام مع تخزين مؤقت طويل — تستخدمه محولات المزودين الذين يعيدون base64.
 */
import { getMedia } from "@/lib/media";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type Ctx = { params: Promise<{ id: string }> };

export async function GET(_req: Request, ctx: Ctx) {
  const { id } = await ctx.params;
  try {
    const m = await getMedia(id);
    if (!m) return new Response("Not found", { status: 404 });
    const bytes = Buffer.from(m.data, "base64");
    return new Response(new Uint8Array(bytes), {
      headers: {
        "Content-Type": m.mime,
        "Content-Length": String(bytes.byteLength),
        "Cache-Control": "public, max-age=31536000, immutable",
      },
    });
  } catch {
    return new Response("Internal error", { status: 500 });
  }
}
