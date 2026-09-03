import { getSetting, setSetting } from "../db";

// ============================================================
// السحب المباشر بجلسة الموقع (كوكي تسجيل الدخول)
// ============================================================
// بعض المواقع (مثل rokari comics) تبيع بعض فصولها؛ إضافة الخادم تخفي تلك
// الفصول ولا تعرفها إطلاقًا. هنا نكمل الصورة: عند وجود كوكي جلسة موثق
// لنطاق الموقع، يفحص العامل صفحة الفصل مباشرة — الفصل المقفل (المدفوع)
// يُسحب بحقن الكوكي، والفصل المجاني يمر عبر المسار المعتاد دون تغيير.
// الكوكي يُخزَّن في appSettings سرًا ولا يُعاد للواجهة أبدًا.
// ============================================================

/** المواقع المدعومة بالسحب المباشر حاليًا (بنية MangaThemesia بقارئ ts_reader). */
export const SUPPORTED_DIRECT_SOURCES = ["rokaricomics.com"] as const;

export type DirectSourceHostname = (typeof SUPPORTED_DIRECT_SOURCES)[number];

export class DirectSourceError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "DirectSourceError";
  }
}

export function isDirectSourceSupported(hostname: string | null | undefined): boolean {
  if (!hostname) return false;
  return (SUPPORTED_DIRECT_SOURCES as readonly string[]).includes(
    hostname.toLowerCase().replace(/^www\./, "")
  );
}

// ===== مخزن الجلسات (appSettings) =====

type DirectSessionEntry = { cookie: string; updatedAt: string };
type DirectSessions = Record<string, DirectSessionEntry>;

const DIRECT_SESSIONS_KEY = "direct_source_sessions";

/**
 * يقبل كوكي واحدًا (name=value) أو سطر Cookie كاملًا بعدة أزواج، ويعيده
 * مطبعًا كترويسة Cookie نظيفة. يرفض الفارغ والطويل والحامل لأسطر جديدة.
 */
export function normalizeCookieHeader(input: string): string | null {
  const cleaned = input.trim().replace(/^cookie\s*:\s*/i, "");
  if (!cleaned || cleaned.length > 4000 || /[\r\n]/.test(cleaned)) return null;
  const pairs = cleaned
    .split(";")
    .map(pair => pair.trim())
    .filter(pair => {
      const eq = pair.indexOf("=");
      return eq > 0 && !/\s/.test(pair.slice(0, eq));
    });
  if (!pairs.length) return null;
  return Array.from(new Set(pairs)).join("; ");
}

/** اسم الكوكي فقط (قبل =) — للعرض في اللوحة دون كشف القيمة. */
export function cookieDisplayName(cookie: string): string {
  const first = cookie.split(";")[0] ?? "";
  const name = first.slice(0, first.indexOf("="));
  return name ? `${name}…` : "كوكي جلسة";
}

async function readSessions(): Promise<DirectSessions> {
  const raw = await getSetting(DIRECT_SESSIONS_KEY);
  if (!raw) return {};
  try {
    const parsed = JSON.parse(raw) as Partial<DirectSessions>;
    const sessions: DirectSessions = {};
    for (const [hostname, entry] of Object.entries(parsed)) {
      if (typeof entry?.cookie === "string" && entry.cookie) {
        sessions[hostname.toLowerCase().replace(/^www\./, "")] = {
          cookie: entry.cookie,
          updatedAt: typeof entry.updatedAt === "string" ? entry.updatedAt : "",
        };
      }
    }
    return sessions;
  } catch {
    return {};
  }
}

export type DirectSessionSummary = { hostname: string; updatedAt: string };

/** قائمة الجلسات الموثقة للوحة — القيمة لا تُعاد إطلاقًا. */
export async function listDirectSessions(): Promise<DirectSessionSummary[]> {
  const sessions = await readSessions();
  return Object.entries(sessions)
    .map(([hostname, entry]) => ({ hostname, updatedAt: entry.updatedAt }))
    .sort((a, b) => a.hostname.localeCompare(b.hostname));
}

