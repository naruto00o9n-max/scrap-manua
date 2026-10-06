import { getSetting, setSetting } from "../db";
import { ENV } from "../_core/env";

/**
 * وسيط السحب (ScraperAPI):
 * مواقع المانجا تضع حماية Cloudflare ترفض أي طلب قادم من IP مركز بيانات
 * (403 أو تجميد الاتصال حتى انتهاء المهلة)، فتفشل خطوة سحب الصفحات كاملة
 * رغم أن «العثور على الفصل» يتم عبر خادم السحب بلا مشكلة.
 * الوسيط يمرر الطلبات من عناوين سكنية تتخطى الحماية — يُستخدم تلقائيًا
 * كملاذ أخير فقط عند فشل التنزيل المباشر، حفاظًا على رصيد المفتاح.
 * المفتاح سر: يُخزن في appSettings ولا يُعاد للواجهة أبدًا، مع بديل متغير بيئة.
 */

const SCRAPERAPI_KEY_SETTING = "scraperapi_key";
const SCRAPERAPI_KEY_UPDATED_AT_SETTING = "scraperapi_key_updated_at";
const SCRAPERAPI_ENDPOINT = "http://api.scraperapi.com/";

/** حد التزامن المسموح عبر الوسيط — خطة المفتاح تسمح بطلبات متزامنة محدودة. */
export const SCRAPERAPI_CONCURRENCY = 4;
/** المهلة الافتراضية لطلب عبر الوسيط — الصور المدمجة الطويلة قد تستغرق عشرات الثواني. */
export const SCRAPERAPI_TIMEOUT_MS = 120_000;

export type ScraperApiSource = "settings" | "env";
export type ScraperApiStatus = { configured: boolean; source: ScraperApiSource | null; updatedAt: string };

/** يطبع المفتاح: بلا أسطر جديدة أو مسافات زائدة، وطول عملي بين 8 و64 رمزًا. */
export function normalizeScraperApiKey(input: string): string | null {
  const cleaned = input.trim();
  if (!/^[\w-]{8,64}$/.test(cleaned)) return null;
  return cleaned;
}

export async function saveScraperApiKey(keyInput: string): Promise<ScraperApiStatus> {
  const key = normalizeScraperApiKey(keyInput);
  if (!key) {
    throw new Error("صيغة مفتاح ScraperAPI غير صالحة — الصق المفتاح كما هو من حسابك (سلسلة 8-64 رمزًا).");
  }
  const updatedAt = new Date().toISOString();
  await setSetting(SCRAPERAPI_KEY_SETTING, key);
  await setSetting(SCRAPERAPI_KEY_UPDATED_AT_SETTING, updatedAt);
  return { configured: true, source: "settings", updatedAt };
}

export async function removeScraperApiKey(): Promise<ScraperApiStatus> {
  await setSetting(SCRAPERAPI_KEY_SETTING, "");
  if (ENV.scraperApiKey) return { configured: true, source: "env", updatedAt: "" };
  return { configured: false, source: null, updatedAt: "" };
}

/** المفتاح الفعلي: القيمة المحفوظة من اللوحة أولًا ثم متغير البيئة. */
export async function getScraperApiKey(): Promise<{ key: string; source: ScraperApiSource } | null> {
  const stored = (await getSetting(SCRAPERAPI_KEY_SETTING))?.trim();
  if (stored) return { key: stored, source: "settings" };
  if (ENV.scraperApiKey) return { key: ENV.scraperApiKey, source: "env" };
  return null;
}

/** حالة الوسيط للوحة — بلا أي كشف لقيمة المفتاح. */
export async function getScraperApiStatus(): Promise<ScraperApiStatus> {
  const key = await getScraperApiKey();
  if (!key) return { configured: false, source: null, updatedAt: "" };
  if (key.source === "settings") {
    const updatedAt = (await getSetting(SCRAPERAPI_KEY_UPDATED_AT_SETTING)) ?? "";
    return { configured: true, source: "settings", updatedAt };
  }
  return { configured: true, source: "env", updatedAt: "" };
}

/** رابط الطلب عبر الوسيط: الهدف يُرمَّز كاملًا داخل باراميتر url. */
export function buildScraperApiUrl(targetUrl: string, key: string): string {
  const endpoint = new URL(SCRAPERAPI_ENDPOINT);
  endpoint.searchParams.set("api_key", key);
  endpoint.searchParams.set("url", targetUrl);
  return endpoint.toString();
}

/** بوابة تزامن بسيطة لضبط عدد الطلبات المتزامنة عبر الوسيط. */
export class Semaphore {
  private active = 0;
  private readonly waiters: Array<() => void> = [];

  constructor(private readonly limit: number) {}

  async acquire(): Promise<() => void> {
    if (this.active < this.limit) {
      this.active += 1;
      return () => this.release();
    }
    return new Promise<() => void>(resolve => {
      this.waiters.push(() => {
        this.active += 1;
        resolve(() => this.release());
      });
    });
  }

  private release(): void {
    this.active -= 1;
    const next = this.waiters.shift();
    if (next) next();
  }
}

export const scraperApiGate = new Semaphore(SCRAPERAPI_CONCURRENCY);

/** يمرر طلبًا عبر الوسيط مع احترام حد التزامن والمهلة. */
export async function fetchViaScraperApi(targetUrl: string, timeoutMs = SCRAPERAPI_TIMEOUT_MS): Promise<Response> {
  const keyInfo = await getScraperApiKey();
  if (!keyInfo) throw new Error("وسيط السحب غير مهيأ — أضف مفتاح ScraperAPI من اللوحة.");
  const release = await scraperApiGate.acquire();
  try {
    return await fetch(buildScraperApiUrl(targetUrl, keyInfo.key), {
      redirect: "follow",
      signal: AbortSignal.timeout(timeoutMs),
    });
  } finally {
    release();
  }
}

/** بصمات بداية الملفات الشائعة للصور — تحمي من حفظ صفحة تحدي HTML بدل الصورة. */
export function looksLikeImage(bytes: Uint8Array): boolean {
  if (bytes.length >= 3) {
    // JPEG
    if (bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return true;
    // GIF87a / GIF89a
    if (bytes[0] === 0x47 && bytes[1] === 0x49 && bytes[2] === 0x46) return true;
  }
  if (bytes.length >= 4) {
    // PNG
    if (bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47) return true;
  }
  if (bytes.length >= 8) {
    // RIFF....WEBP
    if (bytes[0] === 0x52 && bytes[1] === 0x49 && bytes[2] === 0x46 && bytes[3] === 0x46 && bytes[8] === 0x57 && bytes[9] === 0x45) return true;
  }
  if (bytes.length >= 8) {
    // ISO-BMFF: ----ftyp (AVIF / HEIC)
    if (bytes[4] === 0x66 && bytes[5] === 0x74 && bytes[6] === 0x79 && bytes[7] === 0x70) return true;
  }
  return false;
}
