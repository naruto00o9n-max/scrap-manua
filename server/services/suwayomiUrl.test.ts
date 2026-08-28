import { describe, expect, it } from "vitest";
import { mangaUrlFromChapterUrl, resolveSuwayomiPageUrl, sourceSearchQueryFromChapterUrl } from "./suwayomi";

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

  it("declines unsupported URL structures", () => {
    expect(mangaUrlFromChapterUrl("https://asurascans.com/comics/title")).toBeNull();
  });

  it("resolves a Suwayomi page path to the configured HTTPS server", () => {
    expect(resolveSuwayomiPageUrl("/api/v1/manga/9/chapter/157/page/0", "https://suwayomi.example/api/graphql"))
      .toBe("https://suwayomi.example/api/v1/manga/9/chapter/157/page/0");
  });
});
