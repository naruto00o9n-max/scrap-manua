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
// سقف ارتفاع الصورة المدمجة: عتبة مستهدفة ~14000px مع هامش مرونة يسمح
// بإغلاق المجموعة عندما ترفعها الصفحة التالية قليلًا فوق العتبة
// (مثل 5000+5000+4316 = 14316 أو 5000+5000+4925 = 14925) بدل ترك صفحات
// صغيرة مستقلة — طلب المستخدم: «دمج اثنين أو ثلاثة ليصل العتبة».
const FLEX_OUTPUT_HEIGHT = 15000;
const PAGE_DOWNLOAD_CONCURRENCY = 6;

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
  if (parsed.protocol !== "https:" || parsed.username || parsed.password || parsed.hostname === "localhost") {
    throw new Error(`رابط الصفحة ${index} غير آمن.`);
  }
  let lastError: unknown;
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      const response = await fetch(parsed, { redirect: "error", signal: AbortSignal.timeout(30_000) });
      if (!response.ok) throw new Error(`تعذر تنزيل الصفحة ${index} (${response.status}).`);
      const contentType = response.headers.get("content-type")?.toLowerCase() ?? "";
      if (!contentType.startsWith("image/")) throw new Error(`الصفحة ${index} ليست صورة.`);
      const contentLength = Number(response.headers.get("content-length") ?? "0");
      if (Number.isFinite(contentLength) && contentLength > MAX_PAGE_SIZE_BYTES) throw new Error(`الصفحة ${index} تتجاوز الحد الآمن للحجم.`);
      if (!response.body) throw new Error(`تعذر قراءة بيانات الصفحة ${index}.`);
      // تُكتب الصفحة على القرص مباشرة بدل الاحتفاظ بها في الذاكرة.
      const source = Readable.fromWeb(response.body as never);
      await pipeline(source, byteCappedStream(MAX_PAGE_SIZE_BYTES, `الصفحة ${index}`), createWriteStream(targetPath));
      return;
    } catch (error) {
      lastError = error;
      if (attempt === 0) await new Promise(resolve => setTimeout(resolve, 250));
    }
  }
  throw lastError instanceof Error ? lastError : new Error(`تعذر تنزيل الصفحة ${index}.`);
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
 * التجميع الاحترافي المرن: لا قص لأي صفحة ولا حشو أبيض ولا إعادة ترتيب —
 * العرض يُوحد بالتحجير قبل التجميع، ثم تُقسم صفحات الفصل إلى أقل عدد ممكن
 * من الصور بحيث لا يتجاوز ارتفاع أي صورة سقف المرونة (15000px ≈ عتبة
 * 14000px + هامش)، وبين التوزيعات ذات العدد الأدنى يُختار التوزيع الأكثر
 * تساويًا في الارتفاع — فتخرج صور الفصل متقاربة الطول حول العتبة بدل
 * «تارة كبير وتارة صغير»، وتُدمج الصفحات الصغيرة اثنين أو ثلاثة أو أكثر
 * حتى تبلغ العتبة كما طلب المستخدم.
 *
 * الصفحة الأطول من سقف المرونة تبقى مستقلة كاملة (القص ممنوع إطلاقًا)،
 * وهي حاجز يقسم الفصل إلى نافذات متصلة تُوازن كل واحدة على حدة.
 */
function groupPageIndexes(dimensions: Array<{ height?: number }>): number[][] {
  const heights = dimensions.map((item, index) => {
    const height = item?.height ?? 0;
    if (!height) throw new Error(`تعذر قراءة ارتفاع الصفحة ${index + 1}.`);
    return height;
  });

  const groups: number[][] = [];
  let segmentStart = 0;
  const flushSegment = (endExclusive: number) => {
    if (endExclusive > segmentStart) {
      groups.push(...partitionSegmentEvenly(heights, segmentStart, endExclusive));
    }
    segmentStart = endExclusive;
  };
  for (let index = 0; index < heights.length; index += 1) {
    if (heights[index]! > FLEX_OUTPUT_HEIGHT) {
      flushSegment(index);
      groups.push([index]);
      segmentStart = index + 1;
    }
  }
  flushSegment(heights.length);
  return groups;
}

