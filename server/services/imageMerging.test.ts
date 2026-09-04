import { describe, expect, it, vi } from "vitest";
import sharp from "sharp";
import {
  mergeChapterPages,
  normalizeChapterMergeSettings,
  normalizeMergeHeightCap,
  normalizeMergeWidth,
  pickUniformWidth,
} from "./imageMerging";

async function image(width: number, height: number, color: string) {
  return sharp({ create: { width, height, channels: 3, background: color } }).png().toBuffer();
}

describe("chapter image merging", () => {
  it("packs the chapter tail into one image when the total fits the ceiling", async () => {
    const buffers = [await image(1200, 5000, "#111111"), await image(1200, 6000, "#222222"), await image(1200, 3000, "#333333")];
    vi.stubGlobal("fetch", vi.fn(async (_url: string) => new Response(buffers.shift(), { status: 200, headers: { "content-type": "image/png" } })));

    const output = await mergeChapterPages(["https://pages.test/1", "https://pages.test/2", "https://pages.test/3"]);
    expect(output.length).toBe(1);
    expect(output.every(item => item.width === 1200)).toBe(true);
    expect(output.map(item => item.height)).toEqual([14000]);
    expect(output.every(item => item.mimeType === "image/png")).toBe(true);
    const metadata = await sharp(output[0]!.data).metadata();
    expect(metadata.width).toBe(1200);
    expect(metadata.format).toBe("png");
    vi.unstubAllGlobals();
  });

  it("merges neighbouring pages up to the flexible ceiling", async () => {
    const buffers = [await image(900, 8000, "#555555"), await image(900, 3000, "#666666")];
    vi.stubGlobal("fetch", vi.fn(async (_url: string) => new Response(buffers.shift(), { status: 200, headers: { "content-type": "image/png" } })));
    const output = await mergeChapterPages(["https://pages.test/long", "https://pages.test/short"]);
    expect(output.map(item => item.height)).toEqual([11000]);
    vi.unstubAllGlobals();
  });

  it("merges three small pages slightly past the 14000 threshold to reach it (user's real case)", async () => {
    // سيناريو المستخدم الحقيقي: صفحات 4000-5000px كانت تُترك كل واحدة مستقلة
    // لأن 5000+5000 = 10000 < الحد الأدنى القديم و 5000+5000+4316 = 14316 > السقف
    // القديم — المطلوب: دمج اثنين أو ثلاثة بشكل مرن حتى بلوغ عتبة 14000.
    const buffers = [await image(800, 5000, "#111111"), await image(800, 5000, "#222222"), await image(800, 4316, "#333333")];
    vi.stubGlobal("fetch", vi.fn(async (_url: string) => new Response(buffers.shift(), { status: 200, headers: { "content-type": "image/png" } })));
    const output = await mergeChapterPages(["https://pages.test/1", "https://pages.test/2", "https://pages.test/3"]);
    expect(output).toHaveLength(1);
    expect(output[0]!.height).toBe(14316);
    vi.unstubAllGlobals();
  });

  it("leaves no small orphans in a real mixed chapter (user's Drive folder heights)", async () => {
    // أطوال حقيقية من مجلد Drive للمستخدم: كانت تخرج 19 ملفًا مستقلاً بأطوال
    // 4030-13950؛ الآن الصفحات الصغيرة تُدمج حتى العتبة ولا يبقى يتيم قصير.
    const heights = [5000, 5000, 4316, 13360, 13950, 5000, 5000, 4925];
    const buffers: Buffer[] = [];
    for (let index = 0; index < heights.length; index += 1) {
      buffers.push(await image(800, heights[index]!, index % 2 ? "#101010" : "#202020"));
    }
    const urls = heights.map((_height, index) => `https://pages.test/${index + 1}`);
    vi.stubGlobal("fetch", vi.fn(async (_url: string) => new Response(buffers.shift(), { status: 200, headers: { "content-type": "image/png" } })));

    const output = await mergeChapterPages(urls);
    // 14316 + الصفحتان الكبيرتان مستقلتان + 14925 — لا ملف واحد تحت 13000.
    expect(output.map(item => item.height)).toEqual([14316, 13360, 13950, 14925]);
    vi.unstubAllGlobals();
  });

  it("evens out the two output heights instead of leaving one tall and one short", async () => {
    // سيناريو حقيقي من مجلد Drive: 14 صفحة × 1500px + 1037px.
    // التوزيع الأكثر تساويًا (10500/11537) أفضل من 12000/10037 القديم.
    const heights = [1500, 1500, 1500, 1500, 1500, 1500, 1500, 1500, 1500, 1500, 1500, 1500, 1500, 1500, 1037];
    const buffers: Buffer[] = [];
    for (let index = 0; index < heights.length; index += 1) {
      buffers.push(await image(800, heights[index]!, index % 2 ? "#101010" : "#202020"));
    }
    const urls = heights.map((_height, index) => `https://pages.test/${index + 1}`);
    vi.stubGlobal("fetch", vi.fn(async (_url: string) => new Response(buffers.shift(), { status: 200, headers: { "content-type": "image/png" } })));

    const output = await mergeChapterPages(urls);
    expect(output.map(item => item.height)).toEqual([10500, 11537]);
    expect(output).toHaveLength(2);
    vi.unstubAllGlobals();
  });

  it("packs four alternating pages into two equal-height images", async () => {
    const heights = [8000, 6000, 8000, 6000];
    const buffers: Buffer[] = [];
    for (let index = 0; index < heights.length; index += 1) {
      buffers.push(await image(800, heights[index]!, index % 2 ? "#101010" : "#202020"));
    }
    const urls = heights.map((_height, index) => `https://pages.test/${index + 1}`);
    vi.stubGlobal("fetch", vi.fn(async (_url: string) => new Response(buffers.shift(), { status: 200, headers: { "content-type": "image/png" } })));
    const output = await mergeChapterPages(urls);
    expect(output.map(item => item.height)).toEqual([14000, 14000]);
    vi.unstubAllGlobals();
  });

  it("never merges pages when the total would exceed the flexible ceiling", async () => {
    const buffers = [await image(900, 12000, "#999999"), await image(900, 16000, "#aaaaaa")];
    vi.stubGlobal("fetch", vi.fn(async (_url: string) => new Response(buffers.shift(), { status: 200, headers: { "content-type": "image/png" } })));
    const output = await mergeChapterPages(["https://pages.test/strip", "https://pages.test/giant"]);
    expect(output.map(item => item.height)).toEqual([12000, 16000]);
    vi.unstubAllGlobals();
  });

  it("keeps a single page intact when it is taller than the flexible ceiling", async () => {
    const buffer = await image(900, 16000, "#444444");
    vi.stubGlobal("fetch", vi.fn(async () => new Response(buffer, { status: 200, headers: { "content-type": "image/png" } })));
    const output = await mergeChapterPages(["https://pages.test/tall"]);
    expect(output).toHaveLength(1);
    expect(output[0]?.width).toBe(900);
    expect(output[0]?.height).toBe(16000);
    vi.unstubAllGlobals();
  });

  it("scales off-width pages to the common width instead of padding with white", async () => {
    // سيناريو المستخدم: صفحات الفصل بعرض 800 وآخر صفحة أعرض (1200) —
    // كانت تُفرش فوق لوحة 1200 مع حشو أبيض على الجانبين؛ المطلوب تحجيمها
    // إلى العرض المشترك 800 مع الحفاظ على النسبة (900 → 600 ارتفاعًا).
    const buffers = [
      await image(800, 2000, "#111111"),
      await image(800, 2000, "#222222"),
      await image(1200, 900, "#333333"),
    ];
    vi.stubGlobal("fetch", vi.fn(async (_url: string) => new Response(buffers.shift(), { status: 200, headers: { "content-type": "image/png" } })));

    const output = await mergeChapterPages(["https://pages.test/1", "https://pages.test/2", "https://pages.test/3"]);
    expect(output).toHaveLength(1);
    // العرض = العرض الأكثر تكرارًا (800)، والارتفاع = 2000+2000+600 بعد تحجيم الأخيرة.
    expect(output[0]!.width).toBe(800);
    expect(output[0]!.height).toBe(4600);
    // الحافة اليمنى لمنطقة الصفحة الأخيرة داكنة — لا حشو أبيض على الجانب.
    const edge = await sharp(output[0]!.data)
      .extract({ left: 770, top: 4050, width: 30, height: 40 })
      .stats();
    expect(edge.channels[0]!.mean).toBeLessThan(100);
    vi.unstubAllGlobals();
  });

  it("keeps same-width chapters byte-identical in geometry (no re-encode)", async () => {
    const buffers = [await image(800, 3000, "#101010"), await image(800, 3000, "#202020")];
    vi.stubGlobal("fetch", vi.fn(async (_url: string) => new Response(buffers.shift(), { status: 200, headers: { "content-type": "image/png" } })));
    const output = await mergeChapterPages(["https://pages.test/a", "https://pages.test/b"]);
    expect(output).toHaveLength(1);
    expect(output[0]!.width).toBe(800);
    expect(output[0]!.height).toBe(6000);
    vi.unstubAllGlobals();
  });

  it("respects a custom merge height cap from guild settings", async () => {
    // سقف مخصص 9000px: ثلاث صفحات 4000px تخرج صورتين متساويتين قدر الإمكان
    // (8000 ثم 4000) بدل صورة واحدة 12000px كما في الافتراضي.
    const buffers = [await image(800, 4000, "#111111"), await image(800, 4000, "#222222"), await image(800, 4000, "#333333")];
    vi.stubGlobal("fetch", vi.fn(async (_url: string) => new Response(buffers.shift(), { status: 200, headers: { "content-type": "image/png" } })));
    const output = await mergeChapterPages(
      ["https://pages.test/1", "https://pages.test/2", "https://pages.test/3"],
      undefined,
      { heightCap: 9000 }
    );
    expect(output.map(item => item.height)).toEqual([8000, 4000]);
    vi.unstubAllGlobals();
  });

  it("scales every page to a custom merge width from guild settings", async () => {
    // عرض مخصص 600px: صفحات 800px تُحجّم كلها إلى 600 (الارتفاع ينكمش بالنسبة).
    const buffers = [await image(800, 3000, "#111111"), await image(800, 3000, "#222222")];
    vi.stubGlobal("fetch", vi.fn(async (_url: string) => new Response(buffers.shift(), { status: 200, headers: { "content-type": "image/png" } })));
    const output = await mergeChapterPages(
      ["https://pages.test/1", "https://pages.test/2"],
      undefined,
      { width: 600 }
    );
    expect(output).toHaveLength(1);
    expect(output[0]!.width).toBe(600);
    expect(output[0]!.height).toBe(4500);
    const metadata = await sharp(output[0]!.data).metadata();
    expect(metadata.width).toBe(600);
    vi.unstubAllGlobals();
  });

  it("keeps the default 15000 ceiling when no dimensions are passed", async () => {
    const buffers = [await image(800, 5000, "#111111"), await image(800, 5000, "#222222"), await image(800, 4316, "#333333")];
    vi.stubGlobal("fetch", vi.fn(async (_url: string) => new Response(buffers.shift(), { status: 200, headers: { "content-type": "image/png" } })));
    const output = await mergeChapterPages(
      ["https://pages.test/1", "https://pages.test/2", "https://pages.test/3"],
      undefined,
      {}
    );
    expect(output).toHaveLength(1);
    expect(output[0]!.height).toBe(14316);
    vi.unstubAllGlobals();
  });
});

