import { describe, expect, it } from "vitest";
import { UrlPolicyError, validateChapterUrl } from "./urlPolicy";

const activeSource = {
  id: 1,
  hostname: "chapters.example.com",
  status: "active" as const,
  allowDirectChapterLookup: true,
};

describe("validateChapterUrl", () => {
  it("accepts only a configured HTTPS source and canonicalizes tracking fragments", () => {
    const result = validateChapterUrl("https://www.chapters.example.com/title/15?utm_source=discord&ref=team#reader", [activeSource]);
    expect(result.sourceId).toBe(1);
    expect(result.hostname).toBe("chapters.example.com");
    expect(result.canonicalUrl).toBe("https://chapters.example.com/title/15?ref=team");
    expect(result.urlHash).toHaveLength(64);
  });

  it.each([
    ["http://chapters.example.com/title/15", "HTTPS_REQUIRED"],
    ["https://localhost/title/15", "UNSAFE_HOST"],
    ["https://127.0.0.1/title/15", "UNSAFE_HOST"],
    ["https://unknown.example/title/15", "SOURCE_NOT_ALLOWED"],
  ])("rejects unsafe or unapproved links", (url, code) => {
    expect(() => validateChapterUrl(url, [activeSource])).toThrowError(UrlPolicyError);
    try { validateChapterUrl(url, [activeSource]); } catch (error) { expect((error as UrlPolicyError).code).toBe(code); }
  });

  it("rejects a source until direct chapter lookup is explicitly enabled", () => {
    expect(() => validateChapterUrl("https://chapters.example.com/title/15", [{ ...activeSource, allowDirectChapterLookup: false }])).toThrowError(/غير مفعّل/);
  });

  // طلب المالك: لا رفض بسبب كلمات المسار — روابط WEBTOON تحمل «challenge»
  // وهي أعمال قرّاء وليست صفحات تحقق، وكلمات الدخول في الرابط لا تعني شيئًا.
  it("accepts challenge/captcha/login-sounding paths (WEBTOON-style links)", () => {
    const webtoonsLike = validateChapterUrl(
      "https://www.chapters.example.com/en/challenge/falling-in-love/ep-133/viewer?title_no=855089&episode_no=204&captcha=1",
      [activeSource]
    );
    expect(webtoonsLike.hostname).toBe("chapters.example.com");
    expect(() => validateChapterUrl("https://chapters.example.com/login", [activeSource])).not.toThrowError();
    expect(() => validateChapterUrl("https://chapters.example.com/title/verify/15", [activeSource])).not.toThrowError();
  });

  // رابط المالك للنافير على النطاق المحمول m.comic.naver.com — يطابق المصدر
  // المسجل بنطاق الحاسوب comic.naver.com ويُطبّع الرابط الكانوني عليه.
  it("canonicalizes Naver's mobile host onto the registered desktop hostname", () => {
    const naverSource = { ...activeSource, hostname: "comic.naver.com" };
    const result = validateChapterUrl(
      "https://m.comic.naver.com/webtoon/detail?titleId=854757&no=1&week=tue&listSortOrder=DESC&listPage=1",
      [naverSource]
    );
    expect(result.sourceId).toBe(1);
    expect(result.hostname).toBe("comic.naver.com");
    expect(result.canonicalUrl).toBe("https://comic.naver.com/webtoon/detail?titleId=854757&no=1&week=tue&listSortOrder=DESC&listPage=1");
  });
});
