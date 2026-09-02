import { describe, expect, it, vi } from "vitest";
import sharp from "sharp";
import { mergeChapterPages } from "./imageMerging";

async function image(width: number, height: number, color: string) {
  return sharp({ create: { width, height, channels: 3, background: color } }).png().toBuffer();
}

describe("chapter image merging", () => {
  it("packs the chapter tail into one image when the total fits the ceiling", async () => {
    const buffers = [await image(800, 5000, "#111111"), await image(1200, 6000, "#222222"), await image(1200, 3000, "#333333")];
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

  it("keeps pages over 1000px standalone unless a valid 11000-14000px group is possible", async () => {
    const buffers = [await image(900, 8000, "#555555"), await image(900, 3000, "#666666")];
    vi.stubGlobal("fetch", vi.fn(async (_url: string) => new Response(buffers.shift(), { status: 200, headers: { "content-type": "image/png" } })));
    const output = await mergeChapterPages(["https://pages.test/long", "https://pages.test/short"]);
    expect(output.map(item => item.height)).toEqual([11000]);
    vi.unstubAllGlobals();
  });

  it("merges the tail pages below the minimum into one final image instead of leaving them standalone", async () => {
    // سيناريو حقيقي من مجلد Drive: 8 صفحات × 1500px (مجموعة 12000px)
    // ثم 7 صفحات ذيلية (6×1500 + 1037 = 10037px) كانت تُترك 7 ملفات مستقلة.
    const heights = [1500, 1500, 1500, 1500, 1500, 1500, 1500, 1500, 1500, 1500, 1500, 1500, 1500, 1500, 1037];
    const buffers: Buffer[] = [];
    for (let index = 0; index < heights.length; index += 1) {
      buffers.push(await image(800, heights[index]!, index % 2 ? "#101010" : "#202020"));
    }
    const urls = heights.map((_height, index) => `https://pages.test/${index + 1}`);
    vi.stubGlobal("fetch", vi.fn(async (_url: string) => new Response(buffers.shift(), { status: 200, headers: { "content-type": "image/png" } })));

    const output = await mergeChapterPages(urls);
    // 8 صفحات أولى = 12000px، وذيل الفصل كله (10037px) يُدمج في صورة واحدة.
    expect(output.map(item => item.height)).toEqual([12000, 10037]);
    expect(output).toHaveLength(2);
    vi.unstubAllGlobals();
  });

  it("never joins the tail merge when the total would exceed the ceiling", async () => {
    const buffers = [await image(900, 12000, "#999999"), await image(900, 15000, "#aaaaaa")];
    vi.stubGlobal("fetch", vi.fn(async (_url: string) => new Response(buffers.shift(), { status: 200, headers: { "content-type": "image/png" } })));
    const output = await mergeChapterPages(["https://pages.test/strip", "https://pages.test/giant"]);
    expect(output.map(item => item.height)).toEqual([12000, 15000]);
    vi.unstubAllGlobals();
  });

  it("keeps a single page intact when it is taller than the target range", async () => {
    const buffer = await image(900, 15000, "#444444");
    vi.stubGlobal("fetch", vi.fn(async () => new Response(buffer, { status: 200, headers: { "content-type": "image/png" } })));
    const output = await mergeChapterPages(["https://pages.test/tall"]);
    expect(output).toHaveLength(1);
    expect(output[0]?.width).toBe(900);
    expect(output[0]?.height).toBe(15000);
    vi.unstubAllGlobals();
  });
});
