/**
 * أنواع مشتركة لمهايئات المزودين. أي خطأ يُرمى كـ ProviderError ليُصنَّف لاحقًا في classifyProviderError.
 */

export interface ProviderError {
  status?: number;      // حالة HTTP المعلنة من المزود (أو رمز الجسم مثل kie body.code)
  bodyCode?: number;    // رمز داخل الجسم (kie يعيد HTTP 200 مع code حقيقي)
  message: string;
}

export class ProviderErrorImpl extends Error implements ProviderError {
  status?: number;
  bodyCode?: number;
  constructor(status: number | undefined, message: string, bodyCode?: number) {
    super(message);
    this.name = "ProviderError";
    this.status = status;
    this.bodyCode = bodyCode;
  }
}

export function isProviderError(e: unknown): e is ProviderErrorImpl {
  return e instanceof ProviderErrorImpl;
}

/** نداء fetch موحد بمهلة — أي فشل شبكة/مهلة يُرمى ProviderError بلا حالة (يُصنَّف temporary) */
export async function providerFetch(
  url: string,
  init: RequestInit & { timeoutMs?: number } = {}
): Promise<Response> {
  const { timeoutMs = 30000, ...rest } = init;
  try {
    return await fetch(url, { ...rest, signal: AbortSignal.timeout(timeoutMs) });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    throw new ProviderErrorImpl(undefined, `network: ${msg}`);
  }
}

export interface ProviderAdapter {
  /** مهمة غير متزامنة (فيديو، وبعض الصور): تعيد providerTaskId */
  createTask(key: string, model: string, input: Record<string, unknown>): Promise<{ providerTaskId: string }>;
  /** صور متزامنة إن كان المزود يدعمها (CometAPI تعيد النتيجة فورًا) */
  createImageSync?(key: string, model: string, input: Record<string, unknown>): Promise<{ urls: string[] }>;
  /** استعلام حالة مهمة جارية */
  checkTask(key: string, providerTaskId: string): Promise<{
    status: "processing" | "completed" | "failed";
    urls?: string[];
    error?: string;
    progress?: number;
  }>;
}
