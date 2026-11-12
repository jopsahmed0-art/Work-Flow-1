"use client";

/**
 * لوحة الإدارة العربية (RTL) — صفحة واحدة:
 *   أ) مدير المفاتيح — إضافة/تعطيل/حذف + عدّادات، المفاتيح مقنّعة دائمًا.
 *   ب) لوحة المهام — إحصائيات + أحدث المهام تتحدث تلقائيًا كل ~5 ثوانٍ.
 *   ج) ربط السيرفر — رابط /mcp + JSON جاهز لكل عميل + رقائق الأدوات + ملاحظة الفيديو.
 */
import { useCallback, useEffect, useMemo, useState } from "react";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Badge } from "@/components/ui/badge";
import { Progress } from "@/components/ui/progress";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { useToast } from "@/hooks/use-toast";
import {
  KeyRound, Plus, Trash2, Power, PowerOff, RefreshCw, Copy, Check,
  Image as ImageIcon, Film, Layers, Activity, Database, Plug, Zap,
  AlertTriangle, Clock, XCircle, CheckCircle2, Loader2, ExternalLink, Server,
} from "lucide-react";

/* ============ أنواع ============ */

interface KeySafe {
  id: string; provider: string; label: string; masked: string; status: string;
  usage_count: number; success_count: number; fail_count: number;
  last_used_at: string | null; last_error: string | null; created_at: string;
}
interface TaskItem {
  id: string; type: string; model: string; provider: string | null; status: string;
  progress: number; prompt: string; result_urls: string[];
  error_message: string | null; attempts: number; created_at: string;
}
interface Stats { total: number; completed: number; failed: number; processing: number }
interface Health {
  ok: boolean; database: string; mcpEndpoint: string; authRequired: boolean;
  models: Array<{ canonical: string; type: string; providers: string[] }>;
  merger: { base: string; healthy: boolean };
}

const TOOLS_INFO = [
  { name: "generate_image", ar: "توليد صورة من وصف نصي — تعيد الرابط جاهزًا أو task_id للمتابعة" },
  { name: "generate_video", ar: "توليد فيديو بصوت متزامن — task_id فوري ثم متابعة بـ get_task" },
  { name: "merge_videos", ar: "دمج عدة مقاطع في فيديو واحد بالترتيب — عبر urls أو task_ids" },
  { name: "get_task", ar: "تتبع أي مهمة (توليد أو دمج) بمعرّفها كل ~10 ثوانٍ حتى الاكتمال" },
  { name: "list_media", ar: "استرجاع أحدث الوسائط المخزنة بروابطها دون إعادة توليد" },
];

const typeMeta: Record<string, { label: string; icon: React.ReactNode; cls: string }> = {
  image: { label: "صورة", icon: <ImageIcon className="size-3.5" />, cls: "bg-cyan-500/15 text-cyan-600 border-cyan-500/30" },
  video: { label: "فيديو", icon: <Film className="size-3.5" />, cls: "bg-violet-500/15 text-violet-600 border-violet-500/30" },
  merge: { label: "دمج", icon: <Layers className="size-3.5" />, cls: "bg-emerald-500/15 text-emerald-600 border-emerald-500/30" },
};

const statusMeta: Record<string, { label: string; cls: string }> = {
  completed: { label: "مكتملة", cls: "bg-emerald-500/15 text-emerald-600 border-emerald-500/30" },
  failed: { label: "فاشلة", cls: "bg-red-500/15 text-red-600 border-red-500/30" },
  processing: { label: "جارية", cls: "bg-amber-500/15 text-amber-600 border-amber-500/30" },
  pending: { label: "بالانتظار", cls: "bg-slate-500/15 text-slate-600 border-slate-500/30" },
};

const keyStatusMeta: Record<string, { label: string; cls: string }> = {
  active: { label: "نشط", cls: "bg-emerald-500/15 text-emerald-600 border-emerald-500/30" },
  exhausted: { label: "مستنزف", cls: "bg-amber-500/15 text-amber-600 border-amber-500/30" },
  disabled: { label: "معطّل", cls: "bg-slate-500/15 text-slate-500 border-slate-500/30" },
};

