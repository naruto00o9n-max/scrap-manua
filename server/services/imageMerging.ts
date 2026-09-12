import { createWriteStream } from "node:fs";
import { mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { Readable, Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
import sharp, { type Sharp } from "sharp";

// التحكم في استهلاك ذاكرة libvips: بلا تخزين مؤقت للصور المفككة ومعالجة تسلسلية،
// حتى لا تقتل الحاوية العملية عند دمج فصول طويلة (خطأ exit 137 / OOM).
sharp.cache(false);
sharp.concurrency(1);

const MAX_PAGE_SIZE_BYTES = 40 * 1024 * 1024;
/** ترويسة User-Agent لتنزيل صفحات الفصل — بعض CDNs ترفض الطلبات المجردة (صور WEBTOON تعيد 403). */
const PAGE_DOWNLOAD_UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36";

/**
 * ترويسة Referer للصور التي ترفض الروابط الساخنة: CDN نافير لصور WEBTOON
 * (webtoon-phinf.pstatic.net) يعيد 403 لأي طلب بلا Referer من الموقع نفسه.
 */
function pageDownloadReferer(parsed: URL): string | null {
  const host = parsed.hostname.toLowerCase();
  if (host === "webtoon-phinf.pstatic.net" || host.endsWith(".pstatic.net")) {
    return "https://www.webtoons.com/";
  }
  return null;
}
// سقف ارتفاع الصورة المدمجة: الخوارزمية توزّع مجموع ارتفاع الصفحات بالتساوي
// على أقل عدد ممكن من الصور، فيصبح ارتفاع كل ناتج ≈ المجموع ÷ العدد (داخل السقف)
// بدل تكدّس أطوال متباعدة. أصبح هذا السقف قابلًا للتخصيص لكل سيرفر من /الاعدادات
// (قسم الدمج).
export const DEFAULT_MERGE_HEIGHT_CAP = 15000;
/** مدى سقف الارتفاع المقبول — خارج المدى تُرجع القيمة للحد الأقرب. */
export const MERGE_HEIGHT_CAP_MIN = 2000;
export const MERGE_HEIGHT_CAP_MAX = 30000;
/** مدى عرض الدمج المقبول عند اختيار عرض ثابت بدل اتباع الصفحات. */
export const MERGE_WIDTH_MIN = 600;
export const MERGE_WIDTH_MAX = 2400;
const PAGE_DOWNLOAD_CONCURRENCY = 6;

// ============================================================
// القص الذكي المرن — الهدف صفر فقاعة أو رسمة مقصوصة عند فواصل الدمج:
// بدل القص عند ارتفاع ثابت يمر أحيانًا عبر نص فقاعة، يُبحث عن سطر بكسلات
// فارغ قريب من النقطة المثالية ويُقص عنده؛ وإن كان الرسم كثيفًا حول النقطة
// فلا مفر من القص عبره، تُخاط الشريحة المعلقة أعلى الصورة التالية بنهاية
// الصورة السابقة — نقل حدود مجموعتين فقط، بلا أي فقدان أو إعادة رسم.
// ============================================================

/** نصف مدى بحث القص الذكي حول النقطة المثالية (بكسل لكل اتجاه). */
export const SMART_CUT_SEARCH = 400;
/** عتبة البياض في بحث السطر الفارغ: البكسل الأفتح من هذا يُعدّ ضجيج ضغط لا حبرًا. */
export const SMART_CUT_BLANK_THRESHOLD = 245;
/** عتبة الحبر الداكن في كشف الشريحة المعلقة أعلى الصورة التالية (الخياطة الاحتياطية). */
export const REPAIR_INK_THRESHOLD = 200;
/** أقل عدد بكسلات داكنة في السطر ليُعدّ سطرًا يحمل رسمة عند كشف الخياطة. */
export const REPAIR_ROW_INK_MIN = 3;
/** أقل عدد أسطر صفّية فاصلة يؤكد انتهاء الشريحة المعلقة أعلى الصورة التالية. */
export const REPAIR_BLANK_GAP = 30;
/** هامش أمان بعد آخر سطر حبر في الشريحة المعلقة قبل وضع خط القطع الجديد. */
export const REPAIR_MARGIN = 56;
/** أقصى عمق فحص للشريحة المعلقة من خط القطع قبل الاستسلام وترك القص كما هو. */
export const REPAIR_MAX_SCAN = 2000;

/** صيغ إخراج الصور المدمجة المدعومة — الاختيار من لوحة الإعدادات. */
export type ImageOutputFormat = "png" | "jpeg" | "webp";
export type MergedImageMime = "image/png" | "image/jpeg" | "image/webp";

export type ImageOutputConfig = {
  format: ImageOutputFormat;
  /** جودة الترميز (40–100): تُستخدم لصيغتي JPG/WebP ولخيار تقليل ألوان PNG. */
  quality: number;
  /** تقليل ألوان PNG (لوحة 256 لونًا بتردد مُدار) — أصغر أكثر مع فقدان غير محسوس للمانهوا. */
  pngPalette: boolean;
};

/**
 * الافتراضي: PNG بضغط أقصى **بلا أي فقدان**.
 * السابق كان يرمّز PNG بمستوى ضغط 0 (تخزين خام بلا ضغط إطلاقًا) فكانت الصورة
 * المدمجة 800×15000 تشغل ~46MB؛ نفس الصورة بمستوى الضغط الأقصى تنزل إلى
 * كسر بسيط منها — إصلاح الحجم الهائل دون تغيير الصيغة ولا فقدان بكسل واحد.
 */
export const DEFAULT_IMAGE_OUTPUT: ImageOutputConfig = {
  format: "png",
  quality: 88,
  pngPalette: false,
};

export const FORMAT_MIME: Record<ImageOutputFormat, MergedImageMime> = {
  png: "image/png",
  jpeg: "image/jpeg",
  webp: "image/webp",
};

// ============================================================
// أبعاد الدمج القابلة للتخصيص لكل سيرفر (قسم الدمج في /الاعدادات)
// ============================================================

/** أبعاد الدمج المطبقة فعليًا على مجموعة صفحات: سقف الارتفاع والعرض المستهدف. */
export type MergeDimensions = {
  /** أقصى ارتفاع بالبكسل للصورة المدمجة الواحدة. */
  heightCap: number;
  /** عرض الدمج بالبكسل — null يعني اتباع العرض الأكثر تكرارًا في الصفحات. */
  width: number | null;
};

/**
 * إعداد الدمج المخزن لكل سيرفر: مفعّل/معطل + تخصيص الأبعاد، حيث null
 * في heightCap أو width يعني «بلا تخصيص — اتبع الافتراضي».
 */
export type ChapterMergeSettings = {
  enabled: boolean;
  heightCap: number | null;
  width: number | null;
};

/** الافتراضي: الدمج مفعّل وأبعاده كما كانت دائمًا (15000px وعرض الصفحات تلقائيًا). */
export const DEFAULT_CHAPTER_MERGE_SETTINGS: ChapterMergeSettings = {
  enabled: true,
  heightCap: null,
  width: null,
};

/** يقص سقف الارتفاع إلى المدى المقبول — القيم الفاسدة تعود إلى الافتراضي. */
export function normalizeMergeHeightCap(value: unknown): number {
  const height = Number(value);
  if (!Number.isFinite(height) || height <= 0) return DEFAULT_MERGE_HEIGHT_CAP;
  return Math.min(MERGE_HEIGHT_CAP_MAX, Math.max(MERGE_HEIGHT_CAP_MIN, Math.round(height)));
}

/** يقص عرض الدمج إلى المدى المقبول — null/الفاسد يعني «تلقائي حسب الصفحات». */
export function normalizeMergeWidth(value: unknown): number | null {
  if (value === null || value === undefined || value === "") return null;
  const width = Number(value);
  if (!Number.isFinite(width) || width <= 0) return null;
  return Math.min(MERGE_WIDTH_MAX, Math.max(MERGE_WIDTH_MIN, Math.round(width)));
}

/**
 * يطبّع إعداد دمج السيرفر القادم من قاعدة البيانات: القيمة القديمة «off»
 * تعني الدمج معطلًا بلا تخصيص أبعاد، وJSON فاسد يعود إلى الافتراضي.
 */
export function normalizeChapterMergeSettings(raw: string | null): ChapterMergeSettings {
  if (raw === null) return { ...DEFAULT_CHAPTER_MERGE_SETTINGS };
  if (raw === "off") return { enabled: false, heightCap: null, width: null };
  try {
    const parsed = JSON.parse(raw) as Partial<ChapterMergeSettings>;
    return {
      enabled: parsed.enabled !== false,
      heightCap: parsed.heightCap === null || parsed.heightCap === undefined ? null : normalizeMergeHeightCap(parsed.heightCap),
      width: normalizeMergeWidth(parsed.width ?? null),
    };
  } catch {
    return { ...DEFAULT_CHAPTER_MERGE_SETTINGS };
  }
}

/** يحسم الأبعاد المطبقة فعليًا من إعداد السيرفر: التخصيص أو الافتراضي. */
export function resolveMergeDimensions(settings: ChapterMergeSettings): MergeDimensions {
  return {
    heightCap: normalizeMergeHeightCap(settings.heightCap ?? DEFAULT_MERGE_HEIGHT_CAP),
    width: normalizeMergeWidth(settings.width),
  };
}

// ============================================================
// ميزانيات ذاكرة الترميز — سبب قتل العملية بخطأ 137 (OOM) على Railway:
// PNG بلا لوحة يبث الصورة عبر libvips فتبقى الذاكرة محدودة مهما كان الطول،
// أما JPG وWebP وتقليل ألوان PNG فتُحمّل الصورة كاملة في الذاكرة عند الترميز
// (~7MB و6MB لكل ميغابكسل قياسًا حيًا)، وWebP لا يقبل بعدًا أطول من 16383px
// أصلًا. طلب المالك: **لا تقسيم تلقائي للصور** — المجموعات الأطول من ميزانية
// صيغتها تُحوّل إلى PNG بلا أي فقدان وتكمل دمجها صورة واحدة متصلة،
// وتقليل ألوان PNG يُتخطى للصور الطويلة.
// ============================================================

/** ميزانية المساحة للصيغ الحاملة للصورة كاملة في الذاكرة (JPG/WebP) — ~90-120MB ذروة لكل صورة. */
export const FULL_RASTER_AREA_LIMIT = 12_000_000;
/** ميزانية تقليل ألوان PNG فوقها تُتخطى ميزة اللوحة وتبقى PNG بلا أي فقدان. */
export const PALETTE_AREA_LIMIT = 12_000_000;
/** حد libwebp الصارم 16383px لكل بُعد — نستخدم هامشًا أدنى. */
export const WEBP_MAX_DIMENSION = 16000;

/**
 * يحدد ترميز كل صورة مدمجة على حدة مع ملاحظات الأمان — **بلا أي تقسيم**:
 * - تقليل ألوان PNG فوق ميزانيته يُتخطى وتبقى الصورة PNG بلا أي فقدان.
 * - مجموعة أطول من ميزانية ذاكرة JPG/WebP (الصيغة تحمل الصورة كاملة عند
 *   الترميز) تُحوَّل إلى PNG بلا أي فقدان وتكمل دمجها صورة واحدة — PNG
 *   يبث ترميزه عبر libvips فتبقى الذاكرة آمنة مهما كان الطول.
 * - مجموعة أطول من حد WebP الصارم (16383px لكل بُعد) تُحوَّل إلى PNG كذلك.
 * دالة نقية قابلة للاختبار.
 */
export function resolveGroupOutput(
  output: ImageOutputConfig,
  width: number,
  groupHeight: number,
  pageCount: number
): { output: ImageOutputConfig; note: string | null } {
  const area = width * groupHeight;
  if (output.format === "png" && output.pngPalette && area > PALETTE_AREA_LIMIT) {
    return {
      output: { ...output, pngPalette: false },
      note:
        "تقليل ألوان PNG يتطلب تحميل الصورة كاملة في الذاكرة — تُخُطّي لهذه الصورة الطويلة وبقيت PNG بلا أي فقدان (بدون تقليل ألوان).",
    };
  }
  if (output.format === "webp" && groupHeight > WEBP_MAX_DIMENSION) {
    return {
      output: { format: "png", quality: output.quality, pngPalette: false },
      note:
        "صيغة WebP لا تدعم صورًا أطول من 16000px (حد مكتبة الترميز نفسها) — حُوّلت هذه الصورة إلى PNG بلا أي فقدان وأكملت الدمج صورة واحدة دون تقسيم.",
    };
  }
  if ((output.format === "jpeg" || output.format === "webp") && area > FULL_RASTER_AREA_LIMIT) {
    return {
      output: { format: "png", quality: output.quality, pngPalette: false },
      note:
        `صيغة ${output.format === "jpeg" ? "JPG" : "WebP"} تُحمّل الصورة كاملة في الذاكرة عند الترميز — هذه الصورة الأطول من حد الأمان حُوّلت تلقائيًا إلى PNG بلا أي فقدان وأكملت الدمج صورة واحدة دون تقسيمها حفاظًا على ذاكرة الخادم.`,
    };
  }
  return { output, note: null };
}

function clampQuality(quality: number): number {
  if (!Number.isFinite(quality)) return DEFAULT_IMAGE_OUTPUT.quality;
  return Math.min(100, Math.max(40, Math.round(quality)));
}

/**
 * يطبّق ترميز الإخراج على أنبوب sharp حسب الإعداد:
 * PNG بضغط أقصى (فلترة تكيفية)، واختياريًا تقليل ألوان بمستوى جودة محدد؛
 * JPG يُسطّح الشفافية على أبيض ثم يرمّز عبر mozjpeg؛ WebP بجودة محددة.
 */
function encodeWithOutputConfig(pipeline: Sharp, config: ImageOutputConfig): Sharp {
  if (config.format === "jpeg") {
    return pipeline
      .flatten({ background: { r: 255, g: 255, b: 255 } })
      .jpeg({ quality: clampQuality(config.quality), mozjpeg: true });
  }
  if (config.format === "webp") {
    return pipeline.webp({ quality: clampQuality(config.quality) });
  }
  return pipeline.png(
    config.pngPalette
      ? { compressionLevel: 9, adaptiveFiltering: true, palette: true, quality: clampQuality(config.quality), effort: 4 }
      : { compressionLevel: 9, adaptiveFiltering: true, palette: false }
  );
}

/** امتداد ملف الإخراج لكل صيغة. */
export function imageOutputExtension(format: ImageOutputFormat): string {
  return format === "jpeg" ? "jpg" : format;
}

/** وصف عربي قصير لصيغة الإخراج — يظهر في سجل محاولات الطلب. */
export function imageOutputDescription(config: ImageOutputConfig): string {
  if (config.format === "jpeg") return `JPG بجودة ${clampQuality(config.quality)}`;
  if (config.format === "webp") return `WebP بجودة ${clampQuality(config.quality)}`;
  return config.pngPalette
    ? `PNG بتقليل الألوان (جودة ${clampQuality(config.quality)})`
    : "PNG بلا أي فقدان بضغط أقصى";
}

/**
 * يطبّع إعداد صيغة الصور القادم من الإعدادات المخزنة: أي قيمة ناقصة أو
 * فاسدة أو خارج المدى تعود إلى الافتراضي الآمن (PNG بلا فقدان).
 */
export function normalizeImageOutputConfig(raw: string | null): ImageOutputConfig {
  if (!raw) return { ...DEFAULT_IMAGE_OUTPUT };
  try {
    const parsed = JSON.parse(raw) as Partial<ImageOutputConfig>;
    const format: ImageOutputFormat =
      parsed.format === "jpeg" || parsed.format === "webp" ? parsed.format : "png";
    const quality = clampQuality(Number(parsed.quality));
    const pngPalette = parsed.pngPalette === true;
    return { format, quality, pngPalette };
  } catch {
    return { ...DEFAULT_IMAGE_OUTPUT };
  }
}

export type MergedChapterImage = {
  data: Buffer;
  width: number;
  height: number;
  mimeType: MergedImageMime;
};

export type MergedChapterFile = {
  filePath: string;
  width: number;
  height: number;
  mimeType: MergedImageMime;
};

export type ChapterMergeSession = {
  images: MergedChapterFile[];
  /** ملاحظات أمان الذاكرة المطبقة أثناء الدمج — تُعرض في سجل محاولات الطلب. */
  notes: string[];
  cleanup(): Promise<void>;
};

export type MergeProgressEvent = {
  phase: "downloading" | "merging";
  done: number;
  total: number;
};

export type MergeProgressListener = (event: MergeProgressEvent) => Promise<void> | void;

function byteCappedStream(limit: number, label: string) {
  let bytes = 0;
  return new Transform({
    transform(chunk: Buffer, _encoding, callback) {
      bytes += chunk.length;
      if (bytes > limit) {
        callback(new Error(`${label} تتجاوز الحد الآمن للحجم.`));
        return;
      }
      callback(null, chunk);
    },
  });
}

async function downloadPageToTemp(url: string, index: number, targetPath: string): Promise<void> {
  const parsed = new URL(url);
  // روابط GigaViewer المشوشة تحمل فاصل #scramble — يُنزع قبل التنزيل لأنه
  // مؤشر معالجة داخلي وليس جزءًا من عنوان الملف، ثم يُفك التشويش بعد الحفظ.
  const needsUnscramble = parsed.hash === "#scramble";
  if (needsUnscramble) parsed.hash = "";
  if (parsed.protocol !== "https:" || parsed.username || parsed.password || parsed.hostname === "localhost") {
    throw new Error(`رابط الصفحة ${index} غير آمن.`);
  }
  let lastError: unknown;
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      const referer = pageDownloadReferer(parsed);
      const response = await fetch(parsed, {
        redirect: "error",
        signal: AbortSignal.timeout(30_000),
        headers: referer
          ? { "user-agent": PAGE_DOWNLOAD_UA, referer }
          : { "user-agent": PAGE_DOWNLOAD_UA },
      });
      if (!response.ok) throw new Error(`تعذر تنزيل الصفحة ${index} (${response.status}).`);
      const contentType = response.headers.get("content-type")?.toLowerCase() ?? "";
      if (!contentType.startsWith("image/")) throw new Error(`الصفحة ${index} ليست صورة.`);
      const contentLength = Number(response.headers.get("content-length") ?? "0");
      if (Number.isFinite(contentLength) && contentLength > MAX_PAGE_SIZE_BYTES) throw new Error(`الصفحة ${index} تتجاوز الحد الآمن للحجم.`);
      if (!response.body) throw new Error(`تعذر قراءة بيانات الصفحة ${index}.`);
      // تُكتب الصفحة على القرص مباشرة بدل الاحتفاظ بها في الذاكرة.
      const source = Readable.fromWeb(response.body as never);
      await pipeline(source, byteCappedStream(MAX_PAGE_SIZE_BYTES, `الصفحة ${index}`), createWriteStream(targetPath));
      if (needsUnscramble) await unscrambleGigaViewerPage(targetPath);
      return;
    } catch (error) {
      lastError = error;
      if (attempt === 0) await new Promise(resolve => setTimeout(resolve, 250));
    }
  }
  throw lastError instanceof Error ? lastError : new Error(`تعذر تنزيل الصفحة ${index}.`);
}