export async function getDirectSessionCookie(hostname: string): Promise<string | null> {
  const sessions = await readSessions();
  return sessions[hostname.toLowerCase().replace(/^www\./, "")]?.cookie ?? null;
}

export async function saveDirectSession(hostname: string, cookieInput: string): Promise<DirectSessionSummary> {
  if (!isDirectSourceSupported(hostname)) {
    throw new DirectSourceError("هذا الموقع غير مدعوم في السحب المباشر حاليًا.");
  }
  const cookie = normalizeCookieHeader(cookieInput);
  if (!cookie) {
    throw new DirectSourceError("صيغة الكوكي غير صالحة — الصقه كما هو من أدوات المطور (مثال: wordpress_logged_in_…=…).");
  }
  const sessions = await readSessions();
  const normalizedHost = hostname.toLowerCase().replace(/^www\./, "");
  const updatedAt = new Date().toISOString();
  sessions[normalizedHost] = { cookie, updatedAt };
  await setSetting(DIRECT_SESSIONS_KEY, JSON.stringify(sessions));
  return { hostname: normalizedHost, updatedAt };
}

export async function removeDirectSession(hostname: string): Promise<void> {
  const sessions = await readSessions();
  const normalizedHost = hostname.toLowerCase().replace(/^www\./, "");
  if (!sessions[normalizedHost]) return;
  delete sessions[normalizedHost];
  await setSetting(DIRECT_SESSIONS_KEY, JSON.stringify(sessions));
}

// ===== قارئ MangaThemesia/ts_reader المباشر =====

const BROWSER_UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36";

function chapterPageHeaders(cookie?: string): Record<string, string> {
  return {
    "user-agent": BROWSER_UA,
    accept: "text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8",
    "accept-language": "en-US,en;q=0.9",
    referer: "https://rokaricomics.com/",
    ...(cookie ? { cookie } : {}),
  };
}

async function fetchChapterHtml(chapterUrl: string, cookie?: string): Promise<string> {
  const parsed = new URL(chapterUrl);
  if (parsed.protocol !== "https:") {
    throw new DirectSourceError("السحب المباشر يقبل روابط HTTPS فقط.");
  }
  const response = await fetch(parsed, {
    headers: chapterPageHeaders(cookie),
    redirect: "follow",
    signal: AbortSignal.timeout(30_000),
  });
  if (!response.ok) {
    throw new DirectSourceError(`تعذر فتح صفحة الفصل من الموقع (${response.status}).`);
  }
  const contentType = response.headers.get("content-type")?.toLowerCase() ?? "";
  if (contentType && !contentType.includes("html")) {
    throw new DirectSourceError("استجابة الموقع ليست صفحة فصل.");
  }
  return response.text();
}

/** يستخرج أول مصدر قارئ يحمل صورًا — مصفوفة "images" داخل سكربت ts_reader. */
export function extractReaderImages(html: string): string[] {
  const matches = Array.from(html.matchAll(/"images"\s*:\s*(\[[^\]]*])/g));
  for (const match of matches) {
    try {
      const parsed = JSON.parse(match[1]!) as unknown;
      if (Array.isArray(parsed) && parsed.length) {
        const images = parsed.filter(
          (item): item is string => typeof item === "string" && /^https?:\/\//i.test(item)
        );
        if (images.length) return images;
      }
    } catch {
      /* مصدر تالف — نتابع إلى المصدر التالي إن وجد */
    }
  }
  return [];
}

/** علامات صفحة الفصل المقفل (مدفوع) — تظهر فقط حين لا توجد صور. */
export function isLockedChapterHtml(html: string): boolean {
  return (
    /this chapter is locked/i.test(html) ||
    /coin-amount/i.test(html) ||
    /lockedChapterModal/i.test(html)
  );
}

