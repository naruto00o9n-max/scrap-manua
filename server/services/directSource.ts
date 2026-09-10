import { getSetting, setSetting } from "../db";
import { fetchKakaoPageChapter } from "./kakaoPage";

// ============================================================
// السحب المباشر بجلسة الموقع (كوكي تسجيل الدخول)
// ============================================================
// بعض المواقع (مثل rokari comics) تبيع بعض فصولها؛ إضافة الخادم تخفي تلك
// الفصول ولا تعرفها إطلاقًا. هنا نكمل الصورة: عند وجود كوكي جلسة موثق
// لنطاق الموقع، يفحص العامل صفحة الفصل مباشرة — الفصل المقفل (المدفوع)
// يُسحب بحقن الكوكي، والفصل المجاني يمر عبر المسار المعتاد دون تغيير.
// الكوكي يُخزَّن في appSettings سرًا ولا يُعاد للواجهة أبدًا.
// ============================================================

/** المواقع المدعومة بالسحب المباشر حاليًا. */
export const SUPPORTED_DIRECT_SOURCES = [
  "rokaricomics.com",
  "shonenjumpplus.com",
  "wamanga.ru",
  "webtoons.com",
  "m.webtoons.com",
  "page.kakao.com",
] as const;

export type DirectSourceHostname = (typeof SUPPORTED_DIRECT_SOURCES)[number];

/**
 * نمط التوجيه لكل موقع:
 * - «session-only»: الفصل المجاني يمر عبر المسار المعتاد، والمقفل (المدفوع)
 *   وحده يُسحب مباشرة بجلية الموقع (سلوك rokari المعتمد).
 * - «direct-first»: صفحة الفصل تُقرأ مباشرة أولًا دائمًا ولا يمر الموقع عبر
 *   خادم السحب إطلاقًا — المتاح مجانًا تُستخدم صوره فورًا، والمدفوع يحتاج
 *   جلسة موثقة (شونين جامب+، وwamanga.ru وWEBTOON بلا إضافة معروفة وفصول
 *   المجانية فيها متاحة للزوار — وWEBTOON يُرسل له كوكي تجاوز بوابة العمر
 *   تلقائيًا، وصوره على CDN نافير تحتاج Referer يتكفل به أنبوب التنزيل).
 */
export type DirectSourceMode = "session-only" | "direct-first";

const DIRECT_SOURCE_MODES: Record<(typeof SUPPORTED_DIRECT_SOURCES)[number], DirectSourceMode> = {
  "rokaricomics.com": "session-only",
  "shonenjumpplus.com": "direct-first",
  "wamanga.ru": "direct-first",
  "webtoons.com": "direct-first",
  "m.webtoons.com": "direct-first",
  "page.kakao.com": "direct-first",
};

export function directSourceMode(hostname: string | null | undefined): DirectSourceMode | null {
  if (!hostname) return null;
  const normalized = hostname.toLowerCase().replace(/^www\./, "");
  return (SUPPORTED_DIRECT_SOURCES as readonly string[]).includes(normalized)
    ? DIRECT_SOURCE_MODES[normalized as DirectSourceHostname] ?? null
    : null;
}

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
 * يقبل كوكيًا واحدًا بأي صيغة عملية:
 * - «name=value» (صيغة ترويسة Cookie)
 * - «name value» كما يظهر السطر في نافذة أدوات المطور (مفصول بمسافة أو Tab)
 * - سطر Cookie كاملًا بعدة أزواج «a=1; b=2» وبخيار «Cookie: » المسبق
 * ويعيده مطبعًا كترويسة Cookie نظيفة. يرفض الفارغ والطويل والحامل لأسطر جديدة.
 */
