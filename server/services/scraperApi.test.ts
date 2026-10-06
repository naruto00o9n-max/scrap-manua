import { describe, expect, it } from "vitest";
import { buildScraperApiUrl, looksLikeImage, normalizeScraperApiKey, Semaphore } from "./scraperApi";

describe("normalizeScraperApiKey", () => {
  it("يقبل مفتاحًا عمليًا كما هو ويطبع الفراغات", () => {
    expect(normalizeScraperApiKey("  6e75d83c2dbf2908e4564a2aa33e7ec1 \n")).toBe("6e75d83c2dbf2908e4564a2aa33e7ec1");
  });

  it("يرفض القيم القصيرة والطويلة والرموز غير المسموحة", () => {
    expect(normalizeScraperApiKey("abc")).toBeNull();
    expect(normalizeScraperApiKey("a".repeat(65))).toBeNull();
    expect(normalizeScraperApiKey("مفتاح تجريبي")).toBeNull();
    expect(normalizeScraperApiKey("")).toBeNull();
  });
});

describe("buildScraperApiUrl", () => {
  it("يرمز الهدف كاملًا داخل باراميتر url ويحفظ المفتاح", () => {
    const url = buildScraperApiUrl("https://storage.test/a/b page.webp?x=1&r=2", "KEY123456789");
    const parsed = new URL(url);
    expect(parsed.origin + parsed.pathname).toBe("http://api.scraperapi.com/");
    expect(parsed.searchParams.get("api_key")).toBe("KEY123456789");
    expect(parsed.searchParams.get("url")).toBe("https://storage.test/a/b page.webp?x=1&r=2");
  });
});

describe("looksLikeImage", () => {
  it("يتعرف على بصمات PNG وJPEG وWebP وAVIF", () => {
    const png = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
    const jpeg = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10]);
    const webp = new Uint8Array([0x52, 0x49, 0x46, 0x46, 0x24, 0x08, 0x00, 0x00, 0x57, 0x45, 0x42, 0x50]);
    const avif = new Uint8Array([0x00, 0x00, 0x00, 0x20, 0x66, 0x74, 0x79, 0x70, 0x61, 0x76, 0x69, 0x66]);
    expect(looksLikeImage(png)).toBe(true);
    expect(looksLikeImage(jpeg)).toBe(true);
    expect(looksLikeImage(webp)).toBe(true);
    expect(looksLikeImage(avif)).toBe(true);
  });

  it("يرفض HTML وJSON وبيانات قصيرة", () => {
    const html = new TextEncoder().encode("<!DOCTYPE html><html>Just a moment...</html>");
    const json = new TextEncoder().encode('{"error":"blocked"}');
    expect(looksLikeImage(html)).toBe(false);
    expect(looksLikeImage(json)).toBe(false);
    expect(looksLikeImage(new Uint8Array([0x89, 0x50]))).toBe(false);
  });
});

describe("Semaphore", () => {
  it("يحدد عدد الحاصلين المتزامنين ويحرر بالترتيب", async () => {
    const gate = new Semaphore(2);
    const release1 = await gate.acquire();
    const release2 = await gate.acquire();
    let thirdAcquired = false;
    const third = gate.acquire().then(release => {
      thirdAcquired = true;
      return release;
    });
    expect(thirdAcquired).toBe(false);
    release1();
    const release3 = await third;
    expect(thirdAcquired).toBe(true);
    release2();
    release3();
  });
});
