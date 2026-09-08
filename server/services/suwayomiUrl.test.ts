import { describe, expect, it } from "vitest";
import {
  chapterNumberFromUrl,
  mangaUrlFromChapterUrl,
  resolveSuwayomiPageUrl,
  searchQueryVariants,
  sourceSearchQueryFromChapterUrl,
  urlSearchQueryFromMangaUrl,
} from "./suwayomi";

describe("Suwayomi source lookup helpers", () => {
  const chapter = "https://asurascans.com/comics/surviving-the-game-as-a-barbarian-b57aa235/chapter/157";

  it("derives the parent manga URL from a canonical chapter URL", () => {
    expect(mangaUrlFromChapterUrl(chapter)).toBe("https://asurascans.com/comics/surviving-the-game-as-a-barbarian-b57aa235");
  });

  it("derives a source search term without the opaque series suffix", () => {
    expect(sourceSearchQueryFromChapterUrl(chapter)).toBe("surviving the game as a barbarian");
  });

  it("derives Naver's indexed manga URL from a detail URL", () => {
    expect(mangaUrlFromChapterUrl("https://comic.naver.com/webtoon/detail?titleId=799837&no=156&week=fri"))
      .toBe("https://comic.naver.com/webtoon/list?titleId=799837");
  });

  it("understands the owner's webtoons challenge link (canvas path + ep number)", () => {
    // رابط المالك بعد تطبيع urlPolicy (نطاق m + مسار challenge) — الإضافة تخزن
    // روابطها على www + canvas، فتوحيد المسار هو ما يجعل مطابقة العمل تُصيب.
    const chapter = "https://m.webtoons.com/en/challenge/falling-in-love-with-my-ex-fiances-grandfather/ep-133/viewer?title_no=855089&episode_no=204";
    expect(mangaUrlFromChapterUrl(chapter)).toBe(
      "https://m.webtoons.com/en/canvas/falling-in-love-with-my-ex-fiances-grandfather/list?title_no=855089"
    );
    expect(chapterNumberFromUrl(chapter)).toBe(133);
    // المسار القياسي canvas يبقى كما هو بلا أي تحويل
    expect(mangaUrlFromChapterUrl(
      "https://www.webtoons.com/en/canvas/falling-in-love-with-my-ex-fiances-grandfather/ep-1/viewer?title_no=855089&episode_no=72"
    )).toBe("https://www.webtoons.com/en/canvas/falling-in-love-with-my-ex-fiances-grandfather/list?title_no=855089");
  });

  it("understands the owner's mobile Naver link (m.host, noise params, no= param)", () => {
    const chapter = "https://m.comic.naver.com/webtoon/detail?titleId=854757&no=1&week=tue&listSortOrder=DESC&listPage=1";
    expect(mangaUrlFromChapterUrl(chapter)).toBe("https://comic.naver.com/webtoon/list?titleId=854757");
    expect(chapterNumberFromUrl(chapter)).toBe(1);
  });

  it("builds the extension URL-search query from webtoons manga URLs", () => {
    // رابط m.webtoons يُعاد كتابته إلى www لأن الإضافة ترفض غيره
    expect(urlSearchQueryFromMangaUrl(
      "https://m.webtoons.com/en/canvas/falling-in-love-with-my-ex-fiances-grandfather/list?title_no=855089"
    )).toBe("https://www.webtoons.com/en/canvas/falling-in-love-with-my-ex-fiances-grandfather/list?title_no=855089");
    // رابط www يبقى كما هو
    expect(urlSearchQueryFromMangaUrl(
      "https://www.webtoons.com/en/drama/some-original/list?title_no=95"
    )).toBe("https://www.webtoons.com/en/drama/some-original/list?title_no=95");
    // بلا title_no أو من نطاق آخر → لا استعلام رابط
    expect(urlSearchQueryFromMangaUrl("https://www.webtoons.com/en/canvas/slug/list")).toBeNull();
    expect(urlSearchQueryFromMangaUrl("https://comic.naver.com/webtoon/list?titleId=799837")).toBeNull();
    expect(urlSearchQueryFromMangaUrl("not a url")).toBeNull();
  });


  it("derives the manga URL and chapter number from comix.to style links (user's failing case)", () => {
    const chapter = "https://comix.to/title/501vk-the-top-1-student-hides-her-regression/11302227-chapter-6";
    expect(mangaUrlFromChapterUrl(chapter)).toBe(
      "https://comix.to/title/501vk-the-top-1-student-hides-her-regression"
    );
    expect(chapterNumberFromUrl(chapter)).toBe(6);
    expect(sourceSearchQueryFromChapterUrl(chapter)).toBe(
      "501vk the top 1 student hides her regression"
    );
    // صيغة البحث البديلة تُسقط بادئة معرّف الموقع التي تُفشل بحث بعض المواقع
    expect(searchQueryVariants("501vk the top 1 student hides her regression")).toEqual([
      "501vk the top 1 student hides her regression",
      "the top 1 student hides her regression",
    ]);
    // أسماء تبدو مثل معرّف لكنها أقصر من العتبة تبقى كما هي
    expect(searchQueryVariants("solo leveling ragnarok")).toEqual(["solo leveling ragnarok"]);
  });

  it("understands compound chapter markers with decimals and trailing page segments", () => {
    expect(mangaUrlFromChapterUrl("https://site.example/manga/solo-leveling/ch-12.5")).toBe(
      "https://site.example/manga/solo-leveling"
    );
    expect(chapterNumberFromUrl("https://site.example/manga/solo-leveling/ch-12.5")).toBe(12.5);
    expect(mangaUrlFromChapterUrl("https://site.example/series/x/ep-4/2")).toBe(
      "https://site.example/series/x"
    );
    expect(chapterNumberFromUrl("https://site.example/series/x/ep-4/2")).toBe(4);
    expect(chapterNumberFromUrl(chapter)).toBe(157);
    expect(chapterNumberFromUrl("https://site.example/no/chapter/marker")).toBeNull();
  });

  it("declines unsupported URL structures", () => {
    expect(mangaUrlFromChapterUrl("https://asurascans.com/comics/title")).toBeNull();
  });

  it("resolves a Suwayomi page path to the configured HTTPS server", () => {
    expect(resolveSuwayomiPageUrl("/api/v1/manga/9/chapter/157/page/0", "https://suwayomi.example/api/graphql"))
      .toBe("https://suwayomi.example/api/v1/manga/9/chapter/157/page/0");
  });
});