/** عدد كتل شبكة تشويش GigaViewer في كل بعد، ومضاعف محاذاة الكتلة بالبكسل. */
export const GIGA_SCRAMBLE_DIVIDE_NUM = 4;
export const GIGA_SCRAMBLE_MULTIPLE_NUM = 8;

/**
 * يفك تشويش صفحات GigaViewer (شونين جامب+) بنفس خوارزمية إضافة Mihon:
 * الصورة مخزنة بقلب شبكة 4×4 من الكتل (كل كتلة بعرض/ارتفاع من مضاعفات 8
 * حتى حافة الشبكة)، والفك هو قب الشبكة نفسه لأن القلب عملية تناظرية —
 * الكتلة عند (صف، عمود) تُوضع عند (عمود، صف) بينما تبقى حواف الصورة
 * خارج الشبكة كما هي فوق النسخة الأصلية المرسومة أولًا.
 * الملف يُستبدل في مكانه بعد الفك.
 */
export async function unscrambleGigaViewerPage(filePath: string): Promise<void> {
  const metadata = await sharp(filePath).metadata();
  const width = metadata.width ?? 0;
  const height = metadata.height ?? 0;
  if (!width || !height) return;
  const divide = GIGA_SCRAMBLE_DIVIDE_NUM;
  const blockWidth = Math.floor(width / (divide * GIGA_SCRAMBLE_MULTIPLE_NUM)) * GIGA_SCRAMBLE_MULTIPLE_NUM;
  const blockHeight = Math.floor(height / (divide * GIGA_SCRAMBLE_MULTIPLE_NUM)) * GIGA_SCRAMBLE_MULTIPLE_NUM;
  if (blockWidth <= 0 || blockHeight <= 0) return;
  const composites: Array<{ input: Buffer; left: number; top: number }> = [];
  for (let e = 0; e < divide * divide; e += 1) {
    const sourceCol = e % divide;
    const sourceRow = Math.floor(e / divide);
    // القلب: موضع المصدر (صف، عمود) يصبح (عمود، صف) في الوجهة.
    const buffer = await sharp(filePath)
      .extract({ left: sourceCol * blockWidth, top: sourceRow * blockHeight, width: blockWidth, height: blockHeight })
      .toBuffer();
    composites.push({ input: buffer, left: sourceRow * blockWidth, top: sourceCol * blockHeight });
  }
  const unscrambled = await sharp(filePath).composite(composites).toBuffer();
  await sharp(unscrambled).toFile(`${filePath}.unscrambled`);
  // الاستبدال الذري: ملف جديد ثم إعادة تسمية فوق الأصل.
  const { rename } = await import("node:fs/promises");
  await rename(`${filePath}.unscrambled`, filePath);
}