describe("chapter merge settings normalization", () => {
  it("returns enabled defaults for missing values", () => {
    expect(normalizeChapterMergeSettings(null)).toEqual({ enabled: true, heightCap: null, width: null });
    expect(normalizeChapterMergeSettings("")).toEqual({ enabled: true, heightCap: null, width: null });
  });

  it("maps the legacy off string to a disabled config with default dimensions", () => {
    expect(normalizeChapterMergeSettings("off")).toEqual({ enabled: false, heightCap: null, width: null });
  });

  it("parses stored JSON and clamps out-of-range dimensions", () => {
    expect(normalizeChapterMergeSettings(JSON.stringify({ enabled: false, heightCap: 12000, width: 900 }))).toEqual({
      enabled: false,
      heightCap: 12000,
      width: 900,
    });
    expect(normalizeChapterMergeSettings(JSON.stringify({ heightCap: 5, width: 99999 }))).toEqual({
      enabled: true,
      heightCap: 2000,
      width: 2400,
    });
    expect(normalizeChapterMergeSettings(JSON.stringify({ enabled: true, heightCap: null, width: null }))).toEqual({
      enabled: true,
      heightCap: null,
      width: null,
    });
  });

  it("falls back to defaults on corrupted JSON", () => {
    expect(normalizeChapterMergeSettings("{not-json")).toEqual({ enabled: true, heightCap: null, width: null });
  });

  it("clamps raw height and width values directly", () => {
    expect(normalizeMergeHeightCap(15000)).toBe(15000);
    expect(normalizeMergeHeightCap(undefined)).toBe(15000);
    expect(normalizeMergeHeightCap(-3)).toBe(15000);
    expect(normalizeMergeWidth(undefined)).toBeNull();
    expect(normalizeMergeWidth("bogus")).toBeNull();
  });
});

