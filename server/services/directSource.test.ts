import { describe, expect, it } from "vitest";
import {
  cookieDisplayName,
  extractReaderImages,
  normalizeCookieHeader,
  parseMangaChapterTitle,
} from "./directSource";

describe("normalizeCookieHeader", () => {
  it("يقبل الصيغة القياسية name=value كما هي", () => {
    expect(normalizeCookieHeader("wordpress_logged_in_abc123=Rios%7C1788653464%7Ctoken%7Chash")).toBe(
      "wordpress_logged_in_abc123=Rios%7C1788653464%7Ctoken%7Chash"
    );
  });

  it("يحوّل صيغة أدوات المطور «الاسم مسافة القيمة» إلى الصيغة القياسية", () => {
    expect(normalizeCookieHeader("wordpress_logged_in_abc123 Rios%7C1788653464%7Ctoken%7Chash")).toBe(
      "wordpress_logged_in_abc123=Rios%7C1788653464%7Ctoken%7Chash"
    );
  });

  it("يقبل الفصل بمسافة جدولة (Tab) كما في النسخ من نافذة المتصفح", () => {
    expect(normalizeCookieHeader("wordpress_logged_in_abc123\tRios%7Ctoken")).toBe(
      "wordpress_logged_in_abc123=Rios%7Ctoken"
    );
  });

  it("يزيل المسافات الزائدة حول علامة التساوي", () => {
    expect(normalizeCookieHeader("wordpress_logged_in_abc123 = Rios%7Ctoken")).toBe(
      "wordpress_logged_in_abc123=Rios%7Ctoken"
    );
  });

  it("يقبل سطر Cookie كاملًا بعدة أزواج ويرتبها بفواصل موحدة", () => {
    expect(normalizeCookieHeader("wordpress_logged_in_abc123=Rios%7Ctoken; csrftoken=qwerty12")).toBe(
      "wordpress_logged_in_abc123=Rios%7Ctoken; csrftoken=qwerty12"
    );
  });

  it("يقبل خيار Cookie: المنسوخ من تبويب Network", () => {
    expect(normalizeCookieHeader("Cookie: wordpress_logged_in_abc123=Rios%7Ctoken")).toBe(
      "wordpress_logged_in_abc123=Rios%7Ctoken"
    );
  });

  it("يقبل صيغة المسافة داخل سطر متعدد الأزواج", () => {
    expect(normalizeCookieHeader("csrftoken qwerty12; wordpress_logged_in_abc123 Rios%7Ctoken")).toBe(
      "csrftoken=qwerty12; wordpress_logged_in_abc123=Rios%7Ctoken"
    );
  });

  it("يبقي أول = فاصلة فقط عندما تحوي القيمة نفسها =", () => {
    expect(normalizeCookieHeader("session=base64==data")).toBe("session=base64==data");
  });

  it("يزيل المكرر", () => {
    expect(normalizeCookieHeader("a=1; a=1; b=2")).toBe("a=1; b=2");
  });

  it("يرفض الفارغ وأسطر جديدة والنص بلا أزواج", () => {
    expect(normalizeCookieHeader("")).toBeNull();
    expect(normalizeCookieHeader("   ")).toBeNull();
    expect(normalizeCookieHeader("a=1\nb=2")).toBeNull();
    expect(normalizeCookieHeader("مجرد نص بلا أي زوج")).toBeNull();
  });

  it("يرفض قيمة الاسم المحتوية على مسافة", () => {
    expect(normalizeCookieHeader("bad name=value")).toBeNull();
  });
});

describe("extractReaderImages", () => {
  it("يستخرج صور مصدر ts_reader الأول الحامل لصور", () => {
    const html = `<script>ts_reader.run({"sources":[{"source":"s1","images":[]},{"source":"s2","images":["https://site.com/p1.webp","https://site.com/p2.webp"]}]});</script>`;
    expect(extractReaderImages(html)).toEqual(["https://site.com/p1.webp", "https://site.com/p2.webp"]);
  });

  it("يعود بقائمة فارغة عند غياب الصور", () => {
    expect(extractReaderImages("<p>لا شيء</p>")).toEqual([]);
  });
});

describe("parseMangaChapterTitle", () => {
  it("يفصل عنوان العمل عن اسم الفصل", () => {
    expect(parseMangaChapterTitle("Perfection is Everything Chapter 57 – rokari comics")).toEqual({
      mangaTitle: "Perfection is Everything",
      chapterName: "Chapter 57",
    });
  });

  it("يتعامل مع عنوان بلا نمط فصل", () => {
    expect(parseMangaChapterTitle("عمل مجهول – rokari comics")).toEqual({
      mangaTitle: "عمل مجهول",
      chapterName: "",
    });
  });
});

describe("cookieDisplayName", () => {
  it("يعرض اسم الكوكي فقط دون قيمته", () => {
    expect(cookieDisplayName("wordpress_logged_in_abc123=Rios%7Ctoken; other=1")).toBe(
      "wordpress_logged_in_abc123…"
    );
  });
});
