import { getSetting, setSetting } from "../db";
import { ENV } from "../_core/env";
import { fetchViaScraperApi } from "./scraperApi";
import { canonicalQueryEntries, ComixCipher, comixMaterialFingerprint, isValidComixMaterial, parseComixMaterial, type ComixCipherMaterial } from "./comixCipher";
import { looksLikeImage } from "./scraperApi";

// ============================================================
// كوميكس (comix.to) — سحب مباشر عبر واجهة الموقع الموقعة
// ============================================================
// الموقع خلف حماية Cloudflare ترفض مراكز البيانات، وواجهته /api/v1
// ترفض أي طلب بلا توقيع «_» المحسوب من مادة تشفير يولّدها جافاسكربت
// الموقع نفسه (لا يمكن تنفيذه على الخادم إطلاقًا). لذا:
// - الطلبات تمر عبر وسيط ScraperAPI (الفاشل منها مجاني) مع إعادة محاولة
//   صبورة، لأن عناوين خروج الوسيط تنجح أحيانًا وتُحجب أحيانًا.
// - مادة التشفير تُلصق مرة واحدة من لوحة التحكم بكود جارٍ في متصفح
//   المالك على الموقع (يفتح المتصفح الموقع طبيعيًا فيتخطى الحماية).
// - صور الصفحات على مضيف static.comix.to مفتوح بلا حماية وتُنزّل
//   مباشرة، وفك تشويشها في comixDescrambler.ts.
// ============================================================

const COMIX_MATERIAL_SETTING = "comix_cipher_material";
const COMIX_MATERIAL_UPDATED_AT_SETTING = "comix_cipher_material_updated_at";

/** النطاقات المعتمدة لروابط كوميكس. */
export const COMIX_HOSTS = ["comix.to", "comix.ws"] as const;

export type ComixMaterialStatus = {
  configured: boolean;
  source: "settings" | "env" | null;
  updatedAt: string;
  fingerprint: string;
};

/** يطبع المادة الملصوقة ويتحقق من سلامتها — يعيد رسالة عربية عند الخطأ. */
export async function saveComixMaterial(input: string): Promise<ComixMaterialStatus> {
  const material = parseComixMaterial(input);
  if (!material) {
    throw new Error(
      "مادة تشفير كوميكس غير صالحة — الصق مخرجات كود المتصفح كما هو (JSON فيه sboxes وkeys).",
    );
  }
  const updatedAt = new Date().toISOString();
  await setSetting(COMIX_MATERIAL_SETTING, JSON.stringify(material));
  await setSetting(COMIX_MATERIAL_UPDATED_AT_SETTING, updatedAt);
  return {
    configured: true,
    source: "settings",
    updatedAt,
    fingerprint: comixMaterialFingerprint(material),
  };
}

export async function removeComixMaterial(): Promise<ComixMaterialStatus> {
  await setSetting(COMIX_MATERIAL_SETTING, "");
  const envMaterial = parseComixMaterial(ENV.comixCipherMaterial ?? "");
  if (envMaterial) {
    return {
      configured: true,
      source: "env",
      updatedAt: "",
      fingerprint: comixMaterialFingerprint(envMaterial),
    };
  }
  return { configured: false, source: null, updatedAt: "", fingerprint: "" };
}

/** المادة الفعالة: اللوحة أولًا ثم متغير البيئة. */
export async function getComixMaterial(): Promise<{ material: ComixCipherMaterial; source: "settings" | "env" } | null> {
  const stored = (await getSetting(COMIX_MATERIAL_SETTING))?.trim();
  if (stored) {
    const material = parseComixMaterial(stored);
    if (material) return { material, source: "settings" };
  }
  const envMaterial = parseComixMaterial(ENV.comixCipherMaterial ?? "");
  if (envMaterial) return { material: envMaterial, source: "env" };
  return null;
}

export async function getComixMaterialStatus(): Promise<ComixMaterialStatus> {
  const material = await getComixMaterial();
  if (!material) return { configured: false, source: null, updatedAt: "", fingerprint: "" };
  if (material.source === "settings") {
    const updatedAt = (await getSetting(COMIX_MATERIAL_UPDATED_AT_SETTING)) ?? "";
    return {
      configured: true,
      source: "settings",
      updatedAt,
      fingerprint: comixMaterialFingerprint(material.material),
    };
  }
  return {
    configured: true,
    source: "env",
    updatedAt: "",
    fingerprint: comixMaterialFingerprint(material.material),
  };
}

