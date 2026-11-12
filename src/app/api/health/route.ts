/**
 * GET /api/health — جهوزية النظام الكاملة:
 * قاعدة البيانات + نقطة MCP + الموديلات + خدمة الدمج + هل المصادقة مطلوبة.
 */
import { dbHealthy } from "@/lib/turso";
import { MODELS } from "@/lib/models";
import { mergerHealthy, mergerBase, mergerConfigured } from "@/lib/merger";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET() {
  const db = await dbHealthy();
  const merger = { base: mergerConfigured() ? mergerBase() : "", healthy: await mergerHealthy() };
  return Response.json(
    {
      ok: db,
      database: db ? "turso-connected" : "turso-disconnected",
      mcpEndpoint: "/mcp",
      models: MODELS.map((m) => ({ canonical: m.canonical, type: m.type, providers: m.providers })),
      merger,
      authRequired: Boolean(process.env.MCP_ACCESS_TOKEN),
    },
    { status: db ? 200 : 503 }
  );
}
