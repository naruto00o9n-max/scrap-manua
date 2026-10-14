// ============================================================
// قارئ Manga-Shi المباشر (manga-shi.org)
// ============================================================
// موقع روسي server-rendered (htmx + Alpine) بلا حماية Cloudflare
// وبلا أي إضافة Suwayomi معروفة — السحب كله مباشر من صفحات الموقع:
// - رابط الفصل: /manga/<العمل>/glava-<رقم>/ أو مع المجلد /manga/<العمل>/tom-<رقم>/glava-<رقم>/
//   والفصول الجزئية تظهر في المسار بصيغة glava-60-5 لاسم «Глава 60.5».
// - صفحة القارئ: <img class="reader-image …"> بترتيب الصفحات نفسه؛ الأولى
//   src حقيقي والبقية src علامة GIF شفافة مع data-src الحقيقي (تحميل مؤجل).
// - مسارات الصور نسبية (/media/chapters/…) وتُحل على أصل الموقع، وصور الموقع
//   نفسه تنزل بلا أي ترويسات خاصة (تحقق حي 200 image/webp بلا Referer).
// - بيانات العرض من JSON-LD BreadcrumbList المدمجة: آخر عنصر اسم الفصل
//   («Глава 111») وما قبله اسم العمل («Тайная служанка графа / …»).
// - عنوان الصفحة «<العمل> <N> глава читать онлайн — Mangashi» خطة بديلة.
// ============================================================

export const MANGASHI_HOSTS = ["manga-shi.org"] as const;

export const MANGASHI_BASE_URL = "https://manga-shi.org";

const BROWSER_UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36";

export function isMangashiHost(hostname: string | null | undefined): boolean {
  if (!hostname) return false;
  const normalized = hostname.toLowerCase().replace(/^www\./, "");
  return (MANGASHI_HOSTS as readonly string[]).includes(normalized);
}