function decodeEntities(value: string): string {
  return value
    .replace(/&#x([0-9a-f]+);/gi, (_all, hex: string) =>
      String.fromCodePoint(Number.parseInt(hex, 16))
    )
    .replace(/&#(\d+);/g, (_all, dec: string) => String.fromCodePoint(Number(dec)))
    .replace(/&quot;/g, '"')
    .replace(/&#0?39;/g, "'")
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">");
}

/** عنوان الصفحة الخام بعد فك ترميز HTML. */
export function extractPageTitle(html: string): string {
  const raw = html.match(/<title[^>]*>\s*([^<]+?)\s*<\/title>/i)?.[1] ?? "";
  return decodeEntities(raw).trim();
}

/**
 * يفصل عنوان العمل عن اسم الفصل من عنوان الصفحة:
 * «Perfection is Everything Chapter 57 – rokari comics»
 * → العمل: Perfection is Everything، الفصل: Chapter 57.
 */
export function parseMangaChapterTitle(pageTitle: string): { mangaTitle: string; chapterName: string } {
  const title = pageTitle
    .replace(/\s*[\u2013\u2014|]\s*rokari\s*comics\s*$/i, "")
    .trim();
  const match = title.match(/^(.*?)\s*chapter\s*([\d.]+)\s*$/i);
  if (match?.[1]) {
    return { mangaTitle: match[1].trim(), chapterName: `Chapter ${match[2]}` };
  }
  return { mangaTitle: title, chapterName: "" };
}

export type DirectProbeMode = "free" | "locked" | "unknown";
export type DirectProbe = { mode: DirectProbeMode; images: string[] };

/**
 * فحص صفحة الفصل دون أي جلسة: فيه صور → مجاني (يمر عبر المسار المعتاد)،
 * مقفل بعلامات البيع → مدفوع (يُسحب بالجلسة)، وأي عطب أو حماية أخرى
 * → غير محسوم (المسار المعتاد آمنًا). الفحص قراءة فقط ولا يفشل السحب.
 */
export async function probeDirectChapterPage(chapterUrl: string): Promise<DirectProbe> {
  try {
    const html = await fetchChapterHtml(chapterUrl);
    const images = extractReaderImages(html);
    if (images.length) return { mode: "free", images };
    if (isLockedChapterHtml(html)) return { mode: "locked", images: [] };
    return { mode: "unknown", images: [] };
  } catch {
    return { mode: "unknown", images: [] };
  }
}

export type DirectChapterPages = {
  mangaTitle: string;
  chapterName: string;
  pages: string[];
};

/**
 * يجلب صفحات الفصل بحقن كوكي الجلسة الموثقة. صفحة الفصل المقفل تعيد قائمة
 * صورها فقط لصاحب الجلسة المصرح له — غياب الصور مع الكوكي يعني جلسة منتهية
 * أو فصلًا لم يُفتح في حساب الموقع، والرسالة توضح ذلك بدقة.
 */
export async function fetchDirectChapterWithSession(
  chapterUrl: string,
  cookie: string
): Promise<DirectChapterPages> {
  const html = await fetchChapterHtml(chapterUrl, cookie);
  const pages = extractReaderImages(html);
  if (!pages.length) {
    if (isLockedChapterHtml(html)) {
      throw new DirectSourceError(
        "الفصل ما يزال مقفلًا رغم الجلسة الموثقة — الجلسة منتهية أو الفصل غير مفتوح في حسابك بالموقع. حدّث كوكي الجلسة من لوحة التحكم أو افتح الفصل في الموقع أولًا."
      );
    }
    throw new DirectSourceError(
      "تعذر قراءة صفحات الفصل من صفحة الموقع مباشرة — ربما تغيّرت بنية القارئ. أبلغ المالك."
    );
  }
  const { mangaTitle, chapterName } = parseMangaChapterTitle(extractPageTitle(html));
  return {
    mangaTitle: mangaTitle || "العمل",
    chapterName: chapterName || "الفصل",
    pages,
  };
}
