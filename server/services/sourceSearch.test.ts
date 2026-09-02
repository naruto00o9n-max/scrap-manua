import { describe, expect, it } from "vitest";
import type { SuwayomiManga } from "./suwayomi";
import {
  chapterUrlFromParts,
  checkChapterAvailability,
  matchScore,
  normalizeForSearch,
  parseChapterNumber,
  searchAllSources,
  type MangaSearcher,
} from "./sourceSearch";

function manga(id: number, title: string, overrides: Partial<SuwayomiManga> = {}): SuwayomiManga {
  return {
    id,
    title,
    url: `/manga/${id}/`,
    realUrl: `https://source.test/manga/${id}/`,
    thumbnailUrl: `https://source.test/${id}.jpg`,
    sourceId: "1",
    ...overrides,
  };
}

describe("normalizeForSearch", () => {
  it("strips Arabic diacritics and unifies letter variants", () => {
    expect(normalizeForSearch("سُولو لِفِلِنغ!")).toBe("سولو لفلنغ");
    expect(normalizeForSearch("أحمدُ الأعمى")).toBe("احمد الاعمي");
    expect(normalizeForSearch("مدرسة الإخوة")).toBe("مدرسه الاخوه");
  });

  it("lowercases latin text and strips punctuation", () => {
    expect(normalizeForSearch("Solo Leveling!!")).toBe("solo leveling");
  });
});

describe("matchScore", () => {
  it("ranks exact match highest and rejects unrelated titles", () => {
    expect(matchScore("solo leveling", "Solo Leveling")).toBe(100);
    expect(matchScore("solo", "Solo Leveling")).toBeGreaterThan(0);
    expect(matchScore("berserk", "Solo Leveling")).toBe(0);
  });

  it("matches across Arabic normalization differences", () => {
    expect(matchScore("الأنها", "الأنهَا")).toBe(100);
    expect(matchScore("مدرسة الاخوه", "مدرسة الإخوة!")).toBe(100);
  });

  it("gives partial credit for word overlap", () => {
    const score = matchScore("the beginning after the end", "The Beginning After The End (Official)");
    expect(score).toBeGreaterThan(0);
    expect(score).toBeLessThan(100);
  });
});

describe("searchAllSources", () => {
  const sources = [
    { suwayomiSourceId: "a", name: "Source A", lang: "en" },
    { suwayomiSourceId: "b", name: "Source B", lang: "ar" },
    { suwayomiSourceId: "c", name: "Source C", lang: "en" },
  ];

  function searcherWith(
    perSource: Record<string, SuwayomiManga[]>,
    failures: string[] = []
  ): MangaSearcher {
    return {
      async searchSourceManga(sourceId: string) {
        if (failures.includes(sourceId)) throw new Error("boom");
        return perSource[sourceId] ?? [];
      },
      async fetchMangaAndChapters() {
        return [];
      },
    };
  }

  it("aggregates ranked matches from all sources and skips non-matching titles", async () => {
    const outcome = await searchAllSources(
      searcherWith({
        a: [manga(1, "Solo Leveling"), manga(2, "Berserk")],
        b: [manga(3, "Solo Leveling (عربي)")],
        c: [manga(4, "Novel: Solo Leveling")],
      }),
      sources,
      "solo leveling"
    );
    expect(outcome.searched).toBe(3);
    expect(outcome.failed).toHaveLength(0);
    expect(outcome.matches.map(item => item.mangaId)).toEqual([1, 3, 4]);
    expect(outcome.matches[0]!.score).toBe(100);
  });

  it("counts failing sources without failing the whole search", async () => {
    const outcome = await searchAllSources(
      searcherWith({ a: [manga(1, "Solo Leveling")] }, ["b", "c"]),
      sources,
      "solo leveling"
    );
    expect(outcome.failed.map(item => item.sourceName)).toEqual(["Source B", "Source C"]);
    expect(outcome.matches).toHaveLength(1);
  });

  it("retries failing sources once before counting them as failed", async () => {
    // المواقع كثيرًا ما تتعثر في الموجة الأولى (تقييد اندفاع الطلبات) ثم
    // تنجح من محاولة هادئة — المتعثر حقًا فقط يبقى في قائمة الفشل.
    const calls: string[] = [];
    const searcher: MangaSearcher = {
      async searchSourceManga(sourceId: string) {
        calls.push(sourceId);
        if (sourceId === "dead") throw new Error("boom");
        const flakyHits = calls.filter(call => call === "flaky").length;
        if (sourceId === "flaky" && flakyHits === 1) throw new Error("انتهت مهلة هذا الموقع");
        if (sourceId === "flaky") return [manga(9, "Solo Leveling")];
        return [];
      },
      async fetchMangaAndChapters() {
        return [];
      },
    };
    const outcome = await searchAllSources(
      searcher,
      [
        { suwayomiSourceId: "flaky", name: "Flaky", lang: "en" },
        { suwayomiSourceId: "ok", name: "OK", lang: "en" },
        { suwayomiSourceId: "dead", name: "Dead", lang: "ar" },
      ],
      "solo"
    );
    // المتعثر المتعافي لم يعد ضمن الفشل، والمصدر الميت فعلاً بقي وحده.
    expect(outcome.failed.map(item => item.sourceName)).toEqual(["Dead"]);
    expect(outcome.matches.map(item => item.mangaId)).toEqual([9]);
    expect(calls.filter(call => call === "flaky")).toHaveLength(2);
  });
});

