import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";
import sharp from "sharp";

// نحتفظ بالدوال الحقيقية (بصمات الصور) ونستبدل مفتاح التهيئة وتمرير الوسيط.
vi.mock("./scraperApi", async importOriginal => {
  const actual = await importOriginal<typeof import("./scraperApi")>();
  return {
    ...actual,
    getScraperApiKey: vi.fn(),
    fetchViaScraperApi: vi.fn(),
  };
});

import { downloadPageViaScraperApi } from "./imageMerging";
import { fetchViaScraperApi, getScraperApiKey } from "./scraperApi";

const mockedGetKey = vi.mocked(getScraperApiKey);
const mockedFetchVia = vi.mocked(fetchViaScraperApi);

beforeEach(() => {
  vi.resetModules();
  mockedGetKey.mockReset();
  mockedFetchVia.mockReset();
});

describe("تنزيل الصفحات عبر وسيط السحب (ScraperAPI)", () => {
  it("يكتب الصورة الحقيقية المستلمة من الوسيط على القرص", async () => {
    const png = await sharp({ create: { width: 32, height: 64, channels: 3, background: "#123456" } }).png().toBuffer();
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new Uint8Array(png.subarray(0, 10)));
        controller.enqueue(new Uint8Array(png.subarray(10)));
        controller.close();
      },
    });
    mockedFetchVia.mockResolvedValue(new Response(stream as unknown as BodyInit, { status: 200 }));

    const dir = await mkdtemp(path.join(tmpdir(), "scraper-"));
    try {
      const target = path.join(dir, "page-0001.img");
      await downloadPageViaScraperApi("https://cdn.test/p1.webp", 1, target);
      const saved = await readFile(target);
      expect(Buffer.compare(saved, png)).toBe(0);
      expect(mockedFetchVia.mock.calls[0]?.[0]).toBe("https://cdn.test/p1.webp");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("يرفض صفحة تحدي HTML ويفشل برسالة واضحة دون كتابة ملف", async () => {
    const html = new TextEncoder().encode("<!DOCTYPE html><html><title>Just a moment...</title></html>");
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(html);
        controller.close();
      },
    });
    mockedFetchVia.mockResolvedValue(new Response(stream as unknown as BodyInit, { status: 200 }));

    const dir = await mkdtemp(path.join(tmpdir(), "scraper-"));
    try {
      const target = path.join(dir, "page-0002.img");
      await expect(downloadPageViaScraperApi("https://cdn.test/p2.webp", 2, target)).rejects.toThrow(/لم يعُد صورة/);
      await expect(readFile(target)).rejects.toThrow();
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("يرفض استجابات الوسيط غير الناجحة فورًا", async () => {
    mockedFetchVia.mockResolvedValue(new Response("Request failed", { status: 500 }));
    const dir = await mkdtemp(path.join(tmpdir(), "scraper-"));
    try {
      const target = path.join(dir, "page-0003.img");
      await expect(downloadPageViaScraperApi("https://cdn.test/p3.webp", 3, target)).rejects.toThrow(/أعاد 500/);
      await expect(readFile(target)).rejects.toThrow();
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
