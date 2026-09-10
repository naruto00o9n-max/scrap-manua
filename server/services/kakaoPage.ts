// ============================================================
// كاكاو بيج (page.kakao.com) — سحب الفصول المجانية مباشرة
// ============================================================
// كاكاو بيج غير موجود في خادم السحب (Suwayomi) بلا إضافة، لكن واجهة
// bff-page.kakao.com الرسمية التي يستخدمها موقع الويب نفسه تعمل من جهة
// الزائر للفصول المجانية بلا أي تسجيل دخول (المرجع المفتوح: مصدر
// HakuNeko ‏Kakaopage.ts — نفس النقاط الثلاث: overview وproduct list
// وviewer/data).
//
// روابط الفصول المدعومة:
//   https://page.kakao.com/viewer?productId=<pid>
//   https://page.kakao.com/content/<sid>/viewer/<pid>
//   https://page.kakao.com/content/<sid>?...&productId=<pid>
//   (رابط viewer يُتبع تحويله التلقائي إلى الشكل الثاني ليُستخرج seriesId)
//
// رابط العمل فقط (content/<sid> بلا productId) ليس رابط فصل — يُرفض برسالة
// واضحة. الفصل غير المجاني يعيد result_code=‎-200 (غير مشترى) فيُترجم إلى
// حالة «مدفوع».
// ============================================================

/** عامل المستخدم لطلبات كاكاو بيج — المتصفح عادي. */
export const KAKAO_PAGE_UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36";

const BFF_VIEWER_URL =
  "https://bff-page.kakao.com/api/gateway/api/v1/viewer/data";
const REQUEST_TIMEOUT_MS = 20_000;

/** نتائج تحليل رابط كاكاو بيج — productId هو معرّف الفصل وseriesId معرّف العمل. */
export type KakaoPageLink = {
  seriesId: string | null;
  productId: string | null;
};

/**
 * يحلل رابط كاكاو بيج ويعيد null لأي رابط لا يخص هذا الموقع:
 * ‏/viewer?productId=… و/content/<sid>/viewer/<pid> و/content/<sid>?productId=…
 * و/content/<sid> (بلا فصل — productId=null).
 */
export function parseKakaoPageUrl(rawUrl: string): KakaoPageLink | null {
  let parsed: URL;
  try {
    parsed = new URL(rawUrl);
  } catch {
    return null;
  }
  const host = parsed.hostname.toLowerCase().replace(/^www\./, "");
  if (host !== "page.kakao.com") return null;

  const viewerPath = parsed.pathname.match(/^\/content\/(\d+)\/viewer\/(\d+)(?:\/)?$/);
  if (viewerPath) {
    return { seriesId: viewerPath[1] ?? null, productId: viewerPath[2] ?? null };
  }
  const contentPath = parsed.pathname.match(/^\/content\/(\d+)(?:\/)?$/);
  if (contentPath) {
    const productId = parsed.searchParams.get("productId");
    return { seriesId: contentPath[1] ?? null, productId: productId && /^\d+$/.test(productId) ? productId : null };
  }
  if (parsed.pathname === "/viewer") {
    const productId = parsed.searchParams.get("productId");
    return { seriesId: null, productId: productId && /^\d+$/.test(productId) ? productId : null };
  }
  return null;
}

/** بيانات الفصل كما تعيدها واجهة viewer/data. */
export type KakaoViewer = {
  seriesId: string;
  productId: string;
  /** اسم العمل (من series_item). */
  mangaTitle: string;
  /** اسم الفصل بعد حذف اسم العمل من مقدمته إن كان مكررًا. */
  chapterName: string;
  isFree: boolean;
  /** روابط الصور الموقعة — صالحة مؤقتًا وتُستهلك فورًا. */
  pages: string[];
};

