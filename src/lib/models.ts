/**
 * سجل الموديلات — الأسماء الكانونية + الصيغ البديلة + المزودون المدعومون لكل موديل.
 * الأسماء قابلة للتجاوز بمتغيرات البيئة (KIE_IMAGE_MODEL، KIE_VIDEO_MODEL، COMETAPI_IMAGE_MODEL، COMETAPI_VIDEO_MODEL).
 */

export type ProviderId = "kie" | "cometapi" | "nvidia" | "gemini";
export type TaskProvider = ProviderId | "merger";
export type MediaType = "image" | "video" | "merge";

export interface ModelDef {
  canonical: string;                          // الاسم كما يراه عميل MCP
  aliases: string[];                          // صيغ بديلة نقبلها ونوحدّها
  type: MediaType;
  providers: ProviderId[];                    // تُجرَّب مفاتيح كل هؤلاء بالترتيب التسلسلي
  providerModel: Record<ProviderId, string>;  // اسم الموديل كما يُرسل لكل مزود
}

const KIE_IMAGE = process.env.KIE_IMAGE_MODEL || "gpt-image-2-6/flare-text-to-image";
const KIE_VIDEO = process.env.KIE_VIDEO_MODEL || "grok-imagine-video-1-5-preview";
const COMET_IMAGE = process.env.COMETAPI_IMAGE_MODEL || "gpt-image-2.6-flare-text-to-image";
const COMET_VIDEO = process.env.COMETAPI_VIDEO_MODEL || "grok-imagine-video-1-5-preview";
const NVIDIA_IMAGE = process.env.NVIDIA_IMAGE_MODEL || "black-forest-labs/flux.1-schnell";
const GEMINI_IMAGE = process.env.GEMINI_IMAGE_MODEL || "gemini-2.5-flash-image";

export const MODELS: ModelDef[] = [
  {
    canonical: "gpt-image-2-6/flare-text-to-image",
    aliases: ["gpt-image-2.6/flare-text-to-image", "gpt-image-2-6-flare-text-to-image", "gpt-image-2.6-flare-text-to-image"],
    type: "image",
    // الصور: مزودات sync الجديدة أولًا (أسرع نجاحًا مع المفاتيح المجانية) ثم kie ثم cometapi
    providers: ["nvidia", "gemini", "kie", "cometapi"],
    providerModel: { kie: KIE_IMAGE, cometapi: COMET_IMAGE, nvidia: NVIDIA_IMAGE, gemini: GEMINI_IMAGE },
  },
  {
    canonical: "grok-imagine-video-1-5-preview",
    aliases: ["grok-imagine-video-1.5-preview", "grok-imagine-video-1-5", "grok-imagine-video-1.5"],
    type: "video",
    providers: ["kie", "cometapi"],
    providerModel: { kie: KIE_VIDEO, cometapi: COMET_VIDEO, nvidia: "", gemini: "" },
  },
];

export function findModel(name: string): ModelDef | null {
  const n = (name || "").trim().toLowerCase().replace(/\s+/g, "");
  for (const m of MODELS) {
    if (m.canonical.toLowerCase() === n) return m;
    if (m.aliases.some((a) => a.toLowerCase() === n)) return m;
  }
  return null;
}

/** الأدوات المسموح بها في list_media وغيرها */
export const MERGE_MODEL = "video-merger";