/** أسماء المزودين المعروضة + مصدر المفتاح لكل مزود */
const PROVIDER_LABELS: Record<string, string> = {
  kie: "kie.ai",
  cometapi: "CometAPI",
  nvidia: "NVIDIA NIM",
  gemini: "Google Gemini",
};

const PROVIDER_SOURCES: Record<string, string> = {
  kie: "kie.ai → API Keys",
  cometapi: "cometapi.com → API Keys (sk-…)",
  nvidia: "build.nvidia.com (nvapi-…)",
  gemini: "aistudio.google.com/apikey",
};

function fmtTime(s: string | null): string {
  if (!s) return "—";
  const d = new Date(s.includes("T") ? s : s.replace(" ", "T") + "Z");
  if (Number.isNaN(d.getTime())) return s;
  return d.toLocaleString("ar-EG", { dateStyle: "short", timeStyle: "short" });
}

function JsonBlock({ text }: { text: string }) {
  const [copied, setCopied] = useState(false);
  const copy = async () => {
    try { await navigator.clipboard.writeText(text); setCopied(true); setTimeout(() => setCopied(false), 1500); } catch { /* ignore */ }
  };
  return (
    <div className="relative">
      <pre dir="ltr" className="rounded-lg bg-slate-950 text-slate-200 text-xs leading-5 p-4 pe-12 overflow-x-auto border border-slate-800 font-mono">{text}</pre>
      <Button size="icon" variant="ghost" onClick={copy} aria-label="نسخ JSON"
        className="absolute top-2 end-2 size-7 text-slate-300 hover:text-white">
        {copied ? <Check className="size-4 text-emerald-400" /> : <Copy className="size-4" />}
      </Button>
    </div>
  );
}