async function downloadPagesToTemp(
  urls: string[],
  dir: string,
  onProgress?: MergeProgressListener,
): Promise<string[]> {
  const results: string[] = new Array(urls.length);
  let next = 0;
  let completed = 0;
  async function worker() {
    while (true) {
      const index = next++;
      if (index >= urls.length) return;
      const targetPath = path.join(dir, `page-${String(index + 1).padStart(4, "0")}.img`);
      await downloadPageToTemp(urls[index]!, index + 1, targetPath);
      results[index] = targetPath;
      completed += 1;
      if (onProgress) {
        try { await onProgress({ phase: "downloading", done: completed, total: urls.length }); } catch { /* فشل الإشعار لا يُفشل المعالجة */ }
      }
    }
  }
  await Promise.all(Array.from({ length: Math.min(PAGE_DOWNLOAD_CONCURRENCY, urls.length) }, () => worker()));
  return results;
}

/**
 * شريحة من صفحة داخل صورة مدمجة: من أي صفحة، ومن أي ارتفاع داخلها، وبأي سماكة.
 * الصفحة الكاملة = شريحة واحدة top:0 بطول الصفحة كاملًا.
 */
export type MergeSlice = { pageIndex: number; top: number; height: number };

/**
 * التجميع الاحترافي متساوي الارتفاع (طلب المالك: «جميع الصور بارتفاع واحد
 * أو متقارب — يجب قص ودمج لترتيب الصور»):
 *
 * 1. مجموع ارتفاع الصفحات T ≤ السقف؟ صورة واحدة بلا أي قص (سلوك الفصول الصغيرة).
 * 2. وإلا العدد الأدنى للصور N = ⌈T ÷ السقف⌉ والارتفاع المثالي = T ÷ N —
 *    فتخرج كل الصور بارتفاع واحد فعليًا بدل أطوال متباعدة.
 * 3. نقاط القص عند حدود المثالي، مع انزلاق كل نقطة إلى أقرب حد صفحة داخل
 *    هامش صغير (±2% من المثالي، بحدود 120–500px) لتفادي شرائح الضجير —
 *    فلا يُقطع صفحتان متجاورتان لفرق بكسلات تافه، ويبقى الارتفاع متقاربًا.
 * 4. إن خال الانزلاق السقف (حدث فقط عندما يكون المثالي ملاصقًا للسقف)
 *    تعود كل النقاط إلى القيم المثالية — السقف خط أحمر لا يُخترق.
 *
 * هذه هي الخطة الحسابية النقية؛ فوقها يعمل القص الذكي refineMergeCutsAgainstInk
 * الذي يضبط النقاط على بكسلات حقيقية، والقص نفسه استخراج بكسل-دقيق (extract)
 * بلا أي إعادة عيّنة — لا يمس الجودة، والقراءة تسلسلية بترتيب الصفحات الأصلي
 * فلا يختل ترتيب القصة.
 */
