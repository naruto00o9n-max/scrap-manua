import sharp from "sharp";

const MAX_PAGE_SIZE_BYTES = 40 * 1024 * 1024;
const MIN_OUTPUT_HEIGHT = 11000;
const MAX_OUTPUT_HEIGHT = 14000;
const OUTPUT_MIME = "image/png";

export type MergedChapterImage = {
  data: Buffer;
  width: number;
  height: number;
  mimeType: typeof OUTPUT_MIME;
};

async function downloadPage(url: string, index: number): Promise<Buffer> {
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
      const data = Buffer.from(await response.arrayBuffer());
      if (data.length > MAX_PAGE_SIZE_BYTES) throw new Error(`الصفحة ${index} تتجاوز الحد الآمن للحجم.`);
      return data;
    } catch (error) {
      lastError = error;
      if (attempt === 0) await new Promise(resolve => setTimeout(resolve, 250));
    }
  }
  throw lastError instanceof Error ? lastError : new Error(`تعذر تنزيل الصفحة ${index}.`);
}

async function downloadPages(urls: string[]): Promise<Buffer[]> {
  const results: Buffer[] = new Array(urls.length);
  let next = 0;
  async function worker() {
    while (true) {
      const index = next++;
      if (index >= urls.length) return;
      results[index] = await downloadPage(urls[index]!, index + 1);
    }
  }
  await Promise.all(Array.from({ length: Math.min(6, urls.length) }, () => worker()));
  return results;
}

async function renderCanvas(pages: Buffer[], width: number): Promise<MergedChapterImage> {
  const dimensions = await Promise.all(pages.map(page => sharp(page).metadata()));
  const height = dimensions.reduce((sum, item) => sum + (item.height ?? 0), 0);
  if (!height || !width) throw new Error("تعذر قراءة أبعاد صورة الفصل.");
  const composites = pages.map((page, index) => ({
    input: page,
    left: Math.floor((width - (dimensions[index]?.width ?? width)) / 2),
    top: dimensions.slice(0, index).reduce((sum, item) => sum + (item.height ?? 0), 0),
  }));
  const data = await sharp({ create: { width, height, channels: 4, background: { r: 255, g: 255, b: 255, alpha: 1 } } })
    .composite(composites)
    .png({ compressionLevel: 0, adaptiveFiltering: false, palette: false })
    .toBuffer();
  return { data, width, height, mimeType: OUTPUT_MIME };
}

/**
 * يجمع الصفحات المتتابعة في صور طويلة. لا يقسم الصفحة الواحدة ولا يصغّرها؛
 * إذا تجاوزت صفحة واحدة الحد الأعلى تُحفظ كاملة في صورة مستقلة. وقد تكون الصورة
 * الأخيرة أقصر من الحد الأدنى عندما يكون دمجها مع المجموعة السابقة سيتجاوز 14000px.
 * الصفحة الأطول من 1000px تبقى مستقلة افتراضيًا، وتُضم فقط إلى مجموعة مجاورة
 * إذا كان الناتج المنظم بين 11000 و14000px.
 * عدم القص هو الأولوية المطلقة.
 */
export async function mergeChapterPages(pageUrls: string[]): Promise<MergedChapterImage[]> {
  if (!pageUrls.length) return [];
  const pages = await downloadPages(pageUrls);
  const dimensions = await Promise.all(pages.map(page => sharp(page).metadata()));
  const width = Math.max(...dimensions.map(item => item.width ?? 0));
  if (!width) throw new Error("تعذر تحديد أكبر عرض لصفحات الفصل.");

  const groups: Buffer[][] = [];
  let current: Buffer[] = [];
  let currentHeight = 0;
  const flushCurrent = () => {
    if (current.length) groups.push(current);
    current = [];
    currentHeight = 0;
  };
  for (let index = 0; index < pages.length; index += 1) {
    const page = pages[index]!;
    const height = dimensions[index]?.height ?? 0;
    if (!height) throw new Error(`تعذر قراءة ارتفاع الصفحة ${index + 1}.`);
    if (height > MAX_OUTPUT_HEIGHT) {
      flushCurrent();
      groups.push([page]);
      continue;
    }
    if (height > 1000) {
      flushCurrent();
      const candidate: Buffer[] = [page];
      let candidateHeight = height;
      let next = index + 1;
      while (candidateHeight < MIN_OUTPUT_HEIGHT && next < pages.length) {
        const nextHeight = dimensions[next]?.height ?? 0;
        if (!nextHeight || candidateHeight + nextHeight > MAX_OUTPUT_HEIGHT) break;
        candidate.push(pages[next]!);
        candidateHeight += nextHeight;
        next += 1;
      }
      if (candidateHeight >= MIN_OUTPUT_HEIGHT && candidateHeight <= MAX_OUTPUT_HEIGHT) {
        groups.push(candidate);
        index = next - 1;
      } else {
        groups.push([page]);
      }
      continue;
    }
    if (current.length && currentHeight + height > MAX_OUTPUT_HEIGHT) flushCurrent();
    current.push(page);
    currentHeight += height;
    if (currentHeight >= MIN_OUTPUT_HEIGHT) flushCurrent();
  }
  flushCurrent();
  return Promise.all(groups.map(group => renderCanvas(group, width)));
}
