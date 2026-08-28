import sharp from "sharp";

const MAX_PAGE_SIZE_BYTES = 40 * 1024 * 1024;
const MIN_OUTPUT_HEIGHT = 1400;
const MAX_OUTPUT_HEIGHT = 1800;
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
  const response = await fetch(parsed, { redirect: "error", signal: AbortSignal.timeout(45_000) });
  if (!response.ok) throw new Error(`تعذر تنزيل الصفحة ${index} (${response.status}).`);
  const contentType = response.headers.get("content-type")?.toLowerCase() ?? "";
  if (!contentType.startsWith("image/")) throw new Error(`الصفحة ${index} ليست صورة.`);
  const contentLength = Number(response.headers.get("content-length") ?? "0");
  if (Number.isFinite(contentLength) && contentLength > MAX_PAGE_SIZE_BYTES) throw new Error(`الصفحة ${index} تتجاوز الحد الآمن للحجم.`);
  const data = Buffer.from(await response.arrayBuffer());
  if (data.length > MAX_PAGE_SIZE_BYTES) throw new Error(`الصفحة ${index} تتجاوز الحد الآمن للحجم.`);
  return data;
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
 * الأخيرة أقصر من الحد الأدنى عندما يكون دمجها مع المجموعة السابقة سيتجاوز 1800px؛
 * عدم القص هو الأولوية المطلقة.
 */
export async function mergeChapterPages(pageUrls: string[]): Promise<MergedChapterImage[]> {
  if (!pageUrls.length) return [];
  const pages = await Promise.all(pageUrls.map((url, index) => downloadPage(url, index + 1)));
  const dimensions = await Promise.all(pages.map(page => sharp(page).metadata()));
  const width = Math.max(...dimensions.map(item => item.width ?? 0));
  if (!width) throw new Error("تعذر تحديد أكبر عرض لصفحات الفصل.");

  const groups: Buffer[][] = [];
  let current: Buffer[] = [];
  let currentHeight = 0;
  for (let index = 0; index < pages.length; index += 1) {
    const page = pages[index]!;
    const height = dimensions[index]?.height ?? 0;
    if (!height) throw new Error(`تعذر قراءة ارتفاع الصفحة ${index + 1}.`);
    if (height > MAX_OUTPUT_HEIGHT) {
      if (current.length) groups.push(current);
      groups.push([page]);
      current = [];
      currentHeight = 0;
      continue;
    }
    if (current.length && currentHeight + height > MAX_OUTPUT_HEIGHT) {
      groups.push(current);
      current = [];
      currentHeight = 0;
    }
    current.push(page);
    currentHeight += height;
    if (currentHeight >= MIN_OUTPUT_HEIGHT) {
      groups.push(current);
      current = [];
      currentHeight = 0;
    }
  }
  if (current.length) groups.push(current);
  return Promise.all(groups.map(group => renderCanvas(group, width)));
}
