/**
 * خادم MCP على المسار /mcp — نقل Streamable HTTP حسب مواصفة MCP (بروتوكول 2025-03-26).
 *
 * قرار معماري: نستخدم النقل الرسمي WebStandardStreamableHTTPServerTransport من الـ SDK
 * (يعمل مباشرة مع Request/Response في Next.js App Router) في وضع Stateless —
 * لا حالة جلسة في الذاكرة؛ وهذا الخيار الصحيح للنشر على Vercel serverless حيث قد
 * يصل كل طلب إلى نسخة مختلفة، فلا انكسار للجلسات إطلاقًا. كل الأدوات تعتمد قاعدة
 * البيانات فقط، والتقدم يُبَث عبر SSE استجابة POST نفسها.
 *
 * runtime="nodejs" و dynamic="force-dynamic" إلزاميان.
 */
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import { z } from "zod";
import { findModel } from "@/lib/models";
import { runGeneration, runMerge, refreshTask, formatTaskReply, safeUrls, type NotifyFn } from "@/lib/orchestrator";
import { listRecentTasks } from "@/lib/turso";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 300;

export const SERVER_INFO = { name: "media-generator-mcp", version: "1.2.0" };

/** تعليمات جاهزة تُرسل مع initialize — تنظم سير عمل العميل وتمنع ظهور أخطاء المفاتيح */
export const SERVER_INSTRUCTIONS = `AI media generation server (kie.ai + CometAPI with automatic sequential multi-key failover, plus video merging).
Workflow: call generate_image or generate_video. If the response contains finished URLs, show them to the user.
If it returns a task_id with status PROCESSING, call get_task with that task_id every ~10 seconds until status is completed (show the URL) or failed (explain why).
IMPORTANT: the server automatically switches API keys in strict order on any failure (exhausted balance, invalid key, rate limits) and continues the SAME task under the same task_id — you will never encounter key/balance errors. Never stop or warn the user about keys or balances; just keep polling get_task until the result appears.
To concatenate several finished clips into one video, call merge_videos with 'urls' (direct links) or 'task_ids' (completed video tasks, in merge order); track it with get_task the same way. Note: the merged file is stored on the merging service for ~24 hours only — tell the user to watch/download it promptly.
Use list_media to recall previously generated media from the database.`;

/** بناء NotifyFn من progressToken الذي زوّده العميل — كل إشعار يُرسل على استجابة POST نفسها */
function notifyFromExtra(extra: unknown): NotifyFn | undefined {
  const ex = extra as { _meta?: { progressToken?: string | number }; sendNotification?: (n: unknown) => Promise<void> } | undefined;
  const token = ex?._meta?.progressToken;
  if (token === undefined || !ex?.sendNotification) return undefined;
  return async (p: { progress: number; total: number; message: string }) => {
    try {
      await ex.sendNotification!({
        method: "notifications/progress",
        params: { progressToken: token, progress: p.progress, total: p.total, message: p.message },
      });
    } catch { /* الإشعار اختياري — لا يفشل المهمة */ }
  };
}

function textResult(text: string, isError = false) {
  return { content: [{ type: "text" as const, text }], isError };
}