/** خطة الدمج متساوي الارتفاع: حدود حسابية نقية تُبنى منها المجموعات قبل أي ضبط بكسلي. */
export type UniformMergePlan = {
  /** مجموع ارتفاعات الصفحات. */
  total: number;
  /** عدد الصور الناتجة. */
  groupCount: number;
  /** الارتفاع المثالي لكل صورة (المجموع ÷ العدد). */
  ideal: number;
  /** الحدود التراكمية لبداية كل صفحة في الفضاء المدمج. */
  cumulative: number[];
  /** نقاط القص المثالية بين الصور قبل أي ضبط بكسلي. */
  idealCuts: number[];
  /** مجموعات الشرائح عند نقاط القص المحسوبة (انزلاق حدود الصفحات). */
  groups: MergeSlice[][];
};

/** يبني مجموعات الشرائح من نقاط قص محددة في الفضاء المدمج — تغطية متصلة بلا فقدان. */
function buildMergeGroupsFromCuts(groupCuts: number[], heights: number[], cumulative: number[], total: number): MergeSlice[][] {
  const groupCount = groupCuts.length + 1;
  const groups: MergeSlice[][] = [];
  let cutIndex = 0;
  let cursor = 0;
  for (let group = 0; group < groupCount; group += 1) {
    const end = group === groupCount - 1 ? total : groupCuts[cutIndex++]!;
    const slices: MergeSlice[] = [];
    while (cursor < end) {
      let pageIndex = 0;
      while (pageIndex < heights.length && cumulative[pageIndex + 1]! <= cursor) pageIndex += 1;
      const pageStart = cumulative[pageIndex]!;
      const pageHeight = heights[pageIndex]!;
      const sliceHeight = Math.min(pageStart + pageHeight, end) - cursor;
      slices.push({ pageIndex, top: cursor - pageStart, height: sliceHeight });
      cursor += sliceHeight;
    }
    groups.push(slices);
  }
  return groups;
}

/**
 * الخطة الحسابية النقية للدمج متساوي الارتفاع (قبل القص الذكي البكسلي):
 *
 * 1. مجموع ارتفاع الصفحات T ≤ السقف؟ صورة واحدة بلا أي قص (سلوك الفصول الصغيرة).
 * 2. وإلا العدد الأدنى للصور N = ⌈T ÷ السقف⌉ والارتفاع المثالي = T ÷ N.
 * 3. نقاط القص عند حدود المثالي مع انزلاق كل نقطة إلى أقرب حد صفحة داخل
 *    هامش صغير لتفادي شرائح الضجير — وإن خال الانزلاق السقف عادت النقاط للمثالي.
 */