/** مادة موجودة؟ (لرفض واضح قبل بدء السحب). */
export function hasValidComixMaterialShape(material: ComixCipherMaterial | null): boolean {
  return isValidComixMaterial(material);
}

// ------------------------------------------------------------
// روابط الفصول
// ------------------------------------------------------------

export type ComixChapterLink = {
  /** اسم العمل في المسار — مثل «121601-1st-in-class-hides-regression». */
  mangaSlug: string;
  /** اسم الفصل في المسار — مثل «943210-chapter-6». */
  chapterSlug: string;
  /** معرّف الفصل الرقمي (قبل أول شرطة في اسم الفصل). */
  chapterId: string | null;
};

/**
 * يحلل رابط كوميكس ويعيد null لأي رابط لا يخصه:
 *   https://comix.to/title/<manga>/<chapter>
 * رابط العمل بلا فصل يعيد chapterId=null وchapterSlug فارغًا.
 */
export function parseComixUrl(rawUrl: string): ComixChapterLink | null {
  let parsed: URL;
  try {
    parsed = new URL(rawUrl);
  } catch {
    return null;
  }
  const host = parsed.hostname.toLowerCase().replace(/^www\./, "");
  if (!(COMIX_HOSTS as readonly string[]).includes(host)) return null;
  const segments = parsed.pathname.split("/").filter(Boolean);
  if (segments[0] !== "title" || segments.length < 2) return null;
  const mangaSlug = segments[1] ?? "";
  const chapterSlug = segments[2] ?? "";
  const chapterId = chapterSlug ? chapterSlug.split("-")[0] ?? null : null;
  return {
    mangaSlug,
    chapterSlug,
    chapterId: chapterId && /^\d+$/.test(chapterId) ? chapterId : null,
  };
}

// ------------------------------------------------------------
// عميل الواجهة الموقعة عبر الوسيط
// ------------------------------------------------------------

const COMIX_BASE_URL = "https://comix.to";
/** المهلة لطلب واحد عبر الوسيط. */
const REQUEST_TIMEOUT_MS = 90_000;
/** إعادة المحاولة الصبورة — الطلبات الفاشلة عبر الوسيط لا تستهلك رصيدًا. */
const MAX_ATTEMPTS = 10;

export type ComixSignedCallOutcome<T> =
  | { ok: true; data: T }
  | { ok: false; message: string };

/** طلب موقّع عبر الوسيط مع إعادة المحاولة — يفك الاستجابة المشفرة إن وُجدت. */
export async function signedComixGet<T>(
  path: string,
  params: Record<string, string | string[]>,
  cipher: ComixCipher,
): Promise<ComixSignedCallOutcome<T>> {
  const entries = canonicalQueryEntries(params);
  const query = entries.map(([name, value]) => `${name}=${value}`).join("&");
  const signature = cipher.sign(path, query);
  const url = new URL(`${COMIX_BASE_URL}${path}`);
  for (const [name, value] of entries) url.searchParams.set(name, value);
  url.searchParams.set("_", signature);
  // الترتيب في نص التوقيع يجب أن يطابق الترتيب في الرابط النهائي —
  // searchParams.set يحفظ ترتيب الإضافة نفسه فلا حاجة لإعادة ترتيب.

  let lastMessage = "";
  for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt += 1) {
    try {
      const response = await fetchViaScraperApi(url.toString(), REQUEST_TIMEOUT_MS);
      const text = (await response.text()).trim();
      // رسالة الوسيط عند فشل الطلب الخلفي — لا تُحتسب رصيدًا فتُعاد المحاولة
      if (text.startsWith("Request failed") || text.startsWith("Your current plan")) {
        lastMessage = "الوسيط لم يصل إلى الموقع هذه المرة";
      } else if (!response.ok) {
        lastMessage = `الموقع ردّ بحالة ${response.status}`;
        if (response.status >= 400 && response.status < 500) {
          // رفض من الواجهة نفسها (توقيع قديم مثلًا) — بلا فائدة من إعادة المحاولة
          return { ok: false, message: `واجهة كوميكس رفضت الطلب (${response.status}) — حدّث مادة التشفير من اللوحة.` };
        }
      } else {
        let parsed: unknown;
        try {
          parsed = JSON.parse(text);
        } catch {
          lastMessage = "استجابة غير مفهومة من الموقع";
          await new Promise(resolve => setTimeout(resolve, 1500));
          continue;
        }
        const encrypted = (parsed as { e?: unknown })?.e;
        if (typeof encrypted === "string" && encrypted.length > 0) {
          try {
            parsed = JSON.parse(cipher.decrypt(encrypted));
          } catch {
            return {
              ok: false,
              message: "فشل فك تشفير استجابة كوميكس — مادة التشفير قديمة أو غير مطابقة، حدّثها من اللوحة.",
            };
          }
        }
        return { ok: true, data: parsed as T };
      }
    } catch (error) {
      lastMessage = error instanceof Error && error.message ? error.message : "خطأ شبكة";
    }
    await new Promise(resolve => setTimeout(resolve, 1200 + attempt * 800));
  }
  return {
    ok: false,
    message: `تعذر الوصول إلى واجهة كوميكس بعد ${MAX_ATTEMPTS} محاولات عبر الوسيط (${lastMessage}) — حماية الموقع تقوى وتضعف دوريًا، أعد المحاولة لاحقًا.`,
  };
}

