import { describe, expect, it, vi } from "vitest";
import sharp from "sharp";
import { mergeChapterPages } from "./imageMerging";

async function image(width: number, height: number, color: string) {
  return sharp({ create: { width, height, channels: 3, background: color } }).png().toBuffer();
}

describe("chapter image merging", () => {
  it("uses the largest width and never crops page pixels", async () => {
    const buffers = [await image(800, 700, "#111111"), await image(1200, 900, "#222222"), await image(1200, 700, "#333333")];
    vi.stubGlobal("fetch", vi.fn(async (_url: string) => new Response(buffers.shift(), { status: 200, headers: { "content-type": "image/png" } })));

    const output = await mergeChapterPages(["https://pages.test/1", "https://pages.test/2", "https://pages.test/3"]);
    expect(output.length).toBe(2);
    expect(output.every(item => item.width === 1200)).toBe(true);
    expect(output.map(item => item.height)).toEqual([1600, 700]);
    expect(output.every(item => item.mimeType === "image/png")).toBe(true);
    for (const item of output) {
      const metadata = await sharp(item.data).metadata();
      expect(metadata.width).toBe(1200);
      expect(metadata.format).toBe("png");
    }
    vi.unstubAllGlobals();
  });

  it("keeps a single page intact when it is taller than the target range", async () => {
    const buffer = await image(900, 2400, "#444444");
    vi.stubGlobal("fetch", vi.fn(async () => new Response(buffer, { status: 200, headers: { "content-type": "image/png" } })));
    const output = await mergeChapterPages(["https://pages.test/tall"]);
    expect(output).toHaveLength(1);
    expect(output[0]?.width).toBe(900);
    expect(output[0]?.height).toBe(2400);
    vi.unstubAllGlobals();
  });
});