export default function Dashboard() {
  const { toast } = useToast();

  /* ============ الحالة ============ */
  const [health, setHealth] = useState<Health | null>(null);
  const [keys, setKeys] = useState<KeySafe[]>([]);
  const [stats, setStats] = useState<Stats>({ total: 0, completed: 0, failed: 0, processing: 0 });
  const [tasks, setTasks] = useState<TaskItem[]>([]);
  const [mcpUrl, setMcpUrl] = useState("");
  const [copiedUrl, setCopiedUrl] = useState(false);

  // نموذج إضافة مفتاح
  const [provider, setProvider] = useState("kie");
  const [label, setLabel] = useState("");
  const [apiKey, setApiKey] = useState("");
  const [adding, setAdding] = useState(false);

  /* ============ الجلب ============ */
  const loadHealth = useCallback(async () => {
    try { setHealth(await (await fetch("/api/health")).json()); } catch { setHealth(null); }
  }, []);

  const loadKeys = useCallback(async () => {
    try { const r = await (await fetch("/api/keys")).json(); setKeys(r.keys ?? []); } catch { /* ignore */ }
  }, []);

  const loadTasks = useCallback(async () => {
    try {
      const r = await (await fetch("/api/tasks?limit=20")).json();
      setStats(r.stats ?? { total: 0, completed: 0, failed: 0, processing: 0 });
      setTasks(r.tasks ?? []);
    } catch { /* ignore */ }
  }, []);

  useEffect(() => {
    setMcpUrl(`${window.location.origin}/mcp`);
    loadHealth(); loadKeys(); loadTasks();
    const h = setInterval(loadHealth, 15000);
    const t = setInterval(loadTasks, 5000); // تحديث تلقائي كل ~5 ثوانٍ
    return () => { clearInterval(h); clearInterval(t); };
  }, [loadHealth, loadKeys, loadTasks]);

  /* ============ عمليات المفاتيح ============ */
  const addKey = async () => {
    const list = apiKey.split(/[\n\r;,]+/).map((s) => s.trim()).filter(Boolean);
    if (!list.length) { toast({ title: "الصق مفتاحًا أو أكثر أولًا (سطر لكل مفتاح)", variant: "destructive" }); return; }
    setAdding(true);
    try {
      const res = await fetch("/api/keys", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ provider, api_keys: list, label: label.trim() }),
      });
      const data = await res.json();
      if (!res.ok) { toast({ title: data.error ?? "تعذر إضافة المفاتيح", variant: "destructive" }); return; }
      setKeys(data.keys ?? []);
      setApiKey(""); setLabel("");
      const skippedNote = data.skipped > 0 ? ` — وتُجاهِل ${data.skipped} مكرر` : "";
      toast({
        title: data.added > 0
          ? `تمت إضافة ${data.added} مفتاح${data.added > 1 ? "ًا" : ""} بنجاح${skippedNote}`
          : "لم يُضف مفتاح جديد — كلها مكررة",
        variant: data.added > 0 ? "default" : "destructive",
      });
    } finally { setAdding(false); }
  };

  const toggleKey = async (k: KeySafe) => {
    const next = k.status === "disabled" ? "active" : "disabled";
    const res = await fetch(`/api/keys/${k.id}`, {
      method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ status: next }),
    });
    if (res.ok) { await loadKeys(); toast({ title: next === "disabled" ? "تم تعطيل المفتاح" : "تم تنشيط المفتاح" }); }
    else { const d = await res.json(); toast({ title: d.error ?? "تعذر التحديث", variant: "destructive" }); }
  };

  const removeKey = async (k: KeySafe) => {
    const res = await fetch(`/api/keys/${k.id}`, { method: "DELETE" });
    if (res.ok) { await loadKeys(); toast({ title: "تم حذف المفتاح نهائيًا" }); }
    else { const d = await res.json(); toast({ title: d.error ?? "تعذر الحذف", variant: "destructive" }); }
  };

  const copyUrl = async () => {
    try { await navigator.clipboard.writeText(mcpUrl); setCopiedUrl(true); setTimeout(() => setCopiedUrl(false), 1500); } catch { /* ignore */ }
  };

  /* ============ JSON لكل عميل ============ */
  const authHeader = useMemo(() => health?.authRequired ? { headers: { Authorization: "Bearer <MCP_ACCESS_TOKEN>" } } : {}, [health?.authRequired]);
  const jsonChatgpt = useMemo(() => JSON.stringify({ mcpServers: { "media-generator": { url: mcpUrl, ...authHeader } } }, null, 2), [mcpUrl, authHeader]);
  const jsonClaude = useMemo(() => JSON.stringify({ mcpServers: { "media-generator": { type: "http", url: mcpUrl, ...authHeader } } }, null, 2), [mcpUrl, authHeader]);
  const jsonCursor = useMemo(() => JSON.stringify({ mcpServers: { "media-generator": { url: mcpUrl, ...authHeader } } }, null, 2), [mcpUrl, authHeader]);

  /** ملخص صحة مسبحة المفاتيح — يظهر أعلى بطاقة المفاتيح */
  const poolStats = useMemo(() => ({
    active: keys.filter((k) => k.status === "active").length,
    exhausted: keys.filter((k) => k.status === "exhausted").length,
    disabled: keys.filter((k) => k.status === "disabled").length,
  }), [keys]);

  const dbOk = health?.database === "turso-connected";

  return (
    // ثيم داكن مركزي (bg-background) + هالات ضوئية زخرفية خلف المحتوى
    <div className="relative min-h-screen bg-background text-foreground">
      {/* هالات ضوئية — لا تتفاعل مع الماوس */}
      <div aria-hidden className="pointer-events-none fixed inset-0 z-0 overflow-hidden">
        <div className="absolute -top-32 start-1/4 h-72 w-[36rem] rounded-full bg-cyan-500/10 blur-3xl" />
        <div className="absolute top-1/3 end-0 h-80 w-80 rounded-full bg-violet-600/10 blur-3xl" />
        <div className="absolute bottom-0 start-0 h-64 w-64 rounded-full bg-cyan-400/5 blur-3xl" />
      </div>
      <div className="relative z-10 mx-auto max-w-6xl px-4 py-8 sm:px-6">

        {/* ============ الهيدر ============ */}
        <header className="mb-8 flex flex-wrap items-center justify-between gap-4">
          <div className="flex items-center gap-3">
            <div className="flex size-11 items-center justify-center rounded-xl bg-gradient-to-br from-cyan-500 to-violet-600 shadow-lg shadow-violet-900/40">
              <Zap className="size-6 text-white" />
            </div>
            <div>
              <h1 className="bg-gradient-to-l from-cyan-300 via-white to-violet-300 bg-clip-text text-xl font-extrabold text-transparent sm:text-2xl">MCP Media Generator</h1>
              <p className="text-sm text-slate-400">خادم توليد الصور والفيديو ودمج المقاطع — لوحة الإدارة</p>
            </div>
          </div>
          <div className="flex items-center gap-2">
            <Badge
              className={dbOk
                ? "gap-1.5 border border-emerald-500/40 bg-emerald-500/15 text-emerald-400"
                : "gap-1.5 border border-red-500/40 bg-red-500/15 text-red-400"}
            >
              <Database className="size-3.5" />
              {dbOk ? "Turso متصل" : "Turso غير متصل"}
            </Badge>
            {health && (
              <Badge className={health.merger.healthy
                ? "gap-1.5 border border-emerald-500/40 bg-emerald-500/15 text-emerald-400"
                : "gap-1.5 border border-amber-500/40 bg-amber-500/15 text-amber-400"}>
                <Layers className="size-3.5" />
                {health.merger.healthy ? "خدمة الدمج جاهزة" : "خدمة الدمج غير مضبوطة"}
              </Badge>
            )}
            <Button variant="ghost" size="icon" onClick={() => { loadHealth(); loadKeys(); loadTasks(); }} aria-label="تحديث">
              <RefreshCw className="size-4" />
            </Button>
          </div>
        </header>

        <div className="grid gap-6 lg:grid-cols-2">

          {/* ============ أ) مدير المفاتيح ============ */}
          <Card className="border-slate-800/80 bg-card/70 backdrop-blur">
            <CardHeader className="pb-3">
              <CardTitle className="flex items-center gap-2 text-lg">
                <KeyRound className="size-5 text-cyan-400" /> مدير المفاتيح
              </CardTitle>
              <CardDescription className="leading-6 text-slate-400">
                الصق عدة مفاتيح دفعة واحدة (سطر لكل مفتاح) — التجربة تسلسلية بالترتيب مع تبديل فوري
                تلقائي للمفتاح التالي عند أي خطأ أو نفاد رصيد، فلا يتوقف التوليد.
              </CardDescription>
            </CardHeader>
            <CardContent className="space-y-4">
              {/* ملخص صحة المسبحة */}
              <div className="flex flex-wrap gap-2">
                <Badge className="gap-1.5 border border-emerald-500/40 bg-emerald-500/15 text-emerald-400">
                  <CheckCircle2 className="size-3.5" /> نشط: {poolStats.active}
                </Badge>
                <Badge className="gap-1.5 border border-amber-500/40 bg-amber-500/15 text-amber-400">
                  <AlertTriangle className="size-3.5" /> مستنزف: {poolStats.exhausted}
                </Badge>
                <Badge className="gap-1.5 border border-slate-500/40 bg-slate-400/15 text-slate-300">
                  <PowerOff className="size-3.5" /> معطل: {poolStats.disabled}
                </Badge>
              </div>

              {/* نموذج الإضافة */}
              <div className="grid gap-2 sm:grid-cols-[150px_1fr_auto]">
                <Select value={provider} onValueChange={setProvider}>
                  <SelectTrigger aria-label="المزود" className="bg-slate-950 border-slate-700">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="kie">kie.ai</SelectItem>
                    <SelectItem value="cometapi">CometAPI</SelectItem>
                    <SelectItem value="nvidia">NVIDIA NIM</SelectItem>
                    <SelectItem value="gemini">Google Gemini</SelectItem>
                  </SelectContent>
                </Select>
                <Input
                  value={label}
                  onChange={(e) => setLabel(e.target.value)}
                  placeholder="تسمية اختيارية (مثل: الحساب الرئيسي)"
                  className="bg-slate-950 border-slate-700"
                />
                <Button onClick={addKey} disabled={adding} className="bg-gradient-to-l from-cyan-500 to-violet-600 text-white hover:opacity-90">
                  {adding ? <Loader2 className="size-4 animate-spin" /> : <Plus className="size-4" />} إضافة
                </Button>
              </div>
              <Textarea
                value={apiKey}
                onChange={(e) => setApiKey(e.target.value)}
                placeholder={"مفتاح واحد أو أكثر — سطر لكل مفتاح:\nsk-example111111111111\nsk-example222222222222\n\nيُخزَّن ويُعرض مقنّعًا فقط (ABCD123••••••••WXYZ)"}
                rows={3}
                className="resize-y bg-slate-950 border-slate-700 font-mono text-sm"
                dir="ltr"
              />
              {/* مصدر المفتاح للمزود المختار — يساعد على أخذ المفتاح من المكان الصحيح */}
              <p className="text-xs text-slate-500">
                مصدر مفتاح <b className="text-slate-300">{PROVIDER_LABELS[provider] ?? provider}</b>:{" "}
                <span dir="ltr" className="font-mono text-slate-400">{PROVIDER_SOURCES[provider] ?? "—"}</span>
              </p>

              {/* القائمة */}
              {keys.length === 0 ? (
                <p className="rounded-lg border border-dashed border-slate-700 p-6 text-center text-sm text-slate-500">
                  لا توجد مفاتيح بعد — أضف مفتاحًا واحدًا على الأقل ليبدأ التوليد العمل.
                </p>
              ) : (
                <ul className="max-h-96 space-y-3 overflow-y-auto pe-1">
                  {keys.map((k, i) => (
                    <li key={k.id} className="rounded-xl border border-slate-800 bg-slate-950/60 p-3">
                      <div className="flex flex-wrap items-center justify-between gap-2">
                        <div className="flex items-center gap-2">
                          <span className="flex size-6 items-center justify-center rounded-md bg-slate-800 text-xs font-bold text-slate-300">{i + 1}</span>
                          <code dir="ltr" className="font-mono text-sm text-cyan-300">{k.masked}</code>
                          <Badge variant="outline" className="border-slate-700 bg-slate-900 text-slate-300">{PROVIDER_LABELS[k.provider] ?? k.provider}</Badge>
                          <Badge className={keyStatusMeta[k.status]?.cls ?? keyStatusMeta.disabled.cls}>{keyStatusMeta[k.status]?.label ?? k.status}</Badge>
                        </div>
                        <div className="flex items-center gap-1">
                          <Button size="icon" variant="ghost" onClick={() => toggleKey(k)} aria-label={k.status === "disabled" ? "تنشيط" : "تعطيل"}
                            className="size-8 text-slate-400 hover:text-white">
                            {k.status === "disabled" ? <Power className="size-4" /> : <PowerOff className="size-4" />}
                          </Button>
                          <Button size="icon" variant="ghost" onClick={() => removeKey(k)} aria-label="حذف"
                            className="size-8 text-slate-400 hover:text-red-400">
                            <Trash2 className="size-4" />
                          </Button>
                        </div>
                      </div>
                      <div className="mt-2 flex flex-wrap gap-x-4 gap-y-1 text-xs text-slate-400">
                        <span>استخدام: <b className="text-slate-200">{k.usage_count}</b></span>
                        <span>نجاح: <b className="text-emerald-400">{k.success_count}</b></span>
                        <span>فشل: <b className="text-red-400">{k.fail_count}</b></span>
                        <span>آخر استخدام: {fmtTime(k.last_used_at)}</span>
                      </div>
                      {k.last_error && (
                        <p dir="ltr" className="mt-1 truncate font-mono text-xs text-amber-500/90" title={k.last_error}>⚠ {k.last_error}</p>
                      )}
                    </li>
                  ))}
                </ul>
              )}
            </CardContent>
          </Card>

          {/* ============ ب) لوحة المهام ============ */}
          <Card className="border-slate-800/80 bg-card/70 backdrop-blur">
            <CardHeader className="pb-3">
              <CardTitle className="flex items-center gap-2 text-lg">
                <Activity className="size-5 text-violet-400" /> لوحة المهام
                <span className="ms-auto flex items-center gap-1 text-xs font-normal text-slate-500">
                  <Loader2 className="size-3 animate-spin" /> تحديث تلقائي كل 5 ثوانٍ
                </span>
              </CardTitle>
              <CardDescription>أحدث مهام التوليد والدمج مع التقدم الحي وروابط النتائج.</CardDescription>
            </CardHeader>
            <CardContent className="space-y-4">
              {/* شرائح الإحصائيات */}
              <div className="grid grid-cols-4 gap-2">
                {[
                  { label: "إجمالي", v: stats.total, cls: "text-slate-100" },
                  { label: "مكتملة", v: stats.completed, cls: "text-emerald-400" },
                  { label: "فاشلة", v: stats.failed, cls: "text-red-400" },
                  { label: "جارية", v: stats.processing, cls: "text-amber-400" },
                ].map((s) => (
                  <div key={s.label} className="rounded-xl border border-slate-800 bg-slate-950/60 p-3 text-center">
                    <div className={`text-2xl font-extrabold ${s.cls}`}>{s.v}</div>
                    <div className="text-xs text-slate-500">{s.label}</div>
                  </div>
                ))}
              </div>

              {/* القائمة */}
              {tasks.length === 0 ? (
                <p className="rounded-lg border border-dashed border-slate-700 p-6 text-center text-sm text-slate-500">
                  لا توجد مهام بعد — جرّب توليد صورة عبر أي عميل MCP أو أداة generate_image.
                </p>
              ) : (
                <ul className="max-h-96 space-y-3 overflow-y-auto pe-1">
                  {tasks.map((t) => {
                    const tm = typeMeta[t.type] ?? typeMeta.image;
                    const sm = statusMeta[t.status] ?? statusMeta.pending;
                    return (
                      <li key={t.id} className="rounded-xl border border-slate-800 bg-slate-950/60 p-3">
                        <div className="flex flex-wrap items-center gap-2">
                          <Badge variant="outline" className={`gap-1 ${tm.cls}`}>{tm.icon}{tm.label}</Badge>
                          <Badge variant="outline" className={sm.cls}>{sm.label}</Badge>
                          <code dir="ltr" className="font-mono text-[11px] text-slate-500">{t.model}</code>
                          <span className="ms-auto flex items-center gap-1 text-xs text-slate-500">
                            <Clock className="size-3" />{fmtTime(t.created_at)}
                          </span>
                        </div>
                        {t.prompt && <p className="mt-1.5 line-clamp-2 text-sm text-slate-300">{t.prompt}</p>}
                        {t.status === "processing" && (
                          <div className="mt-2">
                            <Progress value={t.progress} className="h-1.5 bg-slate-800 [&>div]:bg-gradient-to-l [&>div]:from-cyan-500 [&>div]:to-violet-500" />
                            <p className="mt-1 text-xs text-amber-400/90">{t.progress}% — قيد المعالجة</p>
                          </div>
                        )}
                        {t.status === "completed" && t.result_urls.length > 0 && (
                          <div className="mt-2 flex flex-wrap gap-2">
                            {t.result_urls.map((u) => (
                              <a key={u} href={u} target="_blank" rel="noreferrer"
                                className="inline-flex items-center gap-1 rounded-lg border border-cyan-500/30 bg-cyan-500/10 px-2.5 py-1 text-xs text-cyan-300 hover:bg-cyan-500/20">
                                <ExternalLink className="size-3" /> فتح النتيجة
                              </a>
                            ))}
                          </div>
                        )}
                        {t.status === "failed" && t.error_message && (
                          <p className="mt-1.5 rounded-lg border border-red-500/20 bg-red-500/5 p-2 text-xs text-red-300">{t.error_message}</p>
                        )}
                        <div className="mt-1.5 flex items-center gap-3 text-[11px] text-slate-500">
                          <span dir="ltr" className="font-mono">#{t.id.slice(0, 8)}</span>
                          <span>المحاولات: {t.attempts}</span>
                        </div>
                      </li>
                    );
                  })}
                </ul>
              )}
            </CardContent>
          </Card>

          {/* ============ ج) ربط السيرفر ============ */}
          <Card className="border-slate-800/80 bg-card/70 backdrop-blur lg:col-span-2">
            <CardHeader className="pb-3">
              <CardTitle className="flex items-center gap-2 text-lg">
                <Plug className="size-5 text-cyan-400" /> ربط السيرفر
              </CardTitle>
              <CardDescription>انسخ الإعداد المناسب لعميلك — الرابط يعمل مع أي عميل MCP يدعم Streamable HTTP.</CardDescription>
            </CardHeader>
            <CardContent className="space-y-5">
              {/* الرابط + نسخ */}
              <div className="flex items-center gap-2">
                <Input dir="ltr" readOnly value={mcpUrl} className="bg-slate-950 border-slate-700 font-mono text-sm" aria-label="رابط MCP" />
                <Button onClick={copyUrl} variant="outline" className="shrink-0 border-slate-700 bg-slate-950">
                  {copiedUrl ? <Check className="size-4 text-emerald-400" /> : <Copy className="size-4" />} نسخ الرابط
                </Button>
              </div>

              {/* تبويبات JSON */}
              <Tabs defaultValue="chatgpt">
                <TabsList className="bg-slate-950 border border-slate-800">
                  <TabsTrigger value="chatgpt">ChatGPT / GPT Agents</TabsTrigger>
                  <TabsTrigger value="claude">Claude Desktop</TabsTrigger>
                  <TabsTrigger value="cursor">Cursor / Windsurf / Cline</TabsTrigger>
                </TabsList>
                <TabsContent value="chatgpt" className="space-y-2">
                  <JsonBlock text={jsonChatgpt} />
                  <p className="text-xs leading-5 text-slate-400">
                    في ChatGPT: Settings → Connectors → Create → Custom MCP server — ضع الرابط أعلاه في حقل «Server URL».
                  </p>
                </TabsContent>
                <TabsContent value="claude" className="space-y-2">
                  <JsonBlock text={jsonClaude} />
                  <p className="text-xs leading-5 text-slate-400">
                    ضع هذا في ملف <code dir="ltr" className="font-mono">claude_desktop_config.json</code> ثم أعد فتح Claude Desktop.
                  </p>
                </TabsContent>
                <TabsContent value="cursor" className="space-y-2">
                  <JsonBlock text={jsonCursor} />
                  <p className="text-xs leading-5 text-slate-400">
                    ضع هذا في <code dir="ltr" className="font-mono">mcp.json</code> داخل إعدادات Cursor أو Windsurf أو Cline.
                  </p>
                </TabsContent>
              </Tabs>

              {/* رقائق الأدوات */}
              <div>
                <h3 className="mb-2 flex items-center gap-1.5 text-sm font-semibold text-slate-300">
                  <Server className="size-4 text-slate-400" /> الأدوات الخمس المتاحة
                </h3>
                <div className="flex flex-wrap gap-2">
                  {TOOLS_INFO.map((t) => (
                    <div key={t.name} className="rounded-xl border border-slate-800 bg-slate-950/60 px-3 py-2">
                      <code dir="ltr" className="font-mono text-xs font-bold text-cyan-300">{t.name}</code>
                      <p className="mt-0.5 text-[11px] leading-4 text-slate-400">{t.ar}</p>
                    </div>
                  ))}
                </div>
              </div>

              {/* الموديلات */}
              {health?.models?.length ? (
                <div className="flex flex-wrap gap-2 text-xs">
                  {health.models.map((m) => (
                    <Badge key={m.canonical} variant="outline" className="border-slate-700 bg-slate-950 font-mono text-slate-300" dir="ltr">
                      {m.canonical}
                    </Badge>
                  ))}
                </div>
              ) : null}

              {/* ملاحظة كهرمانية */}
              <div className="flex gap-2 rounded-xl border border-amber-500/30 bg-amber-500/10 p-3 text-sm leading-6 text-amber-200">
                <AlertTriangle className="mt-1 size-4 shrink-0 text-amber-400" />
                <p>
                  الفيديو يحتاج دقائق: يعيد السيرفر task_id فورًا، ويتابَع تلقائيًا بـ get_task كل 10 ثوانٍ — وعند اكتمال المهمة
                  يُعرض الرابط في الدردشة ويتوقف. أثناء الانتظار يُبَث تقدم حي (Progress notifications) حتى لا تنقطع العملية.
                </p>
              </div>
            </CardContent>
          </Card>
        </div>
      </div>
    </div>
  );
}
