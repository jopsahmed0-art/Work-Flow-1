/**
 * سجل المهايئات — نقطة التمديد الوحيدة لإضافة مزود جديد:
 *  1) أنشئ ملف المهايئ في src/lib/providers/
 *  2) سجّله هنا في adapterFor
 *  3) أضف المعرّف إلى ProviderId في models.ts وقائمة PROVIDERS في /api/keys
 *  4) أضفه لمصفوفة providers في الموديلات المناسبة (صور/فيديو) مع اسم الموديل لدى المزود
 * المزود "custom" يُبنى لكل مفتاح على حدة لأنه يحمل base_url خاصًا به.
 */
import type { ProviderAdapter, KeyMeta } from "./types";
import { kieAdapter } from "./kie";
import { cometapiAdapter } from "./cometapi";
import { nvidiaAdapter } from "./nvidia";
import { geminiAdapter } from "./gemini";
import { falAdapter } from "./fal";
import { replicateAdapter } from "./replicate";
import { customAdapter } from "./custom";

export function adapterFor(provider: string, meta?: KeyMeta): ProviderAdapter | null {
  switch (provider) {
    case "kie": return kieAdapter;
    case "cometapi": return cometapiAdapter;
    case "nvidia": return nvidiaAdapter;
    case "gemini": return geminiAdapter;
    case "fal": return falAdapter;
    case "replicate": return replicateAdapter;
    case "custom": return customAdapter(meta ?? {});
    default: return null;
  }
}
