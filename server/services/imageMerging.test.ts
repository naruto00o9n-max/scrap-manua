import { describe, expect, it, vi } from "vitest";
import sharp from "sharp";
import { mergeChapterPages } from "./imageMerging";

async function image(width: number, height: number, color: string) {
  return sharp({ create: { width, height, channels: 3, background: color } }).png().toBuffer();
}

describe("chapter image merging", () => {
  it("uses the largest width and never crops page pixels", async () => {
    const buffers = [await image(800, 5000, "#111111"), await image(1200, 6000, "#222222"), await image(1200, 3000, "#333333")];
    vi.stubGlobal("fetch", vi.fn(async (_url: string) => new Response(buffers.shift(), { status: 200, headers: { "content-type": "image/png" } })));

    const output = await mergeChapterPages(["https://pages.test/1", "https://pages.test/2", "https://pages.test/3"]);
    expect(output.length).toBe(2);
    expect(output.every(item => item.width === 1200)).toBe(true);
    expect(output.map(item => item.height)).toEqual([11000, 3000]);
    expect(output.every(item => item.mimeType === "image/png")).toBe(true);
    for (const item of output) {
      const metadata = await sharp(item.data).metadata();
      expect(metadata.width).toBe(1200);
      expect(metadata.format).toBe("png");
    }
    vi.unstubAllGlobals();
  });

  it("keeps pages over 1000px standalone unless a valid 11000-14000px group is possible", async () => {
    const buffers = [await image(900, 8000, "#555555"), await image(900, 3000, "#666666")];
    vi.stubGlobal("fetch", vi.fn(async (_url: string) => new Response(buffers.shift(), { status: 200, headers: { "content-type": "image/png" } })));
    const output = await mergeChapterPages(["https://pages.test/long", "https://pages.test/short"]);
    expect(output.map(item => item.height)).toEqual([11000]);
    vi.unstubAllGlobals();
  });

  it("leaves a long page standalone when following pages cannot reach the minimum", async () => {
    const buffers = [await image(900, 8000, "#777777"), await image(900, 100, "#888888")];
    vi.stubGlobal("fetch", vi.fn(async (_url: string) => new Response(buffers.shift(), { status: 200, headers: { "content-type": "image/png" } })));
    const output = await mergeChapterPages(["https://pages.test/long", "https://pages.test/tiny"]);
    expect(output.map(item => item.height)).toEqual([8000, 100]);
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