export function planUniformMerge(heights: number[], heightCap: number): UniformMergePlan {
  const cumulative: number[] = [0];
  for (const height of heights) cumulative.push(cumulative[cumulative.length - 1]! + height);
  const total = cumulative[cumulative.length - 1]!;

  const wholePageSlices = (): MergeSlice[][] => [
    heights.map((height, pageIndex) => ({ pageIndex, top: 0, height })),
  ];

  if (total <= heightCap) {
    return { total, groupCount: 1, ideal: total, cumulative, idealCuts: [], groups: wholePageSlices() };
  }

  const groupCount = Math.ceil(total / heightCap);
  const ideal = total / groupCount;
  const snapTolerance = Math.min(500, Math.max(120, Math.round(ideal * 0.02)));

  // القص المثالي مقرّبًا لبكسل — المجموعة الأخيرة تمتص التقريب فمجموع الشرائح = T تمامًا.
  const idealCuts = Array.from({ length: groupCount - 1 }, (_, k) => Math.round((k + 1) * ideal));

  const cuts = idealCuts.map((cut, k) => {
    const previousIdeal = k === 0 ? 0 : idealCuts[k - 1]!;
    const nextIdeal = k + 1 < idealCuts.length ? idealCuts[k + 1]! : total;
    let nearest = cut;
    let nearestDistance = Number.POSITIVE_INFINITY;
    for (let index = 1; index < cumulative.length - 1; index += 1) {
      const boundary = cumulative[index]!;
      const distance = Math.abs(boundary - cut);
      if (distance < nearestDistance) {
        nearestDistance = distance;
        nearest = boundary;
      }
    }
    if (nearestDistance > snapTolerance) return cut;
    if (nearest <= previousIdeal || nearest >= nextIdeal) return cut;
    return nearest;
  });

  // التحقق من السقف بعد الانزلاق — أي تجاوز يعيد كل النقاط إلى المثالي
  // (القص المثالي مضمون داخل السقف: كل مجموعة = المثالي ± تقريب بكسل).
  const buildGroups = (groupCuts: number[]): MergeSlice[][] =>
    buildMergeGroupsFromCuts(groupCuts, heights, cumulative, total);

  for (let group = 0; group < groupCount; group += 1) {
    const start = group === 0 ? 0 : cuts[group - 1]!;
    const end = group === groupCount - 1 ? total : cuts[group]!;
    if (end - start > heightCap + 1) {
      return { total, groupCount, ideal, cumulative, idealCuts, groups: buildGroups(idealCuts) };
    }
  }
  return { total, groupCount, ideal, cumulative, idealCuts, groups: buildGroups(cuts) };
}

/** واجهة متوافقة مع الاستدعاءات القديمة: مجموعات الخطة الحسابية فقط. */
export function planUniformMergeGroups(heights: number[], heightCap: number): MergeSlice[][] {
  return planUniformMerge(heights, heightCap).groups;
}

/** نتيجة القص الذكي: نقاط القص النهائية وعدد الإزاحات والخياطات. */
export type MergeCutRefinement = {
  cuts: number[];
  movedToBlank: number;
  repairedSeams: number;
};

/** حبر أسطر مدى من البكسلات: عدّاد بكسلات تحت عتبة البياض وعدّاد تحت عتبة الدكنة. */
type BandInk = { ink: Uint32Array; dark: Uint32Array };

/**
 * القص الذكي المرن فوق الخطة الحسابية — يعيد نقاط قص معدّلة على بكسلات حقيقية:
 *
 * 1. **إزاحة إلى سطر فارغ**: لكل نقطة مثالية يُقرأ حبر المدى ±SMART_CUT_SEARCH
 *    حولها (نطاقات ضيقة فقط — لا فك كامل للصفحات) ويُقص عند أقرب سطر لا يحمل
 *    أي بكسل أدكن من SMART_CUT_BLANK_THRESHOLD — فلا تُقطع فقاعة أو لوحة.
 * 2. **خياطة احتياطية**: إن كان الرسم كثيفًا حول النقطة فلا سطر فارغ، والقص
 *    يمر عبر حبر داكن يلامس أعلى الصورة التالية، يُزاح الخط إلى نهاية تلك
 *    الشريحة المعلقة: آخر سطر حبر + REPAIR_MARGIN داخل فجوة صفّية مؤكدة
 *    (REPAIR_BLANK_GAP على الأقل، حتى REPAIR_MARGIN) ضمن REPAIR_MAX_SCAN —
 *    فتكتمل الرسمة في الصورة السابقة والشريحة لم تُنقل ولا أُعيد رسمها.
 * 3. **قيود صارمة**: كل مجموعة تبقى ≤ heightCap (إلا زحف الخياطة وحده، ثمن
 *    إكمال فقاعة كانت ستنقطع)، والنقاط متزايدة تمامًا وكل مجموعة ≥ سطر واحد،
 *    والتغطية عبر buildMergeGroupsFromCuts متصلة من أول بكسل لآخره مهما كانت
 *    النقاط — فلا صف يُفقد ولا يُكرر أبدًا.
 */
