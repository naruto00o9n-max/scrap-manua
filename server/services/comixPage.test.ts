import { describe, expect, it } from "vitest";
import { buildComixPageUrls, parseComixUrl } from "./comixPage";

describe("parseComixUrl", () => {
  it("يحلل رابط فصل كامل مع معرّف الفصل", () => {
    const link = parseComixUrl("https://comix.to/title/121601-1st-in-class-hides-regression/943210-chapter-6");
    expect(link).toEqual({
      mangaSlug: "121601-1st-in-class-hides-regression",
      chapterSlug: "943210-chapter-6",
      chapterId: "943210",
    });
  });

  it("يقبل النطاق البديل comix.ws وwww", () => {
    expect(parseComixUrl("https://comix.ws/title/123-abc/456-chapter-1")?.chapterId).toBe("456");
    expect(parseComixUrl("https://www.comix.to/title/123-abc/456-chapter-1")?.chapterId).toBe("456");
  });

  it("رابط العمل بلا فصل يعيد chapterId=null", () => {
    const link = parseComixUrl("https://comix.to/title/121601-1st-in-class-hides-regression");
    expect(link?.mangaSlug).toBe("121601-1st-in-class-hides-regression");
    expect(link?.chapterSlug).toBe("");
    expect(link?.chapterId).toBeNull();
  });

  it("يرفض الروابط الأخرى", () => {
    expect(parseComixUrl("https://comix.to/browse")).toBeNull();
    expect(parseComixUrl("https://page.kakao.com/content/1/viewer/2")).toBeNull();
    expect(parseComixUrl("not a url")).toBeNull();
    // معرف غير رقمي
    expect(parseComixUrl("https://comix.to/title/abc-def/xyz-chapter-1")?.chapterId).toBeNull();
  });
});

describe("buildComixPageUrls", () => {
  const base = "https://static.comix.to/58e5";

  it("يبني روابط عادية من baseUrl + url", () => {
    const urls = buildComixPageUrls({
      result: { pages: { baseUrl: base, items: [{ url: "/i/1/a.jpg" }, { url: "/i/2/b.jpg" }] } },
    });
    expect(urls).toEqual([`${base}/i/1/a.jpg`, `${base}/i/2/b.jpg`]);
  });

  it("صفحات V3 تحمل علامة #comixv3 وباراميتر v3", () => {
    const urls = buildComixPageUrls({
      result: { pages: { baseUrl: base, items: [{ url: "/i/1/a.jpg", s: 1 }, { url: "/i/2/b.jpg?v3" }] } },
    });
    expect(urls[0]).toBe(`${base}/i/1/a.jpg?v3#comixv3`);
    expect(urls[1]).toBe(`${base}/i/2/b.jpg?v3#comixv3`);
  });

  it("كل رابع صفحة في التشويش القديم تحمل علامة #comixscrambled", () => {
    const urls = buildComixPageUrls({
      result: {
        pages: {
          baseUrl: base,
          items: [{ url: "/1" }, { url: "/2" }, { url: "/3" }, { url: "/4" }, { url: "/5" }],
        },
      },
    });
    expect(urls[3]).toBe(`${base}/4#comixscrambled`);
    expect(urls[0]).toBe(`${base}/1`);
    expect(urls[4]).toBe(`${base}/5`);
  });

  it("يتجاهل العناصر الفارغة", () => {
    const urls = buildComixPageUrls({
      result: { pages: { baseUrl: base, items: [{ url: "" }, { url: "/ok" }] } },
    });
    expect(urls).toEqual([`${base}/ok`]);
  });

  it("قائمة فارغة تعيد مصفوفة فارغة", () => {
    expect(buildComixPageUrls({})).toEqual([]);
    expect(buildComixPageUrls({ result: { pages: { baseUrl: base, items: [] } } })).toEqual([]);
  });
});