/**
 * يقسم نافذة متصلة من الصفحات (كل ارتفاعاتها داخل سقف المرونة) إلى أقل عدد
 * ممكن من المجموعات المتصلة، ثم يوازن ارتفاعات المجموعات: العدد الأدنى
 * يُحسب بتعبئة جشعة حتى السقف (مثالية لتقسيم تسلسل متصل)، وبين التوزيعات
 * ذات العدد الأدنى يُختار عبر برمجة ديناميكية التوزيع الذي يقلل مجموع
 * مربعات انحراف ارتفاع كل مجموعة عن الارتفاع المثالي (مجموع النافذة ÷
 * عددها) — أي التوزيع الأكثر تساويًا.
 */
function partitionSegmentEvenly(heights: number[], start: number, end: number): number[][] {
  const length = end - start;
  const segment = heights.slice(start, end);
  const total = segment.reduce((sum, height) => sum + height, 0);

  // العدد الأدنى للمجموعات: تعبئة جشعة حتى سقف المرونة.
  let minGroups = 1;
  let accumulated = 0;
  for (const height of segment) {
    if (accumulated > 0 && accumulated + height > FLEX_OUTPUT_HEIGHT) {
      minGroups += 1;
      accumulated = 0;
    }
    accumulated += height;
  }
  if (minGroups === 1) {
    return [Array.from({ length }, (_, offset) => start + offset)];
  }

  const ideal = total / minGroups;
  const prefix: number[] = [0];
  for (const height of segment) prefix.push(prefix[prefix.length - 1]! + height);
  const groupSum = (from: number, to: number) => prefix[to]! - prefix[from]!;

  // bestCost[g][i]: أقل تكلفة لتقسيم أول i صفحة إلى g مجموعة، وchoice[g][i]:
  // عدد الصفحات قبل المجموعة الأخيرة في التوزيع الأمثل.
  const infinite = Number.POSITIVE_INFINITY;
  const bestCost: number[][] = Array.from({ length: minGroups + 1 }, () => new Array<number>(length + 1).fill(infinite));
  const choice: number[][] = Array.from({ length: minGroups + 1 }, () => new Array<number>(length + 1).fill(-1));
  bestCost[0]![0] = 0;
  for (let groupsUsed = 1; groupsUsed <= minGroups; groupsUsed += 1) {
    for (let pages = groupsUsed; pages <= length; pages += 1) {
      // نفحص بدايات المجموعة الأخيرة من الأكبر إلى الأصغر، وعند تعادل
      // التكلفة يفوز التوزيع الذي يجعل المجموعات السابقة أكثر امتلاءً —
      // نفس روح التعبئة الجشعة: الصور الأولى ممتلئة أولًا.
      for (let previous = pages - 1; previous >= groupsUsed - 1; previous -= 1) {
        if (bestCost[groupsUsed - 1]![previous] === infinite) continue;
        const sum = groupSum(previous, pages);
        if (sum > FLEX_OUTPUT_HEIGHT) continue;
        const cost = bestCost[groupsUsed - 1]![previous]! + (sum - ideal) ** 2;
        if (cost < bestCost[groupsUsed]![pages]!) {
          bestCost[groupsUsed]![pages] = cost;
          choice[groupsUsed]![pages] = previous;
        }
      }
    }
  }

  // استخراج حدود المجموعات من جدول الاختيار (مضمونة الجدوى لأن التعبئة
  // الجشعة أثبتت أن العدد الأدنى ممكن ضمن السقف).
  const bounds: number[] = [length];
  for (let groupsUsed = minGroups; groupsUsed >= 1; groupsUsed -= 1) {
    bounds.unshift(choice[groupsUsed]![bounds[0]!]!);
  }
  const groups: number[][] = [];
  for (let groupIndex = 0; groupIndex < minGroups; groupIndex += 1) {
    const from = bounds[groupIndex]!;
    const to = bounds[groupIndex + 1]!;
    groups.push(Array.from({ length: to - from }, (_, offset) => start + from + offset));
  }
  return groups;
}