export async function refineMergeCutsAgainstInk(params: {
  idealCuts: number[];
  total: number;
  heights: number[];
  cumulative: number[];
  pagePaths: string[];
  dimensions: Array<{ width?: number; height?: number }>;
  heightCap: number;
}): Promise<MergeCutRefinement> {
  const { idealCuts, total, heights, cumulative, pagePaths, dimensions, heightCap } = params;
  if (!idealCuts.length) return { cuts: [], movedToBlank: 0, repairedSeams: 0 };

  /** يقرأ حبر نطاق صفوف من صفحة واحدة — استخراج ضيق بلا فك كامل. */
  const readPageBand = async (pageIndex: number, startRow: number, rowCount: number): Promise<BandInk> => {
    const pageWidth = dimensions[pageIndex]?.width ?? 0;
    const pageHeight = heights[pageIndex]!;
    if (pageWidth <= 0 || startRow < 0 || rowCount <= 0 || startRow + rowCount > pageHeight) {
      throw new Error("تعذر تحديد مدى قراءة البكسلات للقص الذكي.");
    }
    const { data, info } = await sharp(pagePaths[pageIndex]!)
      .extract({ left: 0, top: startRow, width: pageWidth, height: rowCount })
      .flatten({ background: { r: 255, g: 255, b: 255 } })
      .grayscale()
      .raw()
      .toBuffer({ resolveWithObject: true });
    const channels = Math.max(1, info.channels);
    const ink = new Uint32Array(rowCount);
    const dark = new Uint32Array(rowCount);
    for (let y = 0; y < rowCount; y += 1) {
      let inkPixels = 0;
      let darkPixels = 0;
      const rowOffset = y * pageWidth * channels;
      for (let x = 0; x < pageWidth; x += 1) {
        const value = data[rowOffset + x * channels]!;
        if (value < SMART_CUT_BLANK_THRESHOLD) inkPixels += 1;
        if (value < REPAIR_INK_THRESHOLD) darkPixels += 1;
      }
      ink[y] = inkPixels;
      dark[y] = darkPixels;
    }
    return { ink, dark };
  };

  /** يقرأ حبر الأسطر [fromRow, toRow) من الفضاء المدمج عبر الصفحات المتقاطعة. */
  const readMergedInk = async (fromRow: number, toRow: number): Promise<BandInk> => {
    const rowCount = Math.max(0, toRow - fromRow);
    const ink = new Uint32Array(rowCount);
    const dark = new Uint32Array(rowCount);
    let cursor = fromRow;
    while (cursor < toRow) {
      let pageIndex = 0;
      while (pageIndex < heights.length && cumulative[pageIndex + 1]! <= cursor) pageIndex += 1;
      if (pageIndex >= heights.length) throw new Error("تعذر تحديد الصفحة عند مدى القص الذكي.");
      const bandStartInPage = cursor - cumulative[pageIndex]!;
      const bandRows = Math.min(heights[pageIndex]! - bandStartInPage, toRow - cursor);
      const band = await readPageBand(pageIndex, bandStartInPage, bandRows);
      ink.set(band.ink, cursor - fromRow);
      dark.set(band.dark, cursor - fromRow);
      cursor += bandRows;
    }
    return { ink, dark };
  };

  const cuts: number[] = [];
  let movedToBlank = 0;
  let repairedSeams = 0;

  for (let k = 0; k < idealCuts.length; k += 1) {
    const ideal = idealCuts[k]!;
    const previousCut = k === 0 ? 0 : cuts[k - 1]!;
    const nextIdeal = k + 1 < idealCuts.length ? idealCuts[k + 1]! : total;
    const isLastCut = k === idealCuts.length - 1;

    // قيود النقطة: داخل مدى البحث، والمجموعة المحاذية داخل السقف، وبقي سطر
    // واحد على الأقل لكل مجموعة — والمثالي نفسه داخل المدى دائمًا.
    let lo = Math.max(ideal - SMART_CUT_SEARCH, previousCut + 1);
    let hi = Math.min(ideal + SMART_CUT_SEARCH, previousCut + heightCap);
    if (isLastCut) lo = Math.max(lo, total - heightCap);
    hi = Math.min(hi, total - 1);
    if (lo > hi) lo = hi = Math.min(Math.max(ideal, previousCut + 1), total - 1);
    const fallbackCut = Math.min(hi, Math.max(lo, ideal));

    let cut = fallbackCut;
    const blankWindow = await readMergedInk(lo, hi + 1);
    let bestRow = -1;
    let bestDistance = Number.POSITIVE_INFINITY;
    for (let row = lo; row <= hi; row += 1) {
      if (blankWindow.ink[row - lo] !== 0) continue;
      const distance = Math.abs(row - ideal);
      if (distance < bestDistance) {
        bestDistance = distance;
        bestRow = row;
      }
    }

    if (bestRow >= 0) {
      cut = bestRow;
      if (cut !== ideal) movedToBlank += 1;
    } else {
      // لا سطر فارغ في المدى (رسم كثيف): إن كان الخط يلامس حبرًا داكنًا
      // أعلى الصورة التالية يُزاح إلى نهاية الشريحة المعلقة بعد فجوة مؤكدة.
      const scanEnd = Math.min(cut + REPAIR_MAX_SCAN + REPAIR_MARGIN, nextIdeal, total);
      if (scanEnd > cut + 1) {
        const scan = await readMergedInk(cut, scanEnd);
        let attachesToTop = false;
        let lastInkRow = -1;
        let gapAfterLastInk = 0;
        let repairedCut = -1;
        for (let i = 0; i < scan.dark.length; i += 1) {
          if (i < 5 && !attachesToTop && scan.dark[i]! >= REPAIR_ROW_INK_MIN) attachesToTop = true;
          if (scan.dark[i]! >= REPAIR_ROW_INK_MIN) {
            lastInkRow = cut + i;
            gapAfterLastInk = 0;
          } else if (lastInkRow >= 0) {
            gapAfterLastInk += 1;
            if (gapAfterLastInk >= REPAIR_MARGIN) {
              repairedCut = lastInkRow + REPAIR_MARGIN;
              break;
            }
          }
        }
        if (repairedCut < 0 && lastInkRow >= 0 && gapAfterLastInk >= REPAIR_BLANK_GAP) {
          repairedCut = lastInkRow + gapAfterLastInk;
        }
        if (attachesToTop && repairedCut > cut && repairedCut < nextIdeal) {
          cut = repairedCut;
          repairedSeams += 1;
        }
      }
    }

    cuts.push(cut);
  }

  return { cuts, movedToBlank, repairedSeams };
}

async function renderSliceGroupToFile(
  slices: MergeSlice[],
  pagePaths: string[],
  dimensions: Array<{ width?: number; height?: number }>,
  width: number,
  outputPath: string,
  output: ImageOutputConfig
): Promise<number> {
  const height = slices.reduce((sum, slice) => sum + slice.height, 0);
  if (!height || !width) throw new Error("تعذر قراءة أبعاد صورة الفصل.");
  const composites: Array<{ input: string | Buffer; left: number; top: number }> = [];
  let top = 0;
  for (const slice of slices) {
    const dims = dimensions[slice.pageIndex];
    const pageWidth = dims?.width ?? 0;
    const pageHeight = dims?.height ?? 0;
    // الصفحة الكاملة تُركَّب من ملفها مباشرة بلا فكّ إضافي — نفس مسار المحرك القديم.
    const isWholePage = slice.top === 0 && (pageHeight === 0 || slice.height === pageHeight);
    if (isWholePage) {
      composites.push({
        input: pagePaths[slice.pageIndex]!,
        left: Math.floor((width - (pageWidth || width)) / 2),
        top,
      });
    } else {
      // جزء مقصوص من صفحة: استخراج بكسل-دقيق ثم تركيب — بلا أي إعادة عيّنة.
      const regionWidth = pageWidth || (await sharp(pagePaths[slice.pageIndex]!).metadata()).width || width;
      const region = await sharp(pagePaths[slice.pageIndex]!)
        .extract({ left: 0, top: slice.top, width: regionWidth, height: slice.height })
        .png()
        .toBuffer();
      composites.push({ input: region, left: Math.floor((width - regionWidth) / 2), top });
    }
    top += slice.height;
  }
  const canvas = sharp({ create: { width, height, channels: 4, background: { r: 255, g: 255, b: 255, alpha: 1 } } }).composite(composites);
  await encodeWithOutputConfig(canvas, output).toFile(outputPath);
  return height;
}

/**
 * يختار العرض الموحد لصفحات الفصل: العرض الأكثر تكرارًا بين الصفحات هو العرض
 * الحقيقي للعمل، وعند التعادل يُرجّح العرض الأكبر حفاظًا على أكبر قدر من التفاصيل.
 * الصفحات الخالية من العرض (تعذر قراءتها) تُتجاهل في الاختيار.
 */