type KakaoViewerFile = { secureUrl?: string | null };
type KakaoViewerResponse = {
  result_code?: number;
  message?: string;
  message_key?: string;
  item?: {
    product_id?: number | string;
    title?: string | null;
    is_free?: boolean;
  } | null;
  series_item?: { series_id?: number | string; title?: string | null } | null;
  viewer_data?: {
    imageDownloadData?: { files?: KakaoViewerFile[] | null } | null;
  } | null;
};

/** يحذف اسم العمل من مقدمته في اسم الفصل — «عمل X 3화» على «X» يصير «3화». */
export function stripSeriesTitlePrefix(chapterTitle: string, seriesTitle: string): string {
  const chapter = (chapterTitle ?? "").trim();
  const series = (seriesTitle ?? "").trim();
  if (!series || !chapter.startsWith(series)) return chapter;
  const rest = chapter.slice(series.length).trim();
  return rest || chapter;
}

/** يحلل استجابة viewer/data إلى KakaoViewer — يعيد رسالة عربية عند رفض الواجهة. */
export function parseKakaoViewerResponse(
  payload: KakaoViewerResponse,
  seriesId: string,
  productId: string
): { ok: true; viewer: KakaoViewer } | { ok: false; locked: boolean; message: string } {
  const code = payload.result_code ?? 0;
  if (code !== 0) {
    const locked = code === -200 || payload.message_key === "api_content_not_purchased_item";
    return {
      ok: false,
      locked,
      message: locked
        ? "هذا الفصل مدفوع على كاكاو بيج (غير مجاني للزوار) — البوت يسحب الفصول المجانية فقط من هذا الموقع."
        : `رفضت واجهة كاكاو بيج طلب الفصل (result_code=${code}${payload.message ? ` — ${payload.message}` : ""}).`,
    };
  }
  const seriesTitle = (payload.series_item?.title ?? "").trim();
  const itemTitle = (payload.item?.title ?? "").trim();
  if (!seriesTitle || !itemTitle) {
    return { ok: false, locked: false, message: "استجابة كاكاو بيج جاءت بلا عناوين العمل أو الفصل." };
  }
  const files = payload.viewer_data?.imageDownloadData?.files ?? [];
  const pages = files
    .map(file => (file?.secureUrl ?? "").trim())
    .filter(url => url.length > 0);
  if (!pages.length) {
    return {
      ok: false,
      locked: false,
      message: "واجهة كاكاو بيج لم تعيد صفحات الفصل — الفصل مدفوع غالبًا أو أن الموقع غيّر استجابته.",
    };
  }
  return {
    ok: true,
    viewer: {
      seriesId,
      productId,
      mangaTitle: seriesTitle,
      chapterName: stripSeriesTitlePrefix(itemTitle, seriesTitle) || itemTitle,
      isFree: payload.item?.is_free !== false,
      pages,
    },
  };
}

/**
 * يجلب بيانات الفصل من واجهة viewer/data — الترويسات المطلوبة:
 * Referer وOrigin من page.kakao.com وإلا ردّ «Forbidden» نصي من البوابة.
 * cookie جلسة اختيارية (من لوحة التحكم) لمحاولة الفصول المدفوعة بحساب موثق.
 */
export async function fetchKakaoViewer(
  seriesId: string,
  productId: string,
  cookie?: string | null
): Promise<{ ok: true; viewer: KakaoViewer } | { ok: false; locked: boolean; message: string }> {
  const url = `${BFF_VIEWER_URL}?series_id=${encodeURIComponent(seriesId)}&product_id=${encodeURIComponent(productId)}`;
  const headers: Record<string, string> = {
    "user-agent": KAKAO_PAGE_UA,
    referer: "https://page.kakao.com/",
    origin: "https://page.kakao.com",
    accept: "application/json",
  };
  if (cookie) headers.cookie = cookie;
  let payload: KakaoViewerResponse;
  try {
    const response = await fetch(url, { headers, redirect: "follow", signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS) });
    if (!response.ok) {
      return {
        ok: false,
        locked: false,
        message: `واجهة كاكاو بيج ردّت بحالة ${response.status} — الموقع مشغول أو يحجب طلبات البوت، أعد المحاولة.`,
      };
    }
    payload = (await response.json()) as KakaoViewerResponse;
  } catch (error) {
    return {
      ok: false,
      locked: false,
      message: `تعذر الوصول إلى واجهة كاكاو بيج: ${error instanceof Error && error.message ? error.message : "خطأ شبكة غير معروف"}`,
    };
  }
  return parseKakaoViewerResponse(payload, seriesId, productId);
}