describe("pickUniformWidth", () => {
  it("picks the most frequent width as the chapter's real width", () => {
    expect(pickUniformWidth([800, 800, 1200])).toBe(800);
    expect(pickUniformWidth([1200, 800, 800, 1200, 1200])).toBe(1200);
  });

  it("breaks ties toward the larger width to keep more detail", () => {
    expect(pickUniformWidth([800, 1200])).toBe(1200);
    expect(pickUniformWidth([700, 900, 700, 900])).toBe(900);
  });

  it("ignores unreadable widths and returns zero when nothing is readable", () => {
    expect(pickUniformWidth([0, null, undefined, 800])).toBe(800);
    expect(pickUniformWidth([undefined, null, 0])).toBe(0);
    expect(pickUniformWidth([])).toBe(0);
  });
});

// ===== فك تشويش GigaViewer (شونين جامب+) =====

describe("unscrambleGigaViewerPage", () => {
  it("يعيد شبكة 4×4 المقلوبة إلى ترتيبها الأصلي", async () => {
    const { mkdtemp, writeFile, rm } = await import("node:fs/promises");
    const { tmpdir } = await import("node:os");
    const path = await import("node:path");
    const { unscrambleGigaViewerPage } = await import("./imageMerging");

    const divide = 4;
    const multiple = 8;
    const size = 256; // block = floor(256/32)*8 = 64
    const block = Math.floor(size / (divide * multiple)) * multiple;

    // الصورة الأصلية: كل كتلة (صف، عمود) بلون مميز عبر المنطقة الشبكية.
    const base = sharp({ create: { width: size, height: size, channels: 3, background: "#000000" } });
    const composites: Array<{ input: Buffer; left: number; top: number }> = [];
    const blockColor = (row: number, col: number) => ({
      r: 20 + row * 50,
      g: 20 + col * 50,
      b: 100 + row * 10 + col * 5,
    });
    for (let row = 0; row < divide; row += 1) {
      for (let col = 0; col < divide; col += 1) {
        const { r, g, b } = blockColor(row, col);
        composites.push({
          input: await sharp({ create: { width: block, height: block, channels: 3, background: { r, g, b } } }).png().toBuffer(),
          left: col * block,
          top: row * block,
        });
      }
    }
    const original = await base.composite(composites).png().toBuffer();

    // نُنشئ النسخة «المشوشة» بنفس عملية القلب (القلب تناظري).
    const scrambleComposites: Array<{ input: Buffer; left: number; top: number }> = [];
    for (let e = 0; e < divide * divide; e += 1) {
      const sourceCol = e % divide;
      const sourceRow = Math.floor(e / divide);
      const buf = await sharp(original).extract({ left: sourceCol * block, top: sourceRow * block, width: block, height: block }).toBuffer();
      scrambleComposites.push({ input: buf, left: sourceRow * block, top: sourceCol * block });
    }
    const scrambled = await sharp(original).composite(scrambleComposites).png().toBuffer();

    const dir = await mkdtemp(path.join(tmpdir(), "scramble-test-"));
    try {
      const filePath = path.join(dir, "page.img");
      await writeFile(filePath, scrambled);
      await unscrambleGigaViewerPage(filePath);

      // نتحقق من مركز كل كتلة: يجب أن يعود إلى لونه الأصلي.
      for (let row = 0; row < divide; row += 1) {
        for (let col = 0; col < divide; col += 1) {
          const raw = await sharp(filePath)
            .extract({ left: col * block + block / 2, top: row * block + block / 2, width: 1, height: 1 })
            .raw()
            .toBuffer();
          const { r, g, b } = blockColor(row, col);
          expect([raw[0], raw[1], raw[2]]).toEqual([r, g, b]);
        }
      }
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