export function pickUniformWidth(widths: Array<number | null | undefined>): number {
  const counts = new Map<number, number>();
  for (const width of widths) {
    if (!width || width <= 0) continue;
    counts.set(width, (counts.get(width) ?? 0) + 1);
  }
  let best = 0;
  let bestCount = 0;
  for (const [width, count] of Array.from(counts)) {
    if (count > bestCount || (count === bestCount && width > best)) {
      best = width;
      bestCount = count;
    }
  }
  return best;
}

/**
 * يوحدّ عرض صفحات الفصل بالتحجير لا بالحشو: كل صفحة عرضها غير العرض المشترك
 * تُحجّم إليه مع الحفاظ على نسبتها (تُصغّر الأعرض وتُكبّر الأضيق قليلًا)، فلا
 * تظهر خلفية بيضاء على جانبي الصفحات أبدًا — كانت تُفرش سابقًا فوق لوحة
 * بعرض أكبر صفحة مع توسيطها فتبدو مبطنة بالأبيض.
 * التسلسل مقصود: صفحة واحدة في الذاكرة في كل لحظة، والناتج يُكتب على القرص.
 */
async function scalePagesToUniformWidth(
  pagePaths: string[],
  dimensions: Array<{ width?: number; height?: number }>,
  width: number,
  scaledDir: string
): Promise<{ paths: string[]; dimensions: Array<{ width?: number; height?: number }> }> {
  await mkdir(scaledDir, { recursive: true });
  const paths = [...pagePaths];
  const nextDimensions = [...dimensions];
  for (let index = 0; index < pagePaths.length; index += 1) {
    const pageWidth = dimensions[index]?.width ?? 0;
    // الصفحات المعطوبة بلا عرض مقروء تُترك كما هي — سلوك التعامل معها لا يتغير.
    if (!pageWidth || pageWidth === width) continue;
    const targetPath = path.join(scaledDir, `${path.basename(pagePaths[index]!)}.scaled.png`);
    await sharp(pagePaths[index]!)
      .resize({ width })
      // ملف وسيط مؤقت على القرص: ضغط معقول أسرع من الأقصى ويوفر مساحة العمل.
      .png({ compressionLevel: 6, adaptiveFiltering: true, palette: false })
      .toFile(targetPath);
    paths[index] = targetPath;
    // نقرأ الأبعاد الفعلية للملف المحجّم — القسمة والتقريب قد يفرقان بكسلًا عن الحساب.
    nextDimensions[index] = await sharp(targetPath).metadata();
  }
  return { paths, dimensions: nextDimensions };
}

/**
 * يدمج ملفات صور موجودة مسبقًا على القرص في صور طويلة تُكتب إلى القرص فورًا،
 * مجموعة واحدة في كل مرة. نفس منطق الدمج المستخدم لصفحات الفصول المسحوبة،
 * لكن دون أي تنزيل — يُستخدم لأمر الدمج اليدوي (صور جاهزة من ZIP أو Drive).
 * تنظيف الملفات المؤقتة يتم عبر cleanup() في كل الحالات.
 * أبعاد الدمج (سقف الارتفاع والعرض) قابلة للتخصيص من إعدادات السيرفر —
 * والناقص منها يعود إلى الافتراضي (15000px وعرض الصفحات الأكثر تكرارًا).
 */
export async function openLocalImageMergeSession(
  pagePaths: string[],
  onProgress?: MergeProgressListener,
  output: ImageOutputConfig = { ...DEFAULT_IMAGE_OUTPUT },
  dimensions?: Partial<MergeDimensions>
): Promise<ChapterMergeSession> {
  if (!pagePaths.length) {
    return { images: [], notes: [], cleanup: async () => {} };
  }
  const dir = await mkdtemp(path.join(tmpdir(), "manga-merge-"));
  try {
    const originalDimensions = await Promise.all(pagePaths.map(pagePath => sharp(pagePath).metadata()));
    const uniformWidth = pickUniformWidth(originalDimensions.map(item => item.width));
    if (!uniformWidth) throw new Error("تعذر تحديد عرض موحد لصفحات الفصل.");
    // العرض المستهدف: تخصيص السيرفر إن وُجد وإلا العرض الأكثر تكرارًا.
    const width = normalizeMergeWidth(dimensions?.width) ?? uniformWidth;
    // سقف الارتفاع كما اختاره السيرفر لكل الصيغ — الصيغة التي لا تحتمل الطول
    // (WebP فوق 16000px أو ميزانية JPG) تُحوّل صورها إلى PNG بدل تقليص السقف.
    const heightCap = normalizeMergeHeightCap(dimensions?.heightCap ?? DEFAULT_MERGE_HEIGHT_CAP);
    const notes: string[] = [];

    // توحيد العرض بالتحجير: الصفحات التي عرضها يساوي العرض المستهدف تبقى كما
    // هي بلا إعادة ترميز، وما خالفه يُحجّم فقط (يشمل تخصيص العرض المختلف
    // عن عرض الصفحات — حينها تُحجّم كل الصفحات إلى العرض المطلوب).
    const { paths: effectivePaths, dimensions: effectiveDimensions } = originalDimensions.every(
      item => !item.width || item.width === width
    )
      ? { paths: pagePaths, dimensions: originalDimensions }
      : await scalePagesToUniformWidth(pagePaths, originalDimensions, width, path.join(dir, "scaled"));

    // التجميع متساوي الارتفاع: مجموع الأطوال يوزَّع بالتساوي على أقل عدد
    // صور داخل السقف، ثم يُضبط القص بكسليًا (القص الذكي): كل فاصل يُزاح إلى
    // أقرب سطر فارغ حتى لا تنقطع فقاعة أو رسمة، ومع الرسم الكثيف تُخاط
    // الشريحة المعلقة أعلى الصورة التالية بنهاية سابقتها — والمجموعات الأطول
    // من ميزانية صيغة الترميز تُحوّل إلى PNG بلا أي فقدان داخل resolveGroupOutput.
    const heights = effectiveDimensions.map((item, index) => {
      const height = item?.height ?? 0;
      if (!height) throw new Error(`تعذر قراءة ارتفاع الصفحة ${index + 1}.`);
      return height;
    });
    const plan = planUniformMerge(heights, heightCap);
    let groups = plan.groups;
    if (plan.groupCount > 1) {
      try {
        const refinement = await refineMergeCutsAgainstInk({
          idealCuts: plan.idealCuts,
          total: plan.total,
          heights,
          cumulative: plan.cumulative,
          pagePaths: effectivePaths,
          dimensions: effectiveDimensions,
          heightCap,
        });
        if (refinement.cuts.length === plan.idealCuts.length) {
          groups = buildMergeGroupsFromCuts(refinement.cuts, heights, plan.cumulative, plan.total);
          if (refinement.movedToBlank > 0) {
            notes.push(`القص الذكي: أُزح ${refinement.movedToBlank} من ${plan.idealCuts.length} فواصل إلى أقرب سطر فارغ تفاديًا لقطع فقاعة أو رسمة.`);
          }
          if (refinement.repairedSeams > 0) {
            notes.push(`القص الذكي: خُيطت ${refinement.repairedSeams} حافة صورة كان يقطعها الفاصل عبر إلحاق شريحتها المعلقة بنهاية الصورة السابقة.`);
          }
        }
      } catch {
        notes.push("تعذر قراءة بكسلات الصفحات للقص الذكي — بقيت فواصل القص الحسابية كما هي.");
      }
    }

    const images: MergedChapterFile[] = [];
    // التسلسل مقصود: تُرسم مجموعة واحدة في كل مرة وتُكتب إلى القرص فورًا.
    for (let groupIndex = 0; groupIndex < groups.length; groupIndex += 1) {
      const group = groups[groupIndex]!;
      const groupHeight = group.reduce((sum, slice) => sum + slice.height, 0);
      // ترميز كل صورة حسب ميزانية صيغتها: تخطي اللوحة أو تحويل الصورة
      // الأطول من الميزانية إلى PNG بلا أي تقسيم — مع ملاحظة لكل منها.
      const { output: groupOutput, note } = resolveGroupOutput(output, width, groupHeight, group.length);
      if (note) notes.push(note);
      const extension = imageOutputExtension(groupOutput.format);
      const outputPath = path.join(dir, `merged-${String(groupIndex + 1).padStart(3, "0")}.${extension}`);
      const height = await renderSliceGroupToFile(group, effectivePaths, effectiveDimensions, width, outputPath, groupOutput);
      images.push({ filePath: outputPath, width, height, mimeType: FORMAT_MIME[groupOutput.format] });
      if (onProgress) {
        try { await onProgress({ phase: "merging", done: groupIndex + 1, total: groups.length }); } catch { /* فشل الإشعار لا يُفشل المعالجة */ }
      }
    }
    return { images, notes, cleanup: () => rm(dir, { recursive: true, force: true }) };
  } catch (error) {
    await rm(dir, { recursive: true, force: true });
    throw error;
  }
}