/** بناء خادم MCP جديد لكل طلب (وضع stateless) مع الأدوات الخمس */
function buildServer(): McpServer {
  const server = new McpServer(SERVER_INFO, { instructions: SERVER_INSTRUCTIONS });

  server.registerTool(
    "generate_image",
    {
      title: "Generate Image",
      description:
        "Generate an image with gpt-image-2-6/flare-text-to-image (automatic sequential failover across all active keys). " +
        "Returns a ready image URL if completed within the wait window; otherwise returns a task_id — call get_task every ~10 seconds until completed, then show the URL and stop.",
      inputSchema: {
        prompt: z.string().min(1).describe("What to draw. Detailed prompts give better results."),
        model: z.enum(["gpt-image-2-6/flare-text-to-image", "gpt-image-2.6/flare-text-to-image"])
          .default("gpt-image-2-6/flare-text-to-image"),
        aspect_ratio: z.enum(["auto", "1:1", "3:2", "2:3", "4:3", "3:4", "5:4", "4:5", "16:9", "9:16", "2:1", "1:2", "21:9", "9:21", "3:1", "1:3"])
          .default("auto"),
        resolution: z.enum(["1K", "2K", "4K"]).default("1K"),
        background: z.enum(["auto", "transparent", "opaque"]).default("auto").describe("Only applied at 1K."),
        output_format: z.enum(["png", "jpeg", "webp", "gif"]).default("png"),
        wait_seconds: z.number().int().min(0).max(240).default(90),
      },
    },
    async (args, extra) => {
      const model = findModel(args.model);
      if (!model) return textResult("❌ فشلت المهمة: موديل غير معروف.", true);
      const task = await runGeneration({
        type: "image",
        model,
        params: {
          prompt: args.prompt,
          aspect_ratio: args.aspect_ratio,
          resolution: args.resolution,
          background: args.background,
          output_format: args.output_format,
        },
        waitSeconds: args.wait_seconds,
        notify: notifyFromExtra(extra),
      });
      return textResult(formatTaskReply(task), task.status === "failed");
    }
  );

  server.registerTool(
    "generate_video",
    {
      title: "Generate Video",
      description:
        "Generate a video with grok-imagine-video-1-5-preview (native synchronized audio; optional image-to-video). " +
        "Video takes minutes: short wait with live progress streaming, then a task_id — track it with get_task every ~10 seconds.",
      inputSchema: {
        prompt: z.string().max(4096).describe("Scene description. Dialogue in the prompt is spoken in the video."),
        image_url: z.string().optional().describe("Optional public image URL as the first frame (image-to-video)."),
        model: z.enum(["grok-imagine-video-1-5-preview", "grok-imagine-video-1.5-preview"])
          .default("grok-imagine-video-1-5-preview"),
        aspect_ratio: z.enum(["auto", "1:1", "16:9", "9:16", "3:2", "2:3"]).default("auto"),
        resolution: z.enum(["480p", "720p", "1080p"]).default("480p"),
        enable_audio: z.boolean().default(true),
        duration: z.number().int().min(1).max(15).default(8).describe("Duration in seconds."),
        wait_seconds: z.number().int().min(0).max(240).default(25),
      },
    },
    async (args, extra) => {
      const model = findModel(args.model);
      if (!model) return textResult("❌ فشلت المهمة: موديل غير معروف.", true);
      const task = await runGeneration({
        type: "video",
        model,
        params: {
          prompt: args.prompt,
          image_url: args.image_url,
          aspect_ratio: args.aspect_ratio,
          resolution: args.resolution,
          enable_audio: args.enable_audio,
          duration: args.duration,
        },
        waitSeconds: args.wait_seconds,
        notify: notifyFromExtra(extra),
      });
      return textResult(formatTaskReply(task), task.status === "failed");
    }
  );

  server.registerTool(
    "merge_videos",
    {
      title: "Merge Videos",
      description:
        "Merge multiple clips into ONE final video in the given order. Pass 'urls' (public direct video URLs — like generate_video links) " +
        "or 'task_ids' (completed video generation tasks; their result URLs are resolved from the database in this order — ideal after generating several clips). " +
        "Merging is usually quick: short wait with live progress, then a merge task_id — track it with get_task. " +
        "Note: the merged file is stored on the merging service for ~24 hours only — tell the user to watch/download it promptly.",
      inputSchema: {
        urls: z.array(z.string()).min(2).max(10).optional()
          .describe("Public direct video URLs (http/https) in merge order — the first clip starts the final video."),
        task_ids: z.array(z.string()).min(2).max(10).optional()
          .describe("Alternative to urls: task_ids of COMPLETED video generation tasks — their result URLs are merged in this order."),
        wait_seconds: z.number().int().min(0).max(240).default(60),
      },
    },
    async (args, extra) => {
      if ((!args.urls || args.urls.length < 1) && (!args.task_ids || args.task_ids.length < 1)) {
        return textResult("❌ الدمج يحتاج مقطعَين على الأقل. مرّر urls (روابط مباشرة) أو task_ids لمهام مكتملة.", true);
      }
      const r = await runMerge({
        urls: args.urls,
        taskIds: args.task_ids,
        waitSeconds: args.wait_seconds,
        notify: notifyFromExtra(extra),
      });
      return textResult(r.reply, r.isError);
    }
  );

  server.registerTool(
    "get_task",
    {
      title: "Get Task",
      description:
        "Track any task by its id — image/video generation AND merging (reads the database and live-updates from the provider/merging service while in progress). " +
        "Poll it every ~10 seconds; when completed you will find the result URLs — show them to the user and stop polling.",
      inputSchema: {
        task_id: z.string().min(1),
      },
    },
    async (args, extra) => {
      const task = await refreshTask(args.task_id, notifyFromExtra(extra));
      if (!task) return textResult(`❌ لم يتم العثور على المهمة: ${args.task_id}`, true);
      return textResult(formatTaskReply(task), task.status === "failed");
    }
  );

  server.registerTool(
    "list_media",
    {
      title: "List Media",
      description:
        "Latest images/videos/merges stored with their result URLs from the database (no re-generation) — to recall previous results.",
      inputSchema: {
        type: z.enum(["image", "video", "merge"]).optional(),
        status: z.enum(["completed", "failed", "processing"]).optional(),
        limit: z.number().int().min(1).max(50).default(10),
      },
    },
    async (args) => {
      const rows = await listRecentTasks(args.limit, { type: args.type, status: args.status });
      if (!rows.length) {
        return textResult("لا توجد مهام مخزنة بعد الفلترة المطلوبة — ولّد وسائط أولًا بـ generate_image أو generate_video ثم استعِد بـ list_media.");
      }
      const lines = rows.map((t) => {
        const urls = safeUrls(t.result_urls_json);
        const typeAr = t.type === "image" ? "صورة" : t.type === "video" ? "فيديو" : "دمج";
        const statusAr = t.status === "completed" ? "مكتملة" : t.status === "failed" ? "فاشلة" : "جارية";
        const head = `- [${typeAr} • ${statusAr}] ${t.model}${t.prompt ? ` — «${t.prompt.slice(0, 60)}${t.prompt.length > 60 ? "…" : ""}»` : ""}`;
        const idLine = `  task_id: ${t.id}`;
        const urlLine = urls.length ? `\n  الروابط: ${urls.join(" ، ")}` : "";
        return `${head}\n${idLine}${urlLine}`;
      });
      return textResult(`أحدث ${rows.length} وسائط مخزنة (من الأحدث):\n\n${lines.join("\n")}`);
    }
  );

  return server;
}