describe("checkChapterAvailability", () => {
  it("reports which sources have the requested chapter number", async () => {
    const searcher: MangaSearcher = {
      async searchSourceManga() {
        return [];
      },
      async fetchMangaAndChapters(mangaId: number) {
        if (mangaId === 1) {
          return [
            { id: 11, name: "Chapter 38", url: "/c/38", realUrl: null, chapterNumber: 38, manga: { id: 1, title: "t", sourceId: "a" } },
          ];
        }
        if (mangaId === 2) throw new Error("timeout");
        return [{ id: 12, name: "Chapter 37", url: "/c/37", realUrl: null, chapterNumber: 37, manga: { id: 2, title: "t", sourceId: "b" } }];
      },
    };
    const matches = [
      { sourceId: "a", sourceName: "A", lang: "en", mangaId: 1, title: "X", url: "/m/1", realUrl: null, thumbnailUrl: null, score: 100 },
      { sourceId: "b", sourceName: "B", lang: "en", mangaId: 2, title: "X", url: "/m/2", realUrl: null, thumbnailUrl: null, score: 90 },
      { sourceId: "c", sourceName: "C", lang: "en", mangaId: 3, title: "X", url: "/m/3", realUrl: null, thumbnailUrl: null, score: 80 },
    ];
    const rows = await checkChapterAvailability(searcher, matches, 38);
    expect(rows[0]!.chapter?.number).toBe(38);
    expect(rows[0]!.chapter?.name).toBe("Chapter 38");
    expect(rows[1]!.error).toBe("timeout");
    expect(rows[2]!.chapter).toBeNull();
    expect(rows[2]!.error).toBeNull();
  });
});

describe("chapterUrlFromParts", () => {
  it("prefers the chapter realUrl when it is absolute", () => {
    expect(
      chapterUrlFromParts(
        { url: "/manga/x/", realUrl: "https://s.test/manga/x/" },
        { url: "/manga/x/chapter-2/", realUrl: "https://s.test/manga/x/chapter-2/" }
      )
    ).toBe("https://s.test/manga/x/chapter-2/");
  });

  it("resolves a relative chapter url against the manga realUrl", () => {
    expect(
      chapterUrlFromParts(
        { url: "/manga/x/", realUrl: "https://s.test/manga/x/" },
        { url: "/manga/x/chapter-2/", realUrl: null }
      )
    ).toBe("https://s.test/manga/x/chapter-2/");
  });

  it("returns null when no absolute base exists", () => {
    expect(
      chapterUrlFromParts({ url: "/manga/x/", realUrl: null }, { url: "/c/2/", realUrl: null })
    ).toBeNull();
  });
});

describe("parseChapterNumber", () => {
  it("accepts latin and arabic-indic digits and decimals", () => {
    expect(parseChapterNumber("38")).toBe(38);
    expect(parseChapterNumber("٣٨")).toBe(38);
    expect(parseChapterNumber("38.5")).toBe(38.5);
  });

  it("rejects invalid input", () => {
    expect(parseChapterNumber("abc")).toBeNull();
    expect(parseChapterNumber("-1")).toBeNull();
    expect(parseChapterNumber("")).toBeNull();
    expect(parseChapterNumber(null)).toBeNull();
  });
});
