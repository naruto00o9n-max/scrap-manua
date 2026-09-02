import { createWriteStream } from "node:fs";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { Readable, Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
import sharp from "sharp";

// التحكم في استهلاك ذاكرة libvips: بلا تخزين مؤقت للصور المفككة ومعالجة تسلسلية،
// حتى لا تقتل الحاوية العملية عند دمج فصول طويلة (خطأ exit 137 / OOM).
sharp.cache(false);
sharp.concurrency(1);

const MAX_PAGE_SIZE_BYTES = 40 * 1024 * 1024;
const MIN_OUTPUT_HEIGHT = 11000;
const MAX_OUTPUT_HEIGHT = 14000;
const OUTPUT_MIME = "image/png";
const PAGE_DOWNLOAD_CONCURRENCY = 6;

export type MergedChapterImage = {
  data: Buffer;
  width: number;
  height: number;
  mimeType: typeof OUTPUT_MIME;
};

export type MergedChapterFile = {
  filePath: string;
  width: number;
  height: number;
  mimeType: typeof OUTPUT_MIME;
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
 * قواعد التجميع نفسها السابقة: لا تقسيم لأي صفحة ولا تصغير؛ الصفحة الأطول من
 * 14000px تبقى مستقلة كاملة، والصفحة الأطول من 1000px تُضم فقط إلى مجموعة
 * مجاورة إذا كان الناتج المنظم بين 11000 و14000px، والبقية تتراكم في مجموعات
 * تصل إلى الحد الأدنى دون تجاوز الحد الأعلى. عدم القص هو الأولوية المطلقة.
 */
function groupPageIndexes(dimensions: Array<{ height?: number }>): number[][] {
  const groups: number[][] = [];
  let current: number[] = [];
  let currentHeight = 0;
  const flushCurrent = () => {
    if (current.length) groups.push(current);
    current = [];
    currentHeight = 0;
  };
  for (let index = 0; index < dimensions.length; index += 1) {
    const height = dimensions[index]?.height ?? 0;
    if (!height) throw new Error(`تعذر قراءة ارتفاع الصفحة ${index + 1}.`);
    if (height > MAX_OUTPUT_HEIGHT) {
      flushCurrent();
      groups.push([index]);
      continue;
    }
    if (height > 1000) {
      flushCurrent();
      const candidate: number[] = [index];
      let candidateHeight = height;
      let next = index + 1;
      while (candidateHeight < MIN_OUTPUT_HEIGHT && next < dimensions.length) {
        const nextHeight = dimensions[next]?.height ?? 0;
        if (!nextHeight || candidateHeight + nextHeight > MAX_OUTPUT_HEIGHT) break;
        candidate.push(next);
        candidateHeight += nextHeight;
        next += 1;
      }
      if (candidateHeight >= MIN_OUTPUT_HEIGHT && candidateHeight <= MAX_OUTPUT_HEIGHT) {
        groups.push(candidate);
        index = next - 1;
      } else {
        groups.push([index]);
      }
      continue;
    }
    if (current.length && currentHeight + height > MAX_OUTPUT_HEIGHT) flushCurrent();
    current.push(index);
    currentHeight += height;
    if (currentHeight >= MIN_OUTPUT_HEIGHT) flushCurrent();
  }
  flushCurrent();
  return groups;
}

async function renderGroupToFile(
  group: number[],
  pagePaths: string[],
  dimensions: Array<{ width?: number; height?: number }>,
  width: number,
  outputPath: string
): Promise<number> {
  const dims = group.map(index => dimensions[index]!);
  const height = dims.reduce((sum, item) => sum + (item.height ?? 0), 0);
  if (!height || !width) throw new Error("تعذر قراءة أبعاد صورة الفصل.");
  const composites = group.map((pageIndex, position) => ({
    input: pagePaths[pageIndex]!,
    left: Math.floor((width - (dims[position]?.width ?? width)) / 2),
    top: dims.slice(0, position).reduce((sum, item) => sum + (item.height ?? 0), 0),
  }));
  await sharp({ create: { width, height, channels: 4, background: { r: 255, g: 255, b: 255, alpha: 1 } } })
    .composite(composites)
    .png({ compressionLevel: 0, adaptiveFiltering: false, palette: false })
    .toFile(outputPath);
  return height;
}

/**
 * يدمج ملفات صور موجودة مسبقًا على القرص في صور طويلة تُكتب إلى القرص فورًا،
 * مجموعة واحدة في كل مرة. نفس منطق الدمج المستخدم لصفحات الفصول المسحوبة،
 * لكن دون أي تنزيل — يُستخدم لأمر الدمج اليدوي (صور جاهزة من ZIP أو Drive).
 * تنظيف الملفات المؤقتة يتم عبر cleanup() في كل الحالات.
 */
export async function openLocalImageMergeSession(
  pagePaths: string[],
  onProgress?: MergeProgressListener
): Promise<ChapterMergeSession> {
  if (!pagePaths.length) {
    return { images: [], cleanup: async () => {} };
  }
  const dir = await mkdtemp(path.join(tmpdir(), "manga-merge-"));
  try {
    const dimensions = await Promise.all(pagePaths.map(pagePath => sharp(pagePath).metadata()));
    const width = Math.max(...dimensions.map(item => item.width ?? 0));
    if (!width) throw new Error("تعذر تحديد أكبر عرض لصفحات الفصل.");

    const groups = groupPageIndexes(dimensions);
    const images: MergedChapterFile[] = [];
    // التسلسل مقصود: تُرسم مجموعة واحدة في كل مرة وتُكتب إلى القرص فورًا.
    for (let groupIndex = 0; groupIndex < groups.length; groupIndex += 1) {
      const outputPath = path.join(dir, `merged-${String(groupIndex + 1).padStart(3, "0")}.png`);
      const height = await renderGroupToFile(groups[groupIndex]!, pagePaths, dimensions, width, outputPath);
      images.push({ filePath: outputPath, width, height, mimeType: OUTPUT_MIME });
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
  onProgress?: MergeProgressListener
): Promise<ChapterMergeSession> {
  if (!pageUrls.length) {
    return { images: [], cleanup: async () => {} };
  }
  const downloadDir = await mkdtemp(path.join(tmpdir(), "manga-pages-"));
  try {
    const pagePaths = await downloadPagesToTemp(pageUrls, downloadDir, onProgress);
    const session = await openLocalImageMergeSession(pagePaths, onProgress);
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
export async function mergeChapterPages(pageUrls: string[]): Promise<MergedChapterImage[]> {
  const session = await openChapterMergeSession(pageUrls);
  try {
    return await Promise.all(
      session.images.map(async image => ({
        data: await readFile(image.filePath),
        width: image.width,
        height: image.height,
        mimeType: OUTPUT_MIME,
      }))
    );
  } finally {
    await session.cleanup();
  }
}
