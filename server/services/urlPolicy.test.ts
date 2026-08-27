import { describe, expect, it } from "vitest";
import { UrlPolicyError, validateChapterUrl } from "./urlPolicy";

const activeSource = {
  id: 1,
  hostname: "chapters.example.com",
  status: "active" as const,
  allowDirectChapterLookup: true,
  rejectLoginRequired: true,
  rejectCaptchaRequired: true,
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
    ["https://chapters.example.com/login", "LOGIN_NOT_ALLOWED"],
    ["https://chapters.example.com/title/15?captcha=1", "CAPTCHA_NOT_ALLOWED"],
  ])("rejects unsafe or unapproved links", (url, code) => {
    expect(() => validateChapterUrl(url, [activeSource])).toThrowError(UrlPolicyError);
    try { validateChapterUrl(url, [activeSource]); } catch (error) { expect((error as UrlPolicyError).code).toBe(code); }
  });

  it("rejects a source until direct chapter lookup is explicitly enabled", () => {
    expect(() => validateChapterUrl("https://chapters.example.com/title/15", [{ ...activeSource, allowDirectChapterLookup: false }])).toThrowError(/غير مفعّل/);
  });
});
