import { describe, expect, it, vi } from "vitest";
import sharp from "sharp";
import {
  mergeChapterPages,
  normalizeChapterMergeSettings,
  normalizeMergeHeightCap,
  normalizeMergeWidth,
  openChapterMergeSession,
  PALETTE_AREA_LIMIT,
  pickUniformWidth,
  planUniformMergeGroups,
  resolveGroupOutput,
  WEBP_MAX_DIMENSION,
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
    // 4030-13950؛ الآن مجموع الأطوال يوزّع بالتساوي على أقل عدد صور داخل السقف.
    const heights = [5000, 5000, 4316, 13360, 13950, 5000, 5000, 4925];
    const buffers: Buffer[] = [];
    for (let index = 0; index < heights.length; index += 1) {
      buffers.push(await image(800, heights[index]!, index % 2 ? "#101010" : "#202020"));
    }
    const urls = heights.map((_height, index) => `https://pages.test/${index + 1}`);
    vi.stubGlobal("fetch", vi.fn(async (_url: string) => new Response(buffers.shift(), { status: 200, headers: { "content-type": "image/png" } })));

    const output = await mergeChapterPages(urls);
    const total = heights.reduce((sum, height) => sum + height, 0);
    expect(output).toHaveLength(4);
    // كل الصور متقاربة الارتفاع: التشتت الكلي أقل من هامش الانزلاق، ولا صورة فوق السقف.
    const heightsOut = output.map(item => item.height);
    expect(Math.max(...heightsOut) - Math.min(...heightsOut)).toBeLessThanOrEqual(600);
    expect(heightsOut.every(height => height <= 15000)).toBe(true);
    expect(heightsOut.reduce((sum, height) => sum + height, 0)).toBe(total);
    vi.unstubAllGlobals();
  });

  it("evens out the two output heights instead of leaving one tall and one short", async () => {
    // سيناريو حقيقي من مجلد Drive: 14 صفحة × 1500px + 1037px (مجموع 22037).
    // القص عند الحد المثالي 11018.5 يعطي صورتين متساويتين تمامًا 11019/11018
    // بدل توزيع صفحات كاملة متباينة في المحرك القديم.
    const heights = [1500, 1500, 1500, 1500, 1500, 1500, 1500, 1500, 1500, 1500, 1500, 1500, 1500, 1500, 1037];
    const buffers: Buffer[] = [];
    for (let index = 0; index < heights.length; index += 1) {
      buffers.push(await image(800, heights[index]!, index % 2 ? "#101010" : "#202020"));
    }
    const urls = heights.map((_height, index) => `https://pages.test/${index + 1}`);
    vi.stubGlobal("fetch", vi.fn(async (_url: string) => new Response(buffers.shift(), { status: 200, headers: { "content-type": "image/png" } })));

    const output = await mergeChapterPages(urls);
    expect(output.map(item => item.height)).toEqual([11019, 11018]);
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

  it("cuts oversized pages into equal heights when the total exceeds the ceiling", async () => {
    const buffers = [await image(900, 12000, "#999999"), await image(900, 16000, "#aaaaaa")];
    vi.stubGlobal("fetch", vi.fn(async (_url: string) => new Response(buffers.shift(), { status: 200, headers: { "content-type": "image/png" } })));
    const output = await mergeChapterPages(["https://pages.test/strip", "https://pages.test/giant"]);
    expect(output.map(item => item.height)).toEqual([14000, 14000]);
    vi.unstubAllGlobals();
  });

  it("cuts a single giant page into equal halves instead of keeping it over the ceiling", async () => {
    const buffer = await image(900, 16000, "#444444");
    vi.stubGlobal("fetch", vi.fn(async () => new Response(buffer, { status: 200, headers: { "content-type": "image/png" } })));
    const output = await mergeChapterPages(["https://pages.test/tall"]);
    expect(output.map(item => item.height)).toEqual([8000, 8000]);
    expect(output.every(item => item.width === 900)).toBe(true);
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
    // سقف مخصص 9000px: ثلاث صفحات 4000px تخرج صورتين متساويتين تمامًا (6000/6000)
    // بالقص عند الحد المثالي بدل 8000/4000 المتباينة في المحرك القديم.
    const buffers = [await image(800, 4000, "#111111"), await image(800, 4000, "#222222"), await image(800, 4000, "#333333")];
    vi.stubGlobal("fetch", vi.fn(async (_url: string) => new Response(buffers.shift(), { status: 200, headers: { "content-type": "image/png" } })));
    const output = await mergeChapterPages(
      ["https://pages.test/1", "https://pages.test/2", "https://pages.test/3"],
      undefined,
      { heightCap: 9000 }
    );
    expect(output.map(item => item.height)).toEqual([6000, 6000]);
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

describe("uniform merge planner", () => {
  it("keeps one whole-page group when the total fits the cap", () => {
    const plan = planUniformMergeGroups([5000, 6000, 3000], 15000);
    expect(plan).toEqual([
      [
        { pageIndex: 0, top: 0, height: 5000 },
        { pageIndex: 1, top: 0, height: 6000 },
        { pageIndex: 2, top: 0, height: 3000 },
      ],
    ]);
  });

  it("cuts pages into exactly equal heights when the total exceeds the cap", () => {
    // 17000px فوق سقف 15000 → صورتان × 8500px، والقص داخل الصفحة الثانية.
    const plan = planUniformMergeGroups([8000, 9000], 15000);
    expect(plan).toHaveLength(2);
    const heightsOut = plan.map(group => group.reduce((sum, slice) => sum + slice.height, 0));
    expect(heightsOut).toEqual([8500, 8500]);
    // تسلسل الشرائح يحافظ على ترتيب القراءة.
    const pageOrder = plan.flat().map(slice => slice.pageIndex);
    expect([...pageOrder].sort((a, b) => a - b)).toEqual(pageOrder);
    // مجموع الشرائح = مجموع الارتفاعات تمامًا.
    expect(heightsOut.reduce((sum, height) => sum + height, 0)).toBe(17000);
  });

  it("snaps a cut to an exact page boundary so whole pages stay uncut", () => {
    // حد القص المثالي 8100 يطابق حد الصفحة الثانية تمامًا — بلا أي قص فعلي.
    const plan = planUniformMergeGroups([8100, 8100], 15000);
    expect(plan).toEqual([
      [{ pageIndex: 0, top: 0, height: 8100 }],
      [{ pageIndex: 1, top: 0, height: 8100 }],
    ]);
  });

  it("avoids tiny slivers by absorbing a short page into its neighbour group", () => {
    // صفحة قصيرة 400px بين صفحتين طويلتين: تُبتلع كاملة في مجموعتها
    // ولا تُترك شريحة ضجير، والأطوال الثلاثة متقاربة (10133/10134/10133).
    const plan = planUniformMergeGroups([15000, 400, 15000], 15000);
    expect(plan).toHaveLength(3);
    const heightsOut = plan.map(group => group.reduce((sum, slice) => sum + slice.height, 0));
    expect(Math.max(...heightsOut) - Math.min(...heightsOut)).toBeLessThanOrEqual(1);
    for (const group of plan) {
      for (const slice of group) {
        expect(slice.height).toBeGreaterThanOrEqual(400);
      }
    }
  });

  it("reverts snapping when it would breach the height cap", () => {
    // حد صفحة ضمن هامش الانزلاق لكن قبوله يخترق السقف (15249 > 15000) —
    // تعود كل النقاط إلى المثالي 14950/14950.
    const plan = planUniformMergeGroups([15249, 14651], 15000);
    const heightsOut = plan.map(group => group.reduce((sum, slice) => sum + slice.height, 0));
    expect(heightsOut).toEqual([14950, 14950]);
    expect(heightsOut.every(height => height <= 15000)).toBe(true);
  });

  it("always stays within the cap and preserves total pixels (property)", () => {
    const heights = [4648, 6460, 9140, 8478, 7715, 8060, 11749, 7123, 8619, 9227, 9309, 9035, 12929];
    const plan = planUniformMergeGroups(heights, 15000);
    const heightsOut = plan.map(group => group.reduce((sum, slice) => sum + slice.height, 0));
    expect(heightsOut.every(height => height <= 15000)).toBe(true);
    expect(heightsOut.reduce((sum, height) => sum + height, 0)).toBe(112492);
    // التشتت أقل من هامش الانزلاق مضاعفًا — عمليًا ارتفاع واحد.
    expect(Math.max(...heightsOut) - Math.min(...heightsOut)).toBeLessThanOrEqual(600);
    // لا شريحة يتيمة أقل من هامش الانزلاق.
    for (const group of plan) {
      for (const slice of group) {
        expect(slice.height).toBeGreaterThanOrEqual(120);
      }
    }
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


// ============================================================
// ميزانيات ذاكرة الدمج — سبب قتل العملية 137 (OOM) في الإنتاج:
// JPG/WebP وتقليل ألوان PNG تُحمّل الصورة كاملة في الذاكرة عند الترميز،
// وWebP لا يقبل بعدًا أطول من 16383px. طلب المالك: لا تقسيم تلقائي —
// المجموعات الأطول من ميزانية الصيغة تُحوَّل إلى PNG بلا أي فقدان
// وتكمل دمجها صورة واحدة.
// ============================================================
describe("memory-safe merge budgets", () => {
  it("resolveGroupOutput: مجموعة JPG أطول من الميزانية تُحوَّل PNG بلا أي تقسيم", () => {
    const base = { format: "jpeg" as const, quality: 88, pngPalette: false };
    // 2400×25000 (سقف المالك) = 60MP فوق ميزانية JPG — تُحوَّل PNG كاملة
    const converted = resolveGroupOutput(base, 2400, 25000, 1);
    expect(converted.output.format).toBe("png");
    expect(converted.output.pngPalette).toBe(false);
    expect(converted.note).toContain("JPG");
    expect(converted.note).toContain("دون تقسيم");

    // مجموعة عادية ضمن الميزانية تبقى JPG بلا ملاحظة (2400×4000 = 9.6MP)
    const normal = resolveGroupOutput(base, 2400, 4000, 3);
    expect(normal.output.format).toBe("jpeg");
    expect(normal.note).toBeNull();
  });

  it("resolveGroupOutput: مجموعة WebP أطول من حد 16000px تُحوَّل PNG كذلك", () => {
    const base = { format: "webp" as const, quality: 88, pngPalette: false };
    const converted = resolveGroupOutput(base, 1200, 25000, 1);
    expect(converted.output.format).toBe("png");
    expect(converted.note).toContain("WebP");
    expect(converted.note).toContain("16000px");

    // WebP ضمن الحد والميزانية يبقى WebP بلا ملاحظة (1200×8000 = 9.6MP)
    const normal = resolveGroupOutput(base, 1200, 8000, 2);
    expect(normal.output.format).toBe("webp");
    expect(normal.note).toBeNull();
  });

  it("resolveGroupOutput: يتخطى تقليل الألوان فوق ميزانيته ويعود بلا ملاحظة تحته", () => {
    const base = { format: "png" as const, quality: 88, pngPalette: true };
    const dropped = resolveGroupOutput(base, 1200, 18000, 2);
    expect(dropped.output.pngPalette).toBe(false);
    expect(dropped.output.format).toBe("png");
    expect(dropped.note).toContain("تقليل ألوان PNG");

    const kept = resolveGroupOutput(base, 1200, 10000, 2);
    expect(kept.output).toEqual(base);
    expect(kept.note).toBeNull();
  });

  it("integration: JPG بمجموعة عريضة 2400px أطول من ميزانيته تخرج صورة PNG واحدة بلا تقسيم", async () => {
    const buffers: Buffer[] = [];
    for (let index = 0; index < 8; index += 1) {
      buffers.push(await image(2400, 1300, index % 2 ? "#101010" : "#202020"));
    }
    const urls = buffers.map((_buffer, index) => `https://pages.test/${index + 1}`);
    vi.stubGlobal("fetch", vi.fn(async (_url: string) => new Response(buffers.shift(), { status: 200, headers: { "content-type": "image/png" } })));

    // المجموعة الواحدة 10400px عند عرض 2400 تجاوزت ميزانية JPG فحُوّلت PNG
    const session = await openChapterMergeSession(urls, undefined, { format: "jpeg", quality: 88, pngPalette: false }, { heightCap: 25000, width: null });
    try {
      expect(session.images).toHaveLength(1);
      expect(session.images[0]!.height).toBe(10400);
      expect(session.images[0]!.mimeType).toBe("image/png");
      const metadata = await sharp(session.images[0]!.filePath).metadata();
      expect(metadata.format).toBe("png");
      expect(session.notes.join("\n")).toContain("JPG");
    } finally {
      await session.cleanup();
    }
    vi.unstubAllGlobals();
  });

  it("integration: JPG ضمن ميزانيته يبقى JPG بلا أي ملاحظات", async () => {
    const buffers: Buffer[] = [];
    for (let index = 0; index < 4; index += 1) {
      buffers.push(await image(1200, 2000, index % 2 ? "#101010" : "#202020"));
    }
    const urls = buffers.map((_buffer, index) => `https://pages.test/${index + 1}`);
    vi.stubGlobal("fetch", vi.fn(async (_url: string) => new Response(buffers.shift(), { status: 200, headers: { "content-type": "image/png" } })));

    // مجموعة واحدة 8000px عند عرض 1200 = 9.6MP ضمن الميزانية
    const session = await openChapterMergeSession(urls, undefined, { format: "jpeg", quality: 88, pngPalette: false }, { heightCap: 25000, width: null });
    try {
      expect(session.images).toHaveLength(1);
      expect(session.images[0]!.height).toBe(8000);
      expect(session.images[0]!.mimeType).toBe("image/jpeg");
      expect(session.notes).toEqual([]);
    } finally {
      await session.cleanup();
    }
    vi.unstubAllGlobals();
  });

  it("integration: WebP بفصل أطول من 16000px يخرج صورة PNG واحدة بلا تقسيم ولا تقليص سقف", async () => {
    const buffers: Buffer[] = [];
    for (let index = 0; index < 3; index += 1) {
      buffers.push(await image(1200, 8000, index % 2 ? "#101010" : "#202020"));
    }
    const urls = buffers.map((_buffer, index) => `https://pages.test/${index + 1}`);
    vi.stubGlobal("fetch", vi.fn(async (_url: string) => new Response(buffers.shift(), { status: 200, headers: { "content-type": "image/png" } })));

    // 24000px فوق حد WebP الصارم رغم أن سقف المالك 25000 — صورة PNG واحدة
    const session = await openChapterMergeSession(urls, undefined, { format: "webp", quality: 88, pngPalette: false }, { heightCap: 25000, width: null });
    try {
      expect(session.images).toHaveLength(1);
      expect(session.images[0]!.height).toBe(24000);
      expect(session.images[0]!.height).toBeGreaterThan(WEBP_MAX_DIMENSION);
      expect(session.images[0]!.mimeType).toBe("image/png");
      expect(session.notes.join("\n")).toContain("WebP");
    } finally {
      await session.cleanup();
    }
    vi.unstubAllGlobals();
  });

  it("integration: تقليل ألوان PNG يُتخطى تلقائيًا للصورة الأطول من ميزانيته", async () => {
    const buffers: Buffer[] = [];
    for (let index = 0; index < 2; index += 1) {
      buffers.push(await image(1200, 12000, index % 2 ? "#101010" : "#202020"));
    }
    const urls = buffers.map((_buffer, index) => `https://pages.test/${index + 1}`);
    vi.stubGlobal("fetch", vi.fn(async (_url: string) => new Response(buffers.shift(), { status: 200, headers: { "content-type": "image/png" } })));

    // 24000px × 1200 = 28.8MP فوق ميزانية اللوحة (20MP) — تُتخطى اللوحة
    expect(PALETTE_AREA_LIMIT).toBeLessThan(1200 * 24000);
    const session = await openChapterMergeSession(urls, undefined, { format: "png", quality: 88, pngPalette: true }, { heightCap: 25000, width: null });
    try {
      expect(session.images).toHaveLength(1);
      expect(session.images[0]!.mimeType).toBe("image/png");
      expect(session.notes.join("\n")).toContain("تقليل ألوان PNG");
      const metadata = await sharp(session.images[0]!.filePath).metadata();
      expect(metadata.format).toBe("png");
    } finally {
      await session.cleanup();
    }
    vi.unstubAllGlobals();
  });

  it("integration: صفحة عملاقة واحدة أطول من ميزانية JPG تخرج PNG بلا أي فقدان", async () => {
    const buffer = await image(2400, 20000, "#303030");
    vi.stubGlobal("fetch", vi.fn(async (_url: string) => new Response(buffer, { status: 200, headers: { "content-type": "image/png" } })));

    const session = await openChapterMergeSession(["https://pages.test/giant"], undefined, { format: "jpeg", quality: 88, pngPalette: false }, { heightCap: 25000, width: null });
    try {
      expect(session.images).toHaveLength(1);
      expect(session.images[0]!.mimeType).toBe("image/png");
      expect(session.notes.join("\n")).toContain("PNG");
    } finally {
      await session.cleanup();
    }
    vi.unstubAllGlobals();
  });
});
