import {
  extractPageTitle,
  extractReaderImages,
  fetchChapterHtml,
  isLockedChapterHtml,
  parseMangaChapterTitle,
} from "./directSource";

// ============================================================
// شراء الفصول المقفلة في rokari comics بعملات الحساب الموثق
// ============================================================
// صفحة الفصل المقفل تحمل زر «Buy now» يستدعي buyChapter(<post id>)
// ويرسل POST إلى wp-admin/admin-ajax.php بمعطيات action=buy_chapter
// وid وnonce — والـ nonce يُولَّد داخل صفحة الفصل نفسها لكل جلسة.
// هنا نعيد نفس نداء الموقع حرفيًا بجلية الحساب الموثقة من لوحة
// التحكم: الفصل يُشترى من رصيد عملاته ثم يُسحب كأي فصل مفتوح.
// ============================================================

const REQUEST_TIMEOUT_MS = 20_000;
const BROWSER_UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36";

/** معطيات الشراء كما تظهر في صفحة الفصل المقفل. */
export type RokariBuyOffer = {
  /** معرّف الفصل في الموقع — معامل زر الشراء. */
  chapterPostId: string;
  /** مفتاح التحقق المولَّد للجلسة داخل الصفحة. */
  nonce: string;
  /** سعر الفصل بالعملات إن ظهر في الصفحة. */
  coinCost: number | null;
};

/**
 * يستخرج معطيات الشراء من HTML صفحة الفصل المقفل — يعيد null إذا غاب
 * زر الشراء أو مفتاح التحقق (بنية متغيرة أو صفحة ليست مقفلًا قابلًا للشراء).
 */