export function normalizeCookieHeader(input: string): string | null {
  const cleaned = input.trim().replace(/^cookie\s*:\s*/i, "");
  if (!cleaned || cleaned.length > 4000 || /[\r\n]/.test(cleaned)) return null;
  const pairs = cleaned
    .split(";")
    .map(pair => {
      const trimmed = pair.trim();
      if (!trimmed) return "";
      // أدوات المطور تعرض «الاسم القيمة» بمسافة بدلًا من = — نحوّلها للصيغة
      // القياسية شرط أن يكون الاسم رمز كوكي صالحًا (ASCII) لا نصًا اعتباطيًا
      if (!trimmed.includes("=") && /\s/.test(trimmed)) {
        const separator = trimmed.search(/\s/);
        const name = trimmed.slice(0, separator);
        if (/^[A-Za-z0-9!#$%&'*+\-.^_`|~]+$/.test(name)) {
          return `${name}=${trimmed.slice(separator).replace(/^\s+/, "")}`;
        }
        return trimmed;
      }
      // إزالة المسافات الزائدة حول أول = فاصلة
      return trimmed.replace(/\s*=\s*/, "=");
    })
    .filter(pair => {
      const eq = pair.indexOf("=");
      return eq > 0 && !/\s/.test(pair.slice(0, eq));
    })
    .map(pair => `${pair.slice(0, pair.indexOf("="))}=${pair.slice(pair.indexOf("=") + 1)}`);
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

function chapterPageHeaders(chapterUrl: string, cookie?: string): Record<string, string> {
  let referer = "https://rokaricomics.com/";
  try {
    referer = `${new URL(chapterUrl).origin}/`;
  } catch {
    /* رابط مرفوض قبل الوصول إلى هنا — يبقى المرجع الافتراضي */
  }
  return {
    "user-agent": BROWSER_UA,
    accept: "text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8",
    "accept-language": "en-US,en;q=0.9",
    referer,
    ...(cookie ? { cookie } : {}),
  };
}

async function fetchChapterHtml(chapterUrl: string, cookie?: string): Promise<string> {
  const parsed = new URL(chapterUrl);
  if (parsed.protocol !== "https:") {
    throw new DirectSourceError("السحب المباشر يقبل روابط HTTPS فقط.");
  }
  const response = await fetch(parsed, {
    headers: chapterPageHeaders(chapterUrl, cookie),
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

// ===== قارئ WaManga (wamanga.ru — تطبيق SvelteKit) =====

export type WaMangaEpisodeMeta = {
  mangaTitle: string;
  chapterName: string;
  /** حالة الوصول المعلنة في JSON-LD — null حين لا تُعلن. */
  accessibleForFree: boolean | null;
};

/**
 * يستخرج صور صفحات الفصل من قارئ WaManga بترتيبها الأصلي:
 * الصفحة تحتوي <img class="reader-page …" src="https://wamanga.ru/app/uploads/…">
 * بترتيب الصفحات نفسه، بلا أي تشويش أو حماية — والصور نفسها تنزل بلا ترويسات.
 */
export function extractWaMangaPages(html: string): string[] {
  const images: string[] = [];
  for (const match of Array.from(html.matchAll(/<img\b[^>]*>/gi))) {
    const tag = match[0]!;
    if (!/\bclass=["'][^"']*reader-page/.test(tag)) continue;
    const src = tag.match(/\ssrc=["']([^"']+)["']/i)?.[1];
    if (src && /^https?:\/\//i.test(src)) images.push(src);
  }
  return images;
}

/**
 * يقرأ بيانات الفصل من JSON-LD المدمج في صفحة WaManga:
 * كتلة ComicIssue تحمل اسم العمل (isPartOf.name) وحالة الوصول،
 * وكتلة BreadcrumbList تحمل اسم الفصل وحده («Глава 59») في آخر عنصر.
 * يرجع null حين لا توجد أي من الكتلتين (ليست صفحة قارئ).
 */
export function extractWaMangaEpisodeMeta(html: string): WaMangaEpisodeMeta | null {
  type JsonLdBlock = {
    "@type"?: string;
    name?: unknown;
    isAccessibleForFree?: unknown;
    isPartOf?: { name?: unknown };
    itemListElement?: Array<{ name?: unknown; position?: unknown }>;
  };
  const blocks: JsonLdBlock[] = [];
  for (const match of Array.from(
    html.matchAll(
      /<script[^>]*type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi
    )
  )) {
    try {
      const parsed = JSON.parse(match[1]!.trim()) as unknown;
      if (Array.isArray(parsed)) blocks.push(...(parsed as JsonLdBlock[]));
      else blocks.push(parsed as JsonLdBlock);
    } catch {
      /* كتلة تالفة — نتابع إلى التي تليها */
    }
  }
  const issue = blocks.find(block => block["@type"] === "ComicIssue");
  const breadcrumb = blocks.find(block => block["@type"] === "BreadcrumbList");
  if (!issue && !breadcrumb) return null;
  const items = Array.isArray(breadcrumb?.itemListElement) ? breadcrumb.itemListElement : [];
  const last = items.length ? items[items.length - 1] : undefined;
  const mangaTitle =
    typeof issue?.isPartOf?.name === "string" && issue.isPartOf.name.trim()
      ? issue.isPartOf.name.trim()
      : "";
  // اسم الفصل من آخر عنصر في مسار التنقل أدق («Глава 59») من اسم ComicIssue
  // المركب («Одноклассник - Глава 59»)، ويسقط إلى المركب عند غيابه.
  const chapterName =
    typeof last?.name === "string" && last.name.trim()
      ? last.name.trim()
      : typeof issue?.name === "string" && issue.name.trim()
        ? issue.name.trim()
        : "";
  if (!mangaTitle && !chapterName) return null;
  const accessible =
    issue?.isAccessibleForFree === true
      ? true
      : issue?.isAccessibleForFree === false
        ? false
        : null;
  return { mangaTitle, chapterName, accessibleForFree: accessible };
}

/**
 * يفصل عنوان العمل عن اسم الفصل من عنوان صفحة WaManga كخطط بديلة عند غياب
 * JSON-LD: «Одноклассник — глава 59 читать онлайн | WaManga»
 * → العمل: Одноклассник، الفصل: Глава 59.
 */
export function parseWaMangaTitle(pageTitle: string): { mangaTitle: string; chapterName: string } {
  const cleaned = pageTitle
    .replace(/\s*\|\s*WaManga\s*$/i, "")
    .replace(/\s*читать онлайн[\s\S]*$/i, "")
    .trim();
  const parts = cleaned.split(/\s+[—–-]\s+/);
  if (parts.length >= 2) {
    const chapterRaw = parts.pop()!.trim();
    return {
      mangaTitle: parts.join(" — ").trim(),
      // \b لا يعمل مع الحروف السيريلية في JS — نستخدم lookahead على فراغ/نهاية
      chapterName: chapterRaw.replace(/^(глава)(?=\s|$)/i, "Глава"),
    };
  }
  return { mangaTitle: cleaned, chapterName: "" };
}

/** بيانات عرض مكتملة لفصل WaManga بعد دمج المصادر المتاحة. */
function resolveWaMangaChapter(
  html: string,
  pages: string[]
): { mangaTitle: string; chapterName: string; pages: string[] } {
  const meta = extractWaMangaEpisodeMeta(html);
  const parsed = parseWaMangaTitle(extractPageTitle(html));
  return {
    mangaTitle: meta?.mangaTitle || parsed.mangaTitle || "العمل",
    chapterName: meta?.chapterName || parsed.chapterName || "الفصل",
    pages,
  };
}

// ===== قارئ GigaViewer (شونين جامب+ ومنصات شوئيشا) =====

export type GigaViewerEpisode = {
  pages: string[];
  mangaTitle: string;
  chapterName: string;
};

/**
 * يقرأ كتلة بيانات القارئ المدمجة في صفحة الفصل:
 * <script id="episode-json" type="text/json" data-value="{...JSON مُهرّب HTML}">
 * صفحات القارئ نوعها main وحدها تحمل روابط الصور، وعندما يكون الصف مشوشًا
 * (choJuGiga = "baku") تُؤشر روابطه بـ #scramble ليفكّها أنبوب الدمج
 * بنفس خوارزمية إضافة Mihon (قلب شبكة 4×4 من الكتل).
 * يرجع null حين لا توجد كتلة episode-json أصلًا (ليست صفحة قارئ).
 */
export function extractGigaViewerEpisode(html: string): GigaViewerEpisode | null {
  const marker = html.match(
    /<script\s+id=["']?episode-json["']?\s+type=["']?text\/json["']?\s+data-value=["']([^"']*)["']/i
  ) ?? html.match(/<script[^>]*id=["']?episode-json["']?[^>]*data-value=["']([^"']*)["']/i);
  if (!marker) return null;
  try {
    const raw = marker[1]!
      .replace(/&quot;/g, '"')
      .replace(/&#0?39;/g, "'")
      .replace(/&apos;/g, "'")
      .replace(/&lt;/g, "<")
      .replace(/&gt;/g, ">")
      .replace(/&amp;/g, "&");
    const data = JSON.parse(raw) as {
      readableProduct?: {
        title?: string;
        series?: { title?: string };
        pageStructure?: {
          choJuGiga?: string;
          pages?: Array<{ type?: string; src?: string }>;
        };
      };
    } | null;
    const product = data?.readableProduct;
    if (!product) return null;
    const scrambled = product.pageStructure?.choJuGiga === "baku";
    const pages = (product.pageStructure?.pages ?? [])
      .filter(page => page.type === "main" && typeof page.src === "string" && /^https?:\/\//i.test(page.src))
      .map(page => (scrambled ? `${page.src}#scramble` : page.src!));
    const chapterName = product.title?.trim() || "";
    const mangaTitle = product.series?.title?.trim() || "Shonen Jump+";
    return { pages, mangaTitle, chapterName };
  } catch {
    return null;
  }
}

/**
 * علامة الفصل المقفل في GigaViewer: كتلة القارئ موجودة لكن بلا بنية صفحات
 * — هذا بالضبط شكل الفصل المدفوع غير المشترى (يجيب Mihon برسالة الشراء).
 */
export function isGigaViewerLockedEpisode(html: string): boolean {
  if (!/episode-json/i.test(html)) return false;
  const episode = extractGigaViewerEpisode(html);
  return !episode || episode.pages.length === 0;
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

// ===== قارئ WEBTOON (webtoons.com وm.webtoons.com) =====

/**
 * كوكي تجاوز بوابة التحقق من العمر في WEBTOON — الموقع نفسه يضبطه بعد
 * موافقة الزائر، وإرساله مقدمًا يفتح الفصول المقيدة بلا أي صفحة تحقق.
 */
export const WEBTOONS_AGE_COOKIE = "needAgeVerified=true";

export function isWebtoonsHost(host: string): boolean {
  return host === "webtoons.com" || host === "m.webtoons.com";
}

/**
 * يستخرج صفحات قارئ WEBTOON بترتيبها الأصلي:
 * <img class="_images" data-url="https://webtoon-phinf.pstatic.net/…">
 * الروابط الحقيقية في data-url (src مجرد placeholder معطل)، والكيانات HTML
 * تُفك قبل الإرجاع، وأي صورة بلا data-url تسقط إلى src إن كانت مطلقة.
 * الصور نفسها ترفض الطلبات المجردة (403) وتكفيها ترويسة متصفح وReferer —
 * يتكفل بها أنبوب التنزيل في imageMerging.
 */
export function extractWebtoonsPages(html: string): string[] {
  const pages: string[] = [];
  for (const match of Array.from(html.matchAll(/<img\b[^>]*>/gi))) {
    const tag = match[0]!;
    if (!/\bclass=["'][^"]*\b_images\b/.test(tag)) continue;
    const raw = tag.match(/\sdata-url=["']([^"]+)["']/i)?.[1] ?? tag.match(/\ssrc=["']([^"]+)["']/i)?.[1];
    const url = raw ? decodeEntities(raw) : "";
    if (url && /^https?:\/\//i.test(url)) pages.push(url);
  }
  return pages;
}

/**
 * يفصل عنوان العمل عن اسم الفصل من عنوان صفحة WEBTOON:
 * «Ep. 133 - 151 | Falling In Love With My Ex-fiance's Grandfather»
 * → العمل: Falling In Love…، الفصل: Ep. 133 - 151.
 * يتعامل أيضًا مع لاحقة العلامة العامة «| WEBTOON» إن ظهرت، ومع صيغة
 * og:title الاحتياطية «العمل - Ep. 133» (بترميز كيانات مزدوج أحيانًا).
 */
export function parseWebtoonsTitle(pageTitle: string): { mangaTitle: string; chapterName: string } {
  // بعض الحقول (og:title) ترمّز الكيانات مرتين — فك ثانٍ غير ضار لعناوين نظيفة
  const title = decodeEntities(decodeEntities(pageTitle)).trim();
  const segments = title.split(/\s*\|\s*/).filter(Boolean);
  if (segments.length >= 2) {
    let mangaTitle = segments[segments.length - 1]!.trim();
    let chapterName = segments.slice(0, -1).join(" | ").trim();
    if (/^webtoon$/i.test(mangaTitle) && segments.length >= 3) {
      mangaTitle = segments[segments.length - 2]!.trim();
      chapterName = segments.slice(0, -2).join(" | ").trim();
    }
    if (mangaTitle && chapterName) return { mangaTitle, chapterName };
  }
  const dashed = title.match(/^(.+?)\s+-\s+(Ep\.\s*[\d.]+.*)$/i);
  if (dashed?.[1] && dashed[2]) return { mangaTitle: dashed[1].trim(), chapterName: dashed[2].trim() };
  return { mangaTitle: title, chapterName: "" };
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
export type DirectProbe = {
  mode: DirectProbeMode;
  /** الفصل كاملًا (العناوين والصور) حين يكون متاحًا مباشرة بلا جلسة. */
  chapter: DirectChapterPages | null;
  /** السبب المرصود لعدم الحسم (رمز الاستجابة/رسالة العطب) — يظهر في سجل المحاولات. */
  reason?: string;
};

function chapterHost(chapterUrl: string): string {
  try {
    return new URL(chapterUrl).hostname.toLowerCase().replace(/^www\./, "");
  } catch {
    return "";
  }
}

/**
 * فحص صفحة الفصل دون أي جلسة، واعي بالموقع:
 * - GigaViewer (شونين جامب+): صور متاحة → مجاني مع جلبها فورًا، كتلة القارئ
 *   بلا بنية صفحات → مدفوع، وأي عطب → غير محسوم.
 * - MangaThemesia (rokari): صور → مجاني، علامات البيع → مدفوع، وإلا غير محسوم.
 * الفحص قراءة فقط ولا يفشل السحب.
 */
export async function probeDirectChapterPage(chapterUrl: string): Promise<DirectProbe> {
  try {
    const host = chapterHost(chapterUrl);
    // كاكاو بيج لا يحتاج فحص HTML أصلًا — واجهة bff الرسمية تحسم كل شيء
    // (العناوين والصور والفصل المدفوع) من جهة الزائر للفصول المجانية.
    if (host === "page.kakao.com") {
      const outcome = await fetchKakaoPageChapter(chapterUrl);
      if (outcome.ok) {
        return {
          mode: "free",
          chapter: {
            mangaTitle: outcome.mangaTitle,
            chapterName: outcome.chapterName || "الفصل",
            pages: outcome.pages,
          },
        };
      }
      if (outcome.locked) return { mode: "locked", chapter: null };
      return { mode: "unknown", chapter: null, reason: outcome.message };
    }
    // بوابة العمر في WEBTOON تُتجاوز بكوكي الموقع نفسه — يُرسل مقدمًا دائمًا.
    const html = await fetchChapterHtml(chapterUrl, isWebtoonsHost(host) ? WEBTOONS_AGE_COOKIE : undefined);
    if (host === "wamanga.ru") {
      const pages = extractWaMangaPages(html);
      if (pages.length) {
        return { mode: "free", chapter: resolveWaMangaChapter(html, pages) };
      }
      // صفحة قارئ بلا صور: إن أعلن الموقع أن الفصل غير مجاني فهو مدفوع،
      // وإلا فالحالة غير محسومة (عطب لحظي أو تغيّر بنية).
      const meta = extractWaMangaEpisodeMeta(html);
      if (meta?.accessibleForFree === false) return { mode: "locked", chapter: null };
      return { mode: "unknown", chapter: null, reason: "صفحة قارئ WaManga وصلت بلا صور ولا إعلان مدفوع" };
    }
    if (host === "shonenjumpplus.com") {
      const episode = extractGigaViewerEpisode(html);
      if (episode?.pages.length) {
        return {
          mode: "free",
          chapter: {
            mangaTitle: episode.mangaTitle,
            chapterName: episode.chapterName || "الفصل",
            pages: episode.pages,
          },
        };
      }
      if (isGigaViewerLockedEpisode(html)) return { mode: "locked", chapter: null };
      return { mode: "unknown", chapter: null, reason: "صفحة GigaViewer وصلت بلا بنية صفحات ولا علامة قفل" };
    }
    if (isWebtoonsHost(host)) {
      let pages = extractWebtoonsPages(html);
      let pageTitle = extractPageTitle(html);
      // m.webtoons.com قد يستجيب لبعض الشبكات باستجابة محمية/فارغة حيث يستجيب
      // www.webtoons.com طبيعيًا — إعادة محاولة واحدة على نطاق www قبل عدم الحسم.
      if (!pages.length && host === "m.webtoons.com") {
        try {
          const wwwUrl = new URL(chapterUrl);
          wwwUrl.hostname = "www.webtoons.com";
          const wwwHtml = await fetchChapterHtml(wwwUrl.toString(), WEBTOONS_AGE_COOKIE);
          pages = extractWebtoonsPages(wwwHtml);
          if (pages.length) pageTitle = extractPageTitle(wwwHtml);
        } catch {
          /* إعادة المحاولة فشلت — تبقى الحالة كما عُينت أولًا */
        }
      }
      if (pages.length) {
        const { mangaTitle, chapterName } = parseWebtoonsTitle(pageTitle);
        return {
          mode: "free",
          chapter: {
            mangaTitle: mangaTitle || "العمل",
            chapterName: chapterName || "الفصل",
            pages,
          },
        };
      }
      // بلا صور: فصل مدفوع (Fast Pass) أو عطب لحظي أو استجابة محمية للعنوان
      // الشبكي للبوت — غير محسوم، والمحاولة تعاد مرة واحدة قبل الانتقال
      // إلى مسار خادم السحب إن كان متاحًا.
      return {
        mode: "unknown",
        chapter: null,
        reason: "صفحة قارئ WEBTOON وصلت بلا أي صور (فصل مدفوع Fast Pass أو استجابة غير متوقعة من الموقع)",
      };
    }
    const images = extractReaderImages(html);
    if (images.length) {
      const { mangaTitle, chapterName } = parseMangaChapterTitle(extractPageTitle(html));
      return {
        mode: "free",
        chapter: {
          mangaTitle: mangaTitle || "العمل",
          chapterName: chapterName || "الفصل",
          pages: images,
        },
      };
    }
    if (isLockedChapterHtml(html)) return { mode: "locked", chapter: null };
    return { mode: "unknown", chapter: null, reason: "لا صور قارئ ولا علامة قفل في الصفحة" };
  } catch (error) {
    return {
      mode: "unknown",
      chapter: null,
      reason: error instanceof Error && error.message ? error.message : "عطب غير معروف أثناء فتح الصفحة",
    };
  }
}

export type DirectChapterPages = {
  mangaTitle: string;
  chapterName: string;
  pages: string[];
};

/**
 * يجلب صفحات الفصل بحقن كوكي الجلسة الموثقة، واعي بالموقع:
 * - rokari (MangaThemesia): صور القارئ تُستخرج من ts_reader، وغيابها مع
 *   علامات القفل يعني جلسة منتهية أو فصلًا لم يُفتح في حساب الموقع.
 * - شونين جامب+ (GigaViewer): بلا بنية صفحات رغم الجلسة يعني جلسة منتهية
 *   أو فصلًا غير مشترى/مستأجر في حساب الموقع.
 */
export async function fetchDirectChapterWithSession(
  chapterUrl: string,
  cookie: string
): Promise<DirectChapterPages> {
  const host = chapterHost(chapterUrl);
  // كاكاو بيج: الجلسة كوكي حساب كاكاو (يضبطه المالك من لوحة التحكم) —
  // تُمرّر لواجهة viewer/data لمحاولة الفصول المدفوعة بحساب موثق، وبلا
  // نجاح يُرفض الفصل برسالة واضحة (بعض الفصول تشترى من التطبيق فقط).
  if (host === "page.kakao.com") {
    const outcome = await fetchKakaoPageChapter(chapterUrl, cookie);
    if (outcome.ok) {
      return {
        mangaTitle: outcome.mangaTitle,
        chapterName: outcome.chapterName || "الفصل",
        pages: outcome.pages,
      };
    }
    throw new DirectSourceError(
      outcome.locked
        ? "الفصل ما يزال مدفوعًا رغم الجلسة الموثقة — الجلسة منتهية أو الفصل غير مشترى/غير مفتوح في حساب كاكاو. حدّث كوكي الجلسة من لوحة التحكم أو افتح الفصل أولًا."
        : outcome.message
    );
  }
  const html = await fetchChapterHtml(
    chapterUrl,
    isWebtoonsHost(host) && !cookie ? WEBTOONS_AGE_COOKIE : cookie
  );
  if (host === "wamanga.ru") {
    const pages = extractWaMangaPages(html);
    if (!pages.length) {
      const meta = extractWaMangaEpisodeMeta(html);
      if (meta?.accessibleForFree === false) {
        throw new DirectSourceError(
          "الفصل ما يزال مقفلًا رغم الجلسة الموثقة — الجلسة منتهية أو الفصل غير مفتوح في حسابك بالموقع. حدّث كوكي الجلسة من لوحة التحكم أو افتح الفصل في الموقع أولًا."
        );
      }
      throw new DirectSourceError(
        "تعذر قراءة صفحات الفصل من صفحة الموقع مباشرة — ربما تغيّرت بنية القارئ. أبلغ المالك."
      );
    }
    const chapter = resolveWaMangaChapter(html, pages);
    return chapter;
  }
  if (host === "shonenjumpplus.com") {
    const episode = extractGigaViewerEpisode(html);
    if (!episode?.pages.length) {
      if (/episode-json/i.test(html)) {
        throw new DirectSourceError(
          "الفصل ما يزال مقفلًا رغم الجلسة الموثقة — الجلسة منتهية أو الفصل غير مشترى/مستأجر في حسابك بالموقع. حدّث كوكي الجلسة من لوحة التحكم أو افتح الفصل في الموقع أولًا."
        );
      }
      throw new DirectSourceError(
        "تعذر قراءة صفحة الفصل من الموقع مباشرة — ربما غيّر الموقع بنية قارئه. أبلغ المالك."
      );
    }
    return {
      mangaTitle: episode.mangaTitle || "العمل",
      chapterName: episode.chapterName || "الفصل",
      pages: episode.pages,
    };
  }
  if (isWebtoonsHost(host)) {
    const pages = extractWebtoonsPages(html);
    if (!pages.length) {
      throw new DirectSourceError(
        "تعذر قراءة صفحات الفصل من صفحة الموقع مباشرة — ربما تغيّرت بنية القارئ أو أن الفصل مدفوع في حساب الموقع. أبلغ المالك."
      );
    }
    const { mangaTitle, chapterName } = parseWebtoonsTitle(extractPageTitle(html));
    return {
      mangaTitle: mangaTitle || "العمل",
      chapterName: chapterName || "الفصل",
      pages,
    };
  }
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