async function renderGroupToFile(
  group: number[],
  pagePaths: string[],
  dimensions: Array<{ width?: number; height?: number }>,
  width: number,
  outputPath: string,
  output: ImageOutputConfig
): Promise<number> {
  const dims = group.map(index => dimensions[index]!);
  const height = dims.reduce((sum, item) => sum + (item.height ?? 0), 0);
  if (!height || !width) throw new Error("تعذر قراءة أبعاد صورة الفصل.");
  const composites = group.map((pageIndex, position) => ({
    input: pagePaths[pageIndex]!,
    left: Math.floor((width - (dims[position]?.width ?? width)) / 2),
    top: dims.slice(0, position).reduce((sum, item) => sum + (item.height ?? 0), 0),
  }));
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
 */
export async function openLocalImageMergeSession(
  pagePaths: string[],
  onProgress?: MergeProgressListener,
  output: ImageOutputConfig = { ...DEFAULT_IMAGE_OUTPUT }
): Promise<ChapterMergeSession> {
  if (!pagePaths.length) {
    return { images: [], cleanup: async () => {} };
  }
  const dir = await mkdtemp(path.join(tmpdir(), "manga-merge-"));
  try {
    const originalDimensions = await Promise.all(pagePaths.map(pagePath => sharp(pagePath).metadata()));
    const width = pickUniformWidth(originalDimensions.map(item => item.width));
    if (!width) throw new Error("تعذر تحديد عرض موحد لصفحات الفصل.");

    // توحيد العرض بالتحجير: الصفحات التي عرضها يساوي العرض المشترك تبقى كما
    // هي بلا إعادة ترميز، وما خالفه يُحجّم فقط.
    const { paths: effectivePaths, dimensions } = originalDimensions.every(
      item => !item.width || item.width === width
    )
      ? { paths: pagePaths, dimensions: originalDimensions }
      : await scalePagesToUniformWidth(pagePaths, originalDimensions, width, path.join(dir, "scaled"));

    const groups = groupPageIndexes(dimensions);
    const images: MergedChapterFile[] = [];
    const extension = imageOutputExtension(output.format);
    // التسلسل مقصود: تُرسم مجموعة واحدة في كل مرة وتُكتب إلى القرص فورًا.
    for (let groupIndex = 0; groupIndex < groups.length; groupIndex += 1) {
      const outputPath = path.join(dir, `merged-${String(groupIndex + 1).padStart(3, "0")}.${extension}`);
      const height = await renderGroupToFile(groups[groupIndex]!, effectivePaths, dimensions, width, outputPath, output);
      images.push({ filePath: outputPath, width, height, mimeType: FORMAT_MIME[output.format] });
      if (onProgress) {
        try { await onProgress({ phase: "merging", done: groupIndex + 1, total: groups.length }); } catch { /* فشل الإشعار لا يُفشل المعالجة */ }
      }
    }
    return { images, cleanup: () => rm(dir, { recursive: true, force: true }) };
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
  output: ImageOutputConfig = { ...DEFAULT_IMAGE_OUTPUT }
): Promise<ChapterMergeSession> {
  if (!pageUrls.length) {
    return { images: [], cleanup: async () => {} };
  }
  const downloadDir = await mkdtemp(path.join(tmpdir(), "manga-pages-"));
  try {
    const pagePaths = await downloadPagesToTemp(pageUrls, downloadDir, onProgress);
    const session = await openLocalImageMergeSession(pagePaths, onProgress, output);
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
  output: ImageOutputConfig = { ...DEFAULT_IMAGE_OUTPUT }
): Promise<MergedChapterImage[]> {
  const session = await openChapterMergeSession(pageUrls, undefined, output);
  try {
    return await Promise.all(
      session.images.map(async image => ({
        data: await readFile(image.filePath),
        width: image.width,
        height: image.height,
        mimeType: FORMAT_MIME[output.format],
      }))
    );
  } finally {
    await session.cleanup();
  }
}