/** فك ترميز HTML المحلي للعناوين (كيانات مسماة ورقمية). */
function decodeEntities(value: string): string {
  return value
    .replace(/&#x([0-9a-f]+);/gi, (_all, hex: string) =>
      String.fromCodePoint(Number.parseInt(hex, 16))
    )
    .replace(/&#(\d+);/g, (_all, dec: string) => String.fromCodePoint(Number(dec)))
    .replace(/&quot;/g, '"')
    .replace(/&#0?39;/g, "'")
    .replace(/&apos;/g, "'")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">");
}

/**
 * هل الرابط صفحة عمل في Manga-Shi (وليس صفحة فصل)؟
 * /manga/<العمل>/ وحدها — تُستخدم لإنتاج رسالة موجهة بدل رفض عام.
 */
export function isMangashiMangaPageUrl(input: string): boolean {
  try {
    const parsed = new URL(input.trim());
    if (!isMangashiHost(parsed.hostname)) return false;
    const segments = parsed.pathname.split("/").filter(Boolean);
    // [مanga, <slug>] فقط = صفحة عمل؛ أي عمق أكبر (tom-/glava-...) رابط فصل
    return segments.length === 2 && segments[0] === "manga";
  } catch {
    return false;
  }
}

/**
 * يتحقق أن الرابط صفحة فصل Manga-Shi صالحة ويعيدها مطبعًا (HTTPS، بلا
 * استعلام/هاش). يقبل الصيغ الثلاث: /manga/<slug>/glava-<n>/، و/tom-<v>/
 * بينهما، وبلا الشرطة الأخيرة.
 * يرجع null لأي مسار آخر (بما فيه صفحة العمل).
 */
export function parseMangashiChapterUrl(input: string): string | null {
  try {
    const parsed = new URL(input.trim());
    if (parsed.protocol !== "https:" || !isMangashiHost(parsed.hostname)) return null;
    // النطاق المعروض دائمًا بلا www — كي يتسق بصمة الرابط وتكرار الطلبات
    parsed.hostname = MANGASHI_HOSTS[0];
    const segments = parsed.pathname.split("/").filter(Boolean);
    // [manga, slug, glava-x] أو [manga, slug, tom-v, glava-x]
    if (segments.length < 3 || segments.length > 4) return null;
    if (segments[0] !== "manga") return null;
    const glava = segments[segments.length - 1]!;
    if (!/^glava-[a-z0-9._-]+$/i.test(glava)) return null;
    if (segments.length === 4 && !/^tom-[a-z0-9._-]+$/i.test(segments[2]!)) return null;
    parsed.hash = "";
    parsed.search = "";
    return parsed.toString();
  } catch {
    return null;
  }
}

/**
 * يستخرج صفحات الفصل من HTML القارئ بترتيبها الأصلي:
 * <img class="reader-image …" src="…"> حيث src الحقيقي للصفحة الأولى
 * وdata-src الحقيقي للبقية (src علامة GIF مؤجلة). المسارات النسبية
 * تُحل على أصل الموقع، وعلامات GIF تُتجاهل، وأي img آخر يحمل مسار
 * /media/chapters/ يُقبل أيضًا تحوطًا لتغيّر صنف القارئ.
 */
export function extractMangashiPages(html: string, baseUrl: string = MANGASHI_BASE_URL): string[] {
  const pages: string[] = [];
  for (const match of Array.from(html.matchAll(/<img\b[^>]*>/gi))) {
    const tag = match[0]!;
    const isReaderImage = /\bclass=["'][^"']*reader-image/.test(tag);
    const raw =
      tag.match(/\sdata-src=["']([^"']+)["']/i)?.[1] ??
      tag.match(/\ssrc=["']([^"']+)["']/i)?.[1] ??
      "";
    const decoded = decodeEntities(raw).trim();
    if (!decoded || /^data:/i.test(decoded)) continue;
    if (!isReaderImage && !decoded.includes("/media/chapters/")) continue;
    if (!/^https?:\/\//i.test(decoded) && !decoded.startsWith("/")) continue;
    try {
      const absolute = new URL(decoded, baseUrl).toString();
      if (!pages.includes(absolute)) pages.push(absolute);
    } catch {
      /* مسار تالف — نتابع إلى الصورة التالية */
    }
  }
  return pages;
}

export type MangashiEpisodeMeta = {
  mangaTitle: string;
  chapterName: string;
};

/**
 * يقرأ بيانات الفصل من JSON-LD BreadcrumbList المدمجة في صفحة القارئ:
 * آخر عنصر اسم الفصل («Глава 111») وما قبله اسم العمل.
 * يرجع null حين لا توجد كتلة مسار تنقل صالحة (ليست صفحة قارئ).
 */
export function extractMangashiEpisodeMeta(html: string): MangashiEpisodeMeta | null {
  type JsonLdBlock = {
    "@type"?: string;
    itemListElement?: Array<{ name?: unknown; position?: unknown }>;
  };
  const blocks: JsonLdBlock[] = [];
  for (const match of Array.from(
    html.matchAll(/<script[^>]*type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi)
  )) {
    try {
      const parsed = JSON.parse(match[1]!.trim()) as unknown;
      if (Array.isArray(parsed)) blocks.push(...(parsed as JsonLdBlock[]));
      else blocks.push(parsed as JsonLdBlock);
    } catch {
      /* كتلة تالفة — نتابع إلى التي تليها */
    }
  }
  for (const block of blocks) {
    if (block["@type"] !== "BreadcrumbList") continue;
    const items = Array.isArray(block.itemListElement) ? block.itemListElement : [];
    const named = items
      .filter(item => typeof item?.name === "string" && item.name.trim())
      .sort((a, b) => Number(a?.position ?? 0) - Number(b?.position ?? 0));
    if (named.length < 2) continue;
    const chapter = named[named.length - 1]!;
    const manga = named[named.length - 2]!;
    // عناصر المسار: الرئيسية، كتالوج، العمل، الفصل — الفصل آخرها والعمل ما قبله
    if (Number(chapter.position) < 3) continue;
    return {
      mangaTitle: decodeEntities(String(manga.name).trim()),
      chapterName: decodeEntities(String(chapter.name).trim()),
    };
  }
  return null;
}

/**
 * يفصل عنوان العمل عن اسم الفصل من عنوان صفحة Manga-Shi كخطة بديلة عند
 * غياب JSON-LD: «Тайная служанка графа 111 глава читать онлайн — Mangashi»
 * → العمل: Тайная служанка графа، الفصل: Глава 111.
 * الفصول الجزئية («60.5 глава») والمجلدات تُعالج بالنمط نفسه، و\b لا يعمل
 * مع الحروف السيريلية في JS — يُستخدم lookahead على فراغ/نهاية.
 */
export function parseMangashiTitle(pageTitle: string): MangashiEpisodeMeta {
  const cleaned = pageTitle
    .replace(/\s*[—–-]\s*Mangashi\s*$/i, "")
    .replace(/\s*читать онлайн[\s\S]*$/i, "")
    .trim();
  const match = cleaned.match(/^(.+?)\s+(\d+(?:[.,]\d+)?)\s+глава(?=\s|$)/i);
  if (match?.[1] && match[2]) {
    const number = match[2].replace(",", ".");
    return { mangaTitle: match[1].trim(), chapterName: `Глава ${number}` };
  }
  return { mangaTitle: cleaned, chapterName: "" };
}

function chapterPageHeaders(chapterUrl: string, cookie?: string): Record<string, string> {
  let referer = `${MANGASHI_BASE_URL}/`;
  try {
    referer = `${new URL(chapterUrl).origin}/`;
  } catch {
    /* الرابط صُدّق قبل الوصول إلى هنا — يبقى المرجع الافتراضي */
  }
  return {
    "user-agent": BROWSER_UA,
    accept: "text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8",
    "accept-language": "ru-RU,ru;q=0.9,en-US;q=0.8,en;q=0.7",
    referer,
    ...(cookie ? { cookie } : {}),
  };
}

export type MangashiOutcome =
  | { ok: true; mangaTitle: string; chapterName: string; pages: string[] }
  | { ok: false; locked: boolean; message: string };

/**
 * يجلب فصلًا من Manga-Shi مباشرة بصفحته ويعيد صيغة موحدة تحاكي باقي
 * الجالبات المباشرة (كوميكس/كوايكان): ok مع العناوين والصور، أو رسالة
 * عربية واضحة عند الفشل. لا يوجد قفل معروف في الموقع — أي صفحة قارئ بلا
 * صور تُعد عطبًا لحظيًا أو تغيّر بنية لا فصلًا مدفوعًا.
 */
export async function fetchMangashiChapter(
  chapterUrl: string,
  cookie?: string
): Promise<MangashiOutcome> {
  const canonical = parseMangashiChapterUrl(chapterUrl);
  if (!canonical) {
    if (isMangashiMangaPageUrl(chapterUrl)) {
      return {
        ok: false,
        locked: false,
        message:
          "هذا رابط عمل في Manga-Shi وليس رابط فصل — أرسل رابط الفصل المطلوب من صفحة العمل (مثل https://manga-shi.org/manga/<العمل>/glava-1/).",
      };
    }
    return {
      ok: false,
      locked: false,
      message:
        "رابط Manga-Shi غير مفهوم — الروابط المقبولة بصيغة https://manga-shi.org/manga/<العمل>/glava-<رقم>/ (وتُقبل روابط المجلدات بصيغة …/tom-<رقم>/glava-<رقم>/).",
    };
  }
  try {
    const response = await fetch(canonical, {
      headers: chapterPageHeaders(canonical, cookie),
      redirect: "follow",
      signal: AbortSignal.timeout(30_000),
    });
    if (!response.ok) {
      return {
        ok: false,
        locked: false,
        message: `تعذر فتح صفحة الفصل من Manga-Shi (${response.status}).`,
      };
    }
    const contentType = response.headers.get("content-type")?.toLowerCase() ?? "";
    if (contentType && !contentType.includes("html")) {
      return { ok: false, locked: false, message: "استجابة Manga-Shi ليست صفحة فصل." };
    }
    const html = await response.text();
    const pages = extractMangashiPages(html, canonical);
    if (!pages.length) {
      return {
        ok: false,
        locked: false,
        message:
          "صفحة قارئ Manga-Shi وصلت بلا أي صور — ربما الموقع مشغول أو تغيّرت بنية القارئ. أعد /فصل بعد قليل، وإن تكرر أبلغ المالك.",
      };
    }
    const meta = extractMangashiEpisodeMeta(html);
    const parsed = parseMangashiTitle(
      html.match(/<title[^>]*>\s*([^<]+?)\s*<\/title>/i)?.[1]
        ? decodeEntities(html.match(/<title[^>]*>\s*([^<]+?)\s*<\/title>/i)![1]!)
        : ""
    );
    return {
      ok: true,
      mangaTitle: meta?.mangaTitle || parsed.mangaTitle || "العمل",
      chapterName: meta?.chapterName || parsed.chapterName || "الفصل",
      pages,
    };
  } catch (error) {
    return {
      ok: false,
      locked: false,
      message:
        error instanceof Error && error.message
          ? `تعذر الوصول إلى Manga-Shi: ${error.message}`
          : "تعذر الوصول إلى Manga-Shi لعطب غير معروف.",
    };
  }
}