/** فحص Bearer token إن ضُبط MCP_ACCESS_TOKEN */
function authOk(req: Request): boolean {
  const expected = process.env.MCP_ACCESS_TOKEN;
  if (!expected) return true;
  const auth = req.headers.get("authorization") ?? "";
  return auth === `Bearer ${expected}`;
}

function jsonError(status: number, code: number, message: string): Response {
  return new Response(JSON.stringify({ jsonrpc: "2.0", error: { code, message }, id: null }), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

export async function POST(req: Request): Promise<Response> {
  if (!authOk(req)) {
    return jsonError(401, -32001, "Unauthorized: MCP_ACCESS_TOKEN مطلوب (Authorization: Bearer <token>)");
  }
  let parsedBody: unknown;
  try {
    parsedBody = await req.json();
  } catch {
    return jsonError(400, -32700, "Parse error: جسم الطلب ليس JSON صالحًا");
  }
  // وضع stateless: نقل+خادم جدد لكل طلب (إلزامي في serverless)
  const transport = new WebStandardStreamableHTTPServerTransport({ sessionIdGenerator: undefined });
  const server = buildServer();
  await server.connect(transport);
  // parsedBody مُمرَّر مسبقًا لتجنب إعادة قراءة الجسم
  return await transport.handleRequest(req, { parsedBody });
}

export async function GET(): Promise<Response> {
  // وضع stateless لا يوفر بث SSE مستقلًا للجلسات — العميل يتقدم عبر استجابات POST (متوافق مع المواصفة: 405)
  return jsonError(405, -32000, "Method Not Allowed: هذا الخادم stateless — استخدم POST لرسائل JSON-RPC");
}

export async function DELETE(): Promise<Response> {
  return jsonError(405, -32000, "Method Not Allowed: لا توجد جلسات في وضع stateless");
}
