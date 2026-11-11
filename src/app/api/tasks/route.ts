/**
 * GET /api/tasks — أحدث المهام + الإحصائيات للوحة المهام (تُحدَّث تلقائيًا كل ~5 ثوانٍ من الواجهة).
 * يدعم ?type=image|video|merge و ?status=completed|failed|processing و ?limit=1..50
 */
import { listRecentTasks, taskStats } from "@/lib/turso";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(req: Request) {
  try {
    const url = new URL(req.url);
    const type = url.searchParams.get("type") ?? undefined;
    const status = url.searchParams.get("status") ?? undefined;
    const limitRaw = Number(url.searchParams.get("limit") ?? "20");
    const limit = Number.isFinite(limitRaw) ? Math.max(1, Math.min(50, Math.floor(limitRaw))) : 20;

    const [tasks, stats] = await Promise.all([
      listRecentTasks(limit, { type, status }),
      taskStats(),
    ]);
    return Response.json({
      stats,
      tasks: tasks.map((t) => ({
        id: t.id,
        type: t.type,
        model: t.model,
        provider: t.provider,
        status: t.status,
        progress: t.progress,
        prompt: t.prompt,
        result_urls: safeParse(t.result_urls_json),
        error_message: t.error_message,
        attempts: safeCount(t.attempts_json),
        created_at: t.created_at,
        completed_at: t.completed_at,
      })),
    });
  } catch (e) {
    return Response.json({ error: `تعذر جلب المهام: ${e instanceof Error ? e.message : String(e)}` }, { status: 500 });
  }
}

function safeParse(json: string | null): string[] {
  try { const a = JSON.parse(json ?? "[]"); return Array.isArray(a) ? a.map(String) : []; } catch { return []; }
}
function safeCount(json: string): number {
  try { const a = JSON.parse(json ?? "[]"); return Array.isArray(a) ? a.length : 0; } catch { return 0; }
}