/**
 * ينزّل صفحات الفصل إلى ملفات مؤقتة على القرص **بدون أي دمج** — يستخدمه
 * /فصل حين يكون دمج الصفحات معطّلًا في إعدادات السيرفر: تُرفع الصفحات
 * كما هي بأصلها دون إعادة ترميز. فك تشويش GigaViewer يبقى شغالًا لأنه
 * جزء من التنزيل نفسه، ونوع كل صورة يُقرأ من ملفها الفعلي.
 * تنظيف الملفات المؤقتة يتم عبر cleanup() في كل الحالات.
 */
export type ChapterPageFile = {
  filePath: string;
  width: number;
  height: number;
  mimeType: string;
};

export type ChapterPagesSession = {
  pages: ChapterPageFile[];
  cleanup(): Promise<void>;
};

/** أنواع MIME المعروفة لصيغ الصور التي قد تخدمها مواقع المانهوا. */
const MIME_BY_SHARP_FORMAT: Record<string, string> = {
  jpeg: "image/jpeg",
  png: "image/png",
  webp: "image/webp",
  gif: "image/gif",
  avif: "image/avif",
  tiff: "image/tiff",
};

export async function openChapterPagesSession(
  pageUrls: string[],
  onProgress?: MergeProgressListener
): Promise<ChapterPagesSession> {
  if (!pageUrls.length) {
    return { pages: [], cleanup: async () => {} };
  }
  const dir = await mkdtemp(path.join(tmpdir(), "manga-pages-"));
  try {
    const pagePaths = await downloadPagesToTemp(pageUrls, dir, onProgress);
    const pages: ChapterPageFile[] = [];
    for (let index = 0; index < pagePaths.length; index += 1) {
      const filePath = pagePaths[index]!;
      const metadata = await sharp(filePath).metadata();
      const width = metadata.width ?? 0;
      const height = metadata.height ?? 0;
      if (!width || !height) throw new Error(`تعذر قراءة أبعاد الصفحة ${index + 1}.`);
      pages.push({
        filePath,
        width,
        height,
        mimeType: MIME_BY_SHARP_FORMAT[metadata.format ?? ""] ?? "image/jpeg",
      });
    }
    return { pages, cleanup: () => rm(dir, { recursive: true, force: true }) };
  } catch (error) {
    await rm(dir, { recursive: true, force: true });
    throw error;
  }
}

/**
 * ينزّل الصفحات إلى ملفات مؤقتة على القرص ثم يدمجها في صور طويلة تُكتب إلى
 * القرص فورًا، مجموعة واحدة في كل مرة. هذا يبقي ذروة استهلاك الذاكرة قريبة
 * من حجم مجموعة واحدة مهما كان عدد صفحات الفصل، بدل تحميل كل الصفحات وكل
 * الصور المدمجة في الذاكرة معًا (سبب قتل الحاوية بخطأ 137 على Railway).
 * تنظيف الملفات المؤقتة يتم عبر cleanup() في كل الحالات.
 */
export async function openChapterMergeSession(
  pageUrls: string[],
  onProgress?: MergeProgressListener,
  output: ImageOutputConfig = { ...DEFAULT_IMAGE_OUTPUT },
  dimensions?: Partial<MergeDimensions>
): Promise<ChapterMergeSession> {
  if (!pageUrls.length) {
    return { images: [], notes: [], cleanup: async () => {} };
  }
  const downloadDir = await mkdtemp(path.join(tmpdir(), "manga-pages-"));
  try {
    const pagePaths = await downloadPagesToTemp(pageUrls, downloadDir, onProgress);
    const session = await openLocalImageMergeSession(pagePaths, onProgress, output, dimensions);
    const sessionCleanup = session.cleanup;
    session.cleanup = async () => {
      await sessionCleanup();
      await rm(downloadDir, { recursive: true, force: true });
    };
    return session;
  } catch (error) {
    await rm(downloadDir, { recursive: true, force: true });
    throw error;
  }
}

/**
 * واجهة قديمة تُعيد Buffers للتوافق مع الاختبارات والسكربتات؛ عامل الفصول
 * يستخدم openChapterMergeSession لتفادي الاحتفاظ بكل الصور في الذاكرة.
 */
export async function mergeChapterPages(
  pageUrls: string[],
  output: ImageOutputConfig = { ...DEFAULT_IMAGE_OUTPUT },
  dimensions?: Partial<MergeDimensions>
): Promise<MergedChapterImage[]> {
  const session = await openChapterMergeSession(pageUrls, undefined, output, dimensions);
  try {
    return await Promise.all(
      session.images.map(async image => ({
        data: await readFile(image.filePath),
        width: image.width,
        height: image.height,
        mimeType: image.mimeType,
      }))
    );
  } finally {
    await session.cleanup();
  }
}