/**
 * يتبع تحويل رابط viewer?productId إلى رابط content/<sid>/viewer/<pid>
 * ليستخرج seriesId الذي تحتاجه الواجهة — العودة للرابط النهائي من fetch.
 */
export async function resolveKakaoViewerLink(
  rawUrl: string
): Promise<{ ok: true; seriesId: string; productId: string } | { ok: false; message: string }> {
  const parsed = parseKakaoPageUrl(rawUrl);
  if (!parsed || !parsed.productId) {
    return { ok: false, message: "رابط كاكاو بيج لا يحمل معرّف فصل (productId)." };
  }
  if (parsed.seriesId) return { ok: true, seriesId: parsed.seriesId, productId: parsed.productId };
  try {
    const response = await fetch(`https://page.kakao.com/viewer?productId=${encodeURIComponent(parsed.productId)}`, {
      headers: { "user-agent": KAKAO_PAGE_UA, referer: "https://page.kakao.com/" },
      redirect: "follow",
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
    const finalUrl = response.url ?? "";
    const match = finalUrl.match(/page\.kakao\.com\/content\/(\d+)\/viewer\/(\d+)/);
    if (match) {
      return { ok: true, seriesId: match[1] ?? "", productId: match[2] ?? parsed.productId };
    }
    return {
      ok: false,
      message: "تعذر تحديد معرّف العمل من رابط الفصل — أرسل رابط الفصل من عنوان المتصفح داخل القارئ (يبدأ بـ /content/…/viewer/…).",
    };
  } catch (error) {
    return {
      ok: false,
      message: `تعذر فتح رابط كاكاو بيج: ${error instanceof Error && error.message ? error.message : "خطأ شبكة غير معروف"}`,
    };
  }
}

/**
 * المسار الكامل لرابط فصل كاكاو بيج: تحليل → حل معرّف العمل → جلب الصفحات.
 * ok=false مع locked=true يعني فصلًا مدفوعًا (يرفض بنعرفة)، وok=false مع
 * locked=false يعني عطبًا أو رابطًا غير مفهوم (تظهر رسالته في سجل المحاولات).
 */
export async function fetchKakaoPageChapter(
  rawUrl: string,
  cookie?: string | null
): Promise<
  | { ok: true; mangaTitle: string; chapterName: string; pages: string[] }
  | { ok: false; locked: boolean; message: string }
> {
  const parsed = parseKakaoPageUrl(rawUrl);
  if (!parsed) {
    return { ok: false, locked: false, message: "الرابط ليس رابط كاكاو بيج معروفًا." };
  }
  if (!parsed.productId) {
    return {
      ok: false,
      locked: false,
      message:
        "هذا رابط عمل على كاكاو بيج وليس رابط فصل — افتح الفصل المطلوب (زر المشاهدة) وأرسل رابط القارئ الذي يحمل productId.",
    };
  }
  const target = parsed.seriesId
    ? { ok: true as const, seriesId: parsed.seriesId, productId: parsed.productId }
    : await resolveKakaoViewerLink(rawUrl);
  if (!target.ok) return { ok: false, locked: false, message: target.message };
  const viewer = await fetchKakaoViewer(target.seriesId, target.productId, cookie);
  if (!viewer.ok) return viewer;
  return {
    ok: true,
    mangaTitle: viewer.viewer.mangaTitle,
    chapterName: viewer.viewer.chapterName,
    pages: viewer.viewer.pages,
  };
}
