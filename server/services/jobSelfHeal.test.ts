import { describe, expect, it } from "vitest";
import { UrlPolicyError } from "./urlPolicy";
import { isSelfHealCandidate } from "./jobs";

describe("isSelfHealCandidate", () => {
  it("proposes a heal sync for missing-domain and not-ready rejections", () => {
    expect(
      isSelfHealCandidate(new UrlPolicyError("SOURCE_NOT_ALLOWED", "هذا النطاق غير مدرج ضمن المصادر المسموح بها."))
    ).toBe(true);
    expect(isSelfHealCandidate(new UrlPolicyError("SOURCE_NOT_READY", "هذا المصدر غير مفعّل."))).toBe(true);
  });

  it("never heals for link-format or safety rejections", () => {
    expect(isSelfHealCandidate(new UrlPolicyError("INVALID_URL", "رابط غير صالح"))).toBe(false);
    expect(isSelfHealCandidate(new UrlPolicyError("HTTPS_REQUIRED", "HTTPS فقط"))).toBe(false);
    expect(isSelfHealCandidate(new UrlPolicyError("UNSAFE_HOST", "مضيف محظور"))).toBe(false);
    expect(isSelfHealCandidate(new UrlPolicyError("SOURCE_BLOCKED", "محذوف من القائمة"))).toBe(false);
    expect(isSelfHealCandidate(new Error("شبكة"))).toBe(false);
    expect(isSelfHealCandidate(null)).toBe(false);
  });
});
