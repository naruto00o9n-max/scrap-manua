import { describe, expect, it, vi } from "vitest";
import sharp from "sharp";
import { buildPageFilename } from "./googleDrive";
import {
  DEFAULT_IMAGE_OUTPUT,
  FORMAT_MIME,
  imageOutputDescription,
  imageOutputExtension,
  mergeChapterPages,
  normalizeImageOutputConfig,
  type ImageOutputConfig,
} from "./imageMerging";

async function image(width: number, height: number, color: string) {
  return sharp({ create: { width, height, channels: 3, background: color } }).png().toBuffer();
}

describe("image output config normalization", () => {
  it("defaults to lossless PNG when the setting is unset or invalid", () => {
    expect(normalizeImageOutputConfig(null)).toEqual(DEFAULT_IMAGE_OUTPUT);
    expect(normalizeImageOutputConfig("")).toEqual(DEFAULT_IMAGE_OUTPUT);
    expect(normalizeImageOutputConfig("not-json")).toEqual(DEFAULT_IMAGE_OUTPUT);
    expect(normalizeImageOutputConfig('{"format":42}')).toEqual(DEFAULT_IMAGE_OUTPUT);
    expect(normalizeImageOutputConfig('{"format":"bmp"}')).toEqual(DEFAULT_IMAGE_OUTPUT);
    expect(normalizeImageOutputConfig('{"format":"gif"}')).toEqual(DEFAULT_IMAGE_OUTPUT);
  });

  it("clamps quality into the safe 40–100 range", () => {
    expect(normalizeImageOutputConfig('{"format":"jpeg","quality":990}').quality).toBe(100);
    expect(normalizeImageOutputConfig('{"format":"webp","quality":1}').quality).toBe(40);
    expect(normalizeImageOutputConfig('{"format":"jpeg","quality":72.6}').quality).toBe(73);
    expect(normalizeImageOutputConfig('{"format":"jpeg","quality":"نص"}').quality).toBe(DEFAULT_IMAGE_OUTPUT.quality);
  });

  it("accepts the three supported formats and keeps pngPalette strictly boolean", () => {
    expect(normalizeImageOutputConfig('{"format":"png"}').format).toBe("png");
    expect(normalizeImageOutputConfig('{"format":"jpeg"}').format).toBe("jpeg");
    expect(normalizeImageOutputConfig('{"format":"webp"}').format).toBe("webp");
    expect(normalizeImageOutputConfig('{"format":"png","pngPalette":"yes"}').pngPalette).toBe(false);
    expect(normalizeImageOutputConfig('{"format":"png","pngPalette":1}').pngPalette).toBe(false);
    expect(normalizeImageOutputConfig('{"format":"png","pngPalette":true}').pngPalette).toBe(true);
  });
});

describe("merged image output formats", () => {
  async function mergeWith(config: ImageOutputConfig) {
    const buffers = [await image(800, 3000, "#151515"), await image(800, 3000, "#252525")];
    vi.stubGlobal("fetch", vi.fn(async () => new Response(buffers.shift(), { status: 200, headers: { "content-type": "image/png" } })));
    try {
      return await mergeChapterPages(["https://pages.test/a", "https://pages.test/b"], config);
    } finally {
      vi.unstubAllGlobals();
    }
  }

  it("stays lossless PNG by default even when quality is set", async () => {
    const output = await mergeWith({ ...DEFAULT_IMAGE_OUTPUT, quality: 40 });
    expect(output).toHaveLength(1);
    expect(output[0]!.mimeType).toBe(FORMAT_MIME.png);
    const metadata = await sharp(output[0]!.data).metadata();
    expect(metadata.format).toBe("png");
    expect(metadata.isPalette).toBe(false);
    expect(output[0]!.height).toBe(6000);
  });

  it("produces JPEG when configured with identical geometry", async () => {
    const output = await mergeWith({ format: "jpeg", quality: 88, pngPalette: false });
    expect(output[0]!.mimeType).toBe(FORMAT_MIME.jpeg);
    const metadata = await sharp(output[0]!.data).metadata();
    expect(metadata.format).toBe("jpeg");
    expect(metadata.width).toBe(800);
    expect(output[0]!.height).toBe(6000);
  });

  it("produces WebP when configured", async () => {
    const output = await mergeWith({ format: "webp", quality: 85, pngPalette: false });
    expect(output[0]!.mimeType).toBe(FORMAT_MIME.webp);
    const metadata = await sharp(output[0]!.data).metadata();
    expect(metadata.format).toBe("webp");
    expect(output[0]!.height).toBe(6000);
  });

  it("palette PNG is opt-in and still valid PNG with the same geometry", async () => {
    const output = await mergeWith({ format: "png", quality: 90, pngPalette: true });
    expect(output[0]!.mimeType).toBe(FORMAT_MIME.png);
    const metadata = await sharp(output[0]!.data).metadata();
    expect(metadata.format).toBe("png");
    expect(metadata.isPalette).toBe(true);
    expect(output[0]!.height).toBe(6000);
  });

  it("never regresses to uncompressed PNG output (the huge-size bug)", async () => {
    // الصورة المركبة: 800×6000 RGBA الخام = 19.2MB. تاريخيًا كان الناتج يقارب
    // هذا الحجم (مستوى ضغط 0)؛ مع الضغط الأقصى يجب أن يبقى جزءًا صغيرًا منه.
    const output = await mergeWith(DEFAULT_IMAGE_OUTPUT);
    const rawBytes = 800 * 6000 * 4;
    expect(output[0]!.data.length).toBeLessThan(rawBytes * 0.1);
  });

  it("describes each configuration in Arabic for the job log", () => {
    expect(imageOutputDescription(DEFAULT_IMAGE_OUTPUT)).toBe("PNG بلا أي فقدان بضغط أقصى");
    expect(imageOutputDescription({ format: "png", quality: 90, pngPalette: true })).toBe("PNG بتقليل الألوان (جودة 90)");
    expect(imageOutputDescription({ format: "jpeg", quality: 88, pngPalette: false })).toBe("JPG بجودة 88");
    expect(imageOutputDescription({ format: "webp", quality: 85, pngPalette: false })).toBe("WebP بجودة 85");
  });
});

describe("image output file naming", () => {
  it("maps each format to its real extension", () => {
    expect(imageOutputExtension("png")).toBe("png");
    expect(imageOutputExtension("jpeg")).toBe("jpg");
    expect(imageOutputExtension("webp")).toBe("webp");
  });

  it("names merged Drive files by their actual mime type", () => {
    expect(buildPageFilename(1, "image/png")).toBe("001.png");
    expect(buildPageFilename(7, "image/jpeg")).toBe("007.jpg");
    expect(buildPageFilename(12, "image/webp")).toBe("012.webp");
  });
});
