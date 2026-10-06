import { describe, expect, it } from "vitest";
import {
  canonicalQueryEntries,
  ComixCipher,
  comixMaterialFingerprint,
  isValidComixMaterial,
  parseComixMaterial,
} from "./comixCipher";

function material(): { sboxes: number[][]; keys: number[][] } {
  const sbox = (offset: number) => Array.from({ length: 256 }, (_, i) => (i + offset) % 256);
  return {
    sboxes: [sbox(1), sbox(7), sbox(13)],
    keys: [
      Array.from({ length: 24 }, (_, i) => (i * 3) % 256),
      Array.from({ length: 32 }, (_, i) => (i * 7) % 256),
      Array.from({ length: 24 }, (_, i) => (i * 11) % 256),
    ],
  };
}

describe("comixCipher", () => {
  it("يقبل مادة سليمة ويرفض المكسورة", () => {
    expect(isValidComixMaterial(material())).toBe(true);
    expect(isValidComixMaterial({ sboxes: [[0]], keys: [[1]] })).toBe(false);
    expect(isValidComixMaterial(null)).toBe(false);
  });

  it("يحلل JSON كاملًا ويرفض غير الصالح", () => {
    const parsed = parseComixMaterial(JSON.stringify(material()));
    expect(parsed).not.toBeNull();
    expect(parseComixMaterial("not json")).toBeNull();
    expect(parseComixMaterial(JSON.stringify({ sboxes: [[1]], keys: [] }))).toBeNull();
    expect(parseComixMaterial("")).toBeNull();
  });

  it("بصمة المادة مستقرة وتتغير بتغير القيم", () => {
    const a = comixMaterialFingerprint(material());
    const b = comixMaterialFingerprint(material());
    const other = material();
    other.keys[0]![0] = (other.keys[0]![0]! + 1) % 256;
    expect(a).toBe(b);
    expect(a).not.toBe(comixMaterialFingerprint(other));
  });

  it("التوقيع base64url بلا حشو", () => {
    const cipher = new ComixCipher(material());
    const signature = cipher.sign("/api/v1/manga/121601/chapters", "limit=100&page=1");
    expect(signature).not.toMatch(/[+/=]/);
    expect(signature.length).toBeGreaterThan(0);
  });

  it("المسار يُقرأ بعد إزالة /api/v1 والاستعلام يُلحق بعلامة استفهام", () => {
    const cipher = new ComixCipher(material());
    // توقيع يدوي بمسار محروم من البادئة يطابق التوقيع بالمسار الكامل
    const withPrefix = cipher.sign("/api/v1/chapters/943210", "");
    const raw = cipher.sign("/chapters/943210", "");
    expect(withPrefix).toBe(raw);
  });

  it("فك الاستجابة المشفرة يعيد الأصل (تدوير كامل sign/decrypt)", () => {
    const cipher = new ComixCipher(material());
    const path = "/api/v1/chapters/943210";
    const query = "limit=2&page=1";
    // نص الموقع المشفر هو نتيجة جولات الاستبدال على النص الأصلي — نحاكيها
    // عبر التشفير بالاتجاه المعاكس يدويًا: sign يشفّر ثم يرمّز، decrypt يفك.
    // لاختبار الجولة الكاملة نبني «e» بتطبيق الاستبدال الأمامي ثلاث مرات
    // على النص ثم بترميزه، ونتحقق أن decrypt يعيد النص الأصلي.
    const plaintext = JSON.stringify({ status: "ok", result: { pages: [] } });
    const encrypted = forwardEncrypt(plaintext, material());
    expect(cipher.decrypt(encrypted)).toBe(plaintext);
    // وتوقيع نفس المسار يبقى مستقرًا
    expect(cipher.sign(path, query)).toBe(cipher.sign(path, query));
  });

  it("الباراميترات تُرتب قياسيًا والمصفوفات تُفهرس", () => {
    const entries = canonicalQueryEntries({
      "order[number]": "desc",
      limit: "100",
      page: "1",
      "genres[]": ["action", "drama"],
    });
    expect(entries).toEqual([
      ["genres[0]", "action"],
      ["genres[1]", "drama"],
      ["limit", "100"],
      ["order[number]", "desc"],
      ["page", "1"],
    ]);
  });
});

/** يطبق جولات الاستبدال الأمامية يدويًا ثم base64url — لبناء نص مشفر للاختبار. */
function forwardEncrypt(plaintext: string, material: { sboxes: number[][]; keys: number[][] }): string {
  const previous = [189, 133, 32];
  let data = new Uint8Array(Buffer.from(plaintext, "utf8"));
  for (let round = 0; round < 3; round += 1) {
    const sbox = material.sboxes[round]!;
    const key = material.keys[round]!;
    let prev = previous[round]!;
    const output = new Uint8Array(data.length);
    for (let index = 0; index < data.length; index += 1) {
      const substituted = sbox[(data[index]! ^ key[index % key.length]! ^ prev) & 0xff]!;
      output[index] = substituted;
      prev = substituted;
    }
    data = output;
  }
  return Buffer.from(data).toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
}
