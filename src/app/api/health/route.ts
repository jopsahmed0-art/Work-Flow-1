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
  // تمييز "المتغيرات غير مضبوطة" عن "المتغيرات مضبوطة والاتصال فشل" — يساعد لوحة الإدارة على إظهار دليل الإعداد
  const configured = Boolean(process.env.TURSO_DATABASE_URL && process.env.TURSO_AUTH_TOKEN);
  const db = configured ? await dbHealthy() : false;
  const merger = { base: mergerConfigured() ? mergerBase() : "", healthy: await mergerHealthy() };
  return Response.json(
    {
      ok: db,
      database: !configured ? "turso-not-configured" : db ? "turso-connected" : "turso-disconnected",
      mcpEndpoint: "/mcp",
      models: MODELS.map((m) => ({ canonical: m.canonical, type: m.type, providers: m.providers })),
      merger,
      authRequired: Boolean(process.env.MCP_ACCESS_TOKEN),
    },
    { status: db ? 200 : 503 }
  );
}