// ------------------------------------------------------------
// أشكال الاستجابة
// ------------------------------------------------------------

type ComixApiManga = {
  hid?: string;
  title?: string;
  url?: string;
};

type ComixApiListResponse = {
  result?: { items?: ComixApiManga[] | ComixApiChapterItem[]; meta?: { page?: number; lastPage?: number; last_page?: number; hasNext?: boolean } };
};

type ComixApiChapterItem = {
  id?: number;
  url?: string;
  number?: number;
  name?: string;
  title?: string | null;
};

type ComixApiPagesResponse = {
  result?: {
    pages?: {
      baseUrl?: string;
      items?: Array<{ url?: string; s?: number }>;
    };
  };
};

// ------------------------------------------------------------
// البحث وقائمة الفصول
// ------------------------------------------------------------

/** يبحث في كوميكس ويعيد العناوين مع روابطها النسبية. */
export async function searchComixManga(
  query: string,
  page: number,
  cipher: ComixCipher,
): Promise<ComixSignedCallOutcome<Array<{ title: string; mangaSlug: string }>>> {
  const outcome = await signedComixGet<ComixApiListResponse>("/api/v1/manga", {
    keyword: query,
    limit: "20",
    page: String(page),
  }, cipher);
  if (!outcome.ok) return outcome;
  const items = (outcome.data.result?.items ?? []) as ComixApiManga[];
  return {
    ok: true,
    data: items.map(item => ({
      title: (item.title ?? "").trim(),
      mangaSlug: (item.url ?? item.hid ?? "").replace(/^\/?title\//, "").replace(/^\//, ""),
    })).filter(item => item.title && item.mangaSlug),
  };
}

/** يجلب قائمة فصول العمل (كل الصفحات) — الأحدث أولًا كما يعيدها الموقع. */
export async function fetchComixChapterList(
  mangaSlug: string,
  cipher: ComixCipher,
): Promise<ComixSignedCallOutcome<Array<{ id: number; url: string; name: string; number: number }>>> {
  const mangaId = mangaSlug.split("-")[0] ?? "";
  if (!/^\d+$/.test(mangaId)) {
    return { ok: false, message: "اسم العمل في رابط كوميكس لا يحمل معرّفًا رقميًا — أرسل رابط فصل محددًا." };
  }
  const chapters: Array<{ id: number; url: string; name: string; number: number }> = [];
  let page = 1;
  while (page <= 50) {
    const outcome = await signedComixGet<ComixApiListResponse>(`/api/v1/manga/${mangaId}/chapters`, {
      limit: "100",
      "order[number]": "desc",
      page: String(page),
    }, cipher);
    if (!outcome.ok) return outcome;
    const items = outcome.data.result?.items ?? [];
    if (!items.length) break;
    for (const item of items as ComixApiChapterItem[]) {
      const id = Number(item.id ?? 0);
      if (!id) continue;
      const number = Number(item.number ?? 0);
      chapters.push({
        id,
        url: item.url || `title/${mangaSlug}/${id}-chapter-${number}`,
        name: `Chapter ${number}${item.name ? `: ${item.name}` : ""}`,
        number,
      });
    }
    const meta = outcome.data.result?.meta;
    const lastPage = Math.max(meta?.lastPage ?? meta?.last_page ?? 1, 1);
    const hasNext = meta?.hasNext ?? page < lastPage;
    if (!hasNext) break;
    page += 1;
  }
  if (!chapters.length) {
    return { ok: false, message: "واجهة كوميكس لم تعُد فصولًا لهذا العمل." };
  }
  return { ok: true, data: chapters };
}

// ------------------------------------------------------------
// صفحات الفصل
// ------------------------------------------------------------

/** نتيجة تحليل صفحات الفصل — روابط جاهزة لأنبوب التنزيل مع علامات التشويش. */
export type ComixResolvedChapter = {
  mangaTitle: string;
  chapterName: string;
  /** روابط الصور — علامة #comixv3 أو #comixscrambled تُلحق لفك التشويش عند التنزيل. */
  pages: string[];
};

/** يبني روابط الصور بعلامات التشويش نفسها التي تستخدمها إضافة كوميكس. */
export function buildComixPageUrls(payload: ComixApiPagesResponse): string[] {
  const pages = payload.result?.pages;
  if (!pages?.items?.length) return [];
  const base = (pages.baseUrl ?? "").replace(/\/+$/, "");
  return pages.items.map((item, index) => {
    const raw = item.url ?? "";
    if (!raw) return "";
    const full = /^https?:\/\//.test(raw) ? raw : `${base}/${raw.replace(/^\/+/, "")}`;
    const isV3 = item.s === 1 || full.includes("?v3");
    // التشويش القديم يطال كل رابع صفحة حسب موضعها في قائمة الفصل نفسها
    const isLegacyScramble = !isV3 && (index + 1) % 4 === 0;
    if (isV3) {
      const withParam = full.includes("v3") ? full : `${full}${full.includes("?") ? "&" : "?"}v3`;
      return `${withParam}#comixv3`;
    }
    if (isLegacyScramble) return `${full}#comixscrambled`;
    return full;
  }).filter(url => url.length > 0);
}

/** استثناء الفصل المدفوع — نص عربي ثابت يعتمده فحص القفل. */
export const COMIX_LOCKED_MESSAGE =
  "هذا الفصل مدفوع (🔒) على موقع كوميكس ولا يمكن سحبه دون شرائه من الموقع.";

/**
 * يجلب صفحات الفصل من الواجهة الموقعة:
 *   /api/v1/chapters/<id> — id من رابط الفصل نفسه.
 * فصل بلا صفحات يعيد رسالة مدفوع (🔒) واضحة.
 */
export async function fetchComixChapter(
  rawUrl: string
): Promise<
  | { ok: true; mangaTitle: string; chapterName: string; pages: string[] }
  | { ok: false; locked: boolean; message: string }
> {
  const material = await getComixMaterial();
  if (!material) {
    return {
      ok: false,
      locked: false,
      message:
        "كوميكس يحتاج تهيئة لمرة واحدة: الصق مادة التشفير من بطاقة «كوميكس» في لوحة التحكم (الإعدادات) — الكود الجاهز داخلها يعمل في متصفحك على الموقع مباشرة.",
    };
  }
  const parsed = parseComixUrl(rawUrl);
  if (!parsed) {
    return { ok: false, locked: false, message: "الرابط ليس رابط كوميكس معروفًا." };
  }
  if (!parsed.chapterSlug || !parsed.chapterId) {
    return {
      ok: false,
      locked: false,
      message:
        "هذا رابط عمل على كوميكس وليس رابط فصل — افتح الفصل المطلوب وأرسل رابط القارئ (ينتهي بـ /chapter-…).",
    };
  }
  const cipher = new ComixCipher(material.material);
  const pagesOutcome = await signedComixGet<ComixApiPagesResponse>(
    `/api/v1/chapters/${parsed.chapterId}`,
    {},
    cipher,
  );
  if (!pagesOutcome.ok) return { ok: false, locked: false, message: pagesOutcome.message };
  const pages = buildComixPageUrls(pagesOutcome.data);
  if (!pages.length) {
    return { ok: false, locked: true, message: COMIX_LOCKED_MESSAGE };
  }
  return {
    ok: true,
    mangaTitle: parsed.mangaSlug.replace(/^\d+-/, "").replace(/-/g, " "),
    chapterName: parsed.chapterSlug.replace(/^\d+-/, "").replace(/-/g, " "),
    pages,
  };
}

/** فحص بصمة صورة — يُعاد تصديرها للتوافق مع أنابيب التنزيل. */
export { looksLikeImage };
