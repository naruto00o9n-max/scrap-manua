import { describe, expect, it } from "vitest";
import {
  chapterNumberFromUrl,
  mangaUrlFromChapterUrl,
  resolveSuwayomiPageUrl,
  searchQueryVariants,
  sourceSearchQueryFromChapterUrl,
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