export function parseRokariBuyOffer(html: string): RokariBuyOffer | null {
  const idMatch = html.match(/buyChapter\((\d+)\)/);
  const nonceMatch = html.match(
    /action:\s*"buy_chapter"\s*,\s*id:\s*(?:id|\d+)\s*,\s*nonce:\s*"([0-9a-fA-F]+)"/
  );
  if (!idMatch?.[1] || !nonceMatch?.[1]) return null;
  const priceMatch = html.match(/coin-amount">\s*(\d+)\s*</);
  return {
    chapterPostId: idMatch[1]!,
    nonce: nonceMatch[1]!,
    coinCost: priceMatch?.[1] ? Number(priceMatch[1]) : null,
  };
}

export type RokariBuyOutcome =
  | { ok: true }
  | {
      ok: false;
      /** session: الجلسة منتهية — balance: الرصيد لا يكفي — site: رفض صريح — unexpected: استجابة غير مفهومة. */
      kind: "session" | "balance" | "site" | "unexpected";
      message: string;
    };

/**
 * يصنف استجابة نداء الشراء — نقية وقابلة للاختبار: JSON نجاح، JSON رفض
 * برسالة الموقع (دخول/رصيد/أخرى)، أو نص غير مفهوم (0/‏-1/HTML) بمعنى
 * جلسة منتهية غالبًا لأن مفتاح التحقق صار غير صالح.
 */
export function classifyRokariBuyResponse(status: number, bodyText: string): RokariBuyOutcome {
  void status;
  const text = (bodyText ?? "").trim();
  let parsed: { success?: boolean; data?: unknown } | null = null;
  if (text.startsWith("{")) {
    try {
      parsed = JSON.parse(text) as { success?: boolean; data?: unknown };
    } catch {
      parsed = null;
    }
  }
  if (parsed?.success === true) return { ok: true };
  let siteMessage = "";
  if (typeof parsed?.data === "string") siteMessage = parsed.data;
  else if (
    parsed?.data &&
    typeof parsed.data === "object" &&
    typeof (parsed.data as { message?: unknown }).message === "string"
  ) {
    siteMessage = (parsed.data as { message: string }).message;
  }
  const haystack = `${siteMessage} ${text}`.toLowerCase();
  if (/log ?in|logged|sign ?in/.test(haystack)) {
    return {
      ok: false,
      kind: "session",
      message:
        "جلية الموقع منتهية أو غير موثقة — حدّث كوكي الجلسة من لوحة التحكم ثم أعد /فصل.",
    };
  }
  if (/coin|balance|enough|credit/.test(haystack)) {
    return {
      ok: false,
      kind: "balance",
      message: `رصيد عملات الحساب في الموقع لا يكفي لشراء هذا الفصل${siteMessage ? ` — قال الموقع: ${siteMessage}` : ""}. اشحن الرصيد من صفحة الباقات ثم أعد /فصل.`,
    };
  }
  if (parsed?.success === false) {
    return {
      ok: false,
      kind: "site",
      message: `رفض الموقع شراء الفصل${siteMessage ? `: ${siteMessage}` : " بدون سبب واضح."}`,
    };
  }
  return {
    ok: false,
    kind: "unexpected",
    message:
      "رفض الموقع طلب الشراء — جلية الموقع غالبًا منتهية. حدّث كوكي الجلسة من لوحة التحكم ثم أعد /فصل.",
  };
}

export type RokariLockedInspection =
  | { state: "accessible" }
  | { state: "locked"; offer: RokariBuyOffer; mangaTitle: string; chapterName: string }
  | { state: "other"; reason?: string };

/**
 * يفحص صفحة الفصل بجلية الحساب الموثقة:
 * - accessible: الصفحات ظاهرة (الفصل مفتوح في الحساب) — لا حاجة لأي شراء.
 * - locked: صفحة قفل عليها زر شراء قابل للقراءة مع معطياته كاملة.
 * - other: أي حالة أخرى (عطب شبكة/بنية متغيرة) — السحب العادي يعرض سببها.
 */
export async function inspectRokariLockedChapter(
  chapterUrl: string,
  cookie: string
): Promise<RokariLockedInspection> {
  try {
    const html = await fetchChapterHtml(chapterUrl, cookie);
    if (extractReaderImages(html).length) return { state: "accessible" };
    if (!isLockedChapterHtml(html)) {
      return { state: "other", reason: "صفحة الفصل وصلت بلا صور وبلا علامة قفل" };
    }
    const offer = parseRokariBuyOffer(html);
    if (!offer) {
      return { state: "other", reason: "صفحة القفل وصلت بلا زر شراء قابل للقراءة" };
    }
    const { mangaTitle, chapterName } = parseMangaChapterTitle(extractPageTitle(html));
    return { state: "locked", offer, mangaTitle, chapterName };
  } catch (error) {
    return {
      state: "other",
      reason:
        error instanceof Error && error.message
          ? error.message
          : "عطب غير معروف أثناء فتح صفحة الفصل",
    };
  }
}

/**
 * يشتري الفصل بعملات الحساب — نداء مطابق لزر «Buy now» في الموقع:
 * POST إلى wp-admin/admin-ajax.php بمعطيات الزر نفسها وبجلية الحساب.
 */
export async function purchaseRokariChapter(
  chapterUrl: string,
  offer: RokariBuyOffer,
  cookie: string
): Promise<RokariBuyOutcome> {
  let endpoint: URL;
  try {
    endpoint = new URL("/wp-admin/admin-ajax.php", chapterUrl);
  } catch {
    return { ok: false, kind: "unexpected", message: "رابط الفصل غير صالح." };
  }
  try {
    const response = await fetch(endpoint, {
      method: "POST",
      headers: {
        "content-type": "application/x-www-form-urlencoded; charset=UTF-8",
        "user-agent": BROWSER_UA,
        accept: "*/*",
        "x-requested-with": "XMLHttpRequest",
        origin: endpoint.origin,
        referer: chapterUrl,
        cookie,
      },
      body: new URLSearchParams({
        action: "buy_chapter",
        id: offer.chapterPostId,
        nonce: offer.nonce,
      }).toString(),
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
    return classifyRokariBuyResponse(response.status, await response.text());
  } catch (error) {
    return {
      ok: false,
      kind: "unexpected",
      message: `تعذر الوصول إلى الموقع أثناء الشراء: ${error instanceof Error && error.message ? error.message : "خطأ شبكة غير معروف"}`,
    };
  }
}
