import { describe, expect, it } from "vitest";
import {
  buildChapterAnnouncement,
  buildLibraryAnnouncementEntry,
  chapterLabel,
  CHAPTER_WATCHER_INTERVAL_MAX,
  CHAPTER_WATCHER_INTERVAL_MIN,
  DEFAULT_CHAPTER_WATCHER_CONFIG,
  detectNewChapters,
  isPaidChapter,
  normalizeChapterWatcherConfig,
  renderAnnouncementTemplate,
  resolveChapterLink,
  resolveMangaLink,
  type AnnouncementEntry,
} from "./chapterWatcher";
import type { SuwayomiWatchedChapter } from "./suwayomi";

function chapter(id: number, order: number, name = `Chapter ${order}`): SuwayomiWatchedChapter {
  return { id, name, url: `https://site.example/ch/${id}`, realUrl: null, sourceOrder: order };
}

const entry: AnnouncementEntry = {
  mangaTitle: "العمل",
  sourceName: "المصدر",
  link: "https://site.example/ch/9",
  mangaLink: "https://site.example/manga/1",
  thumbnailUrl: "https://site.example/cover.jpg",
  chapters: [{ name: "الفصل 9", number: 9, url: "https://site.example/ch/9", locked: false }],
};

describe("normalizeChapterWatcherConfig", () => {
  it("returns defaults for empty input", () => {
    expect(normalizeChapterWatcherConfig(null)).toEqual(DEFAULT_CHAPTER_WATCHER_CONFIG);
    expect(normalizeChapterWatcherConfig({})).toMatchObject({ enabled: false, channelId: "" });
  });

  it("clamps the interval to the supported range", () => {
    expect(normalizeChapterWatcherConfig({ intervalMinutes: 0 }).intervalMinutes).toBe(CHAPTER_WATCHER_INTERVAL_MIN);
    expect(normalizeChapterWatcherConfig({ intervalMinutes: 99_999 }).intervalMinutes).toBe(
      CHAPTER_WATCHER_INTERVAL_MAX
    );
    expect(normalizeChapterWatcherConfig({ intervalMinutes: 7.6 }).intervalMinutes).toBe(8);
  });

  it("keeps only digits in the channel id and rejects bad gif urls", () => {
    const normalized = normalizeChapterWatcherConfig({ channelId: " 12ab34#56 ", dividerGifUrl: "javascript:alert(1)" });
    expect(normalized.channelId).toBe("123456");
    expect(normalized.dividerGifUrl).toBe(DEFAULT_CHAPTER_WATCHER_CONFIG.dividerGifUrl);
  });
});

describe("renderAnnouncementTemplate", () => {
  it("replaces every supported placeholder", () => {
    expect(
      renderAnnouncementTemplate("{manga} — {chapter} ({source}) {link}", {
        manga: "A",
        chapter: "B",
        source: "C",
        link: "https://x.y",
      })
    ).toBe("A — B (C) https://x.y");
  });
});

describe("buildChapterAnnouncement", () => {
  const config = {
    ...DEFAULT_CHAPTER_WATCHER_CONFIG,
    enabled: true,
    channelId: "123",
  };

  it("builds the fixed Components V2 card fields", () => {
    const announcement = buildChapterAnnouncement(config, entry, { now: new Date("2026-01-01T00:00:00Z") });
    expect(announcement.dividerUrl).toBe(DEFAULT_CHAPTER_WATCHER_CONFIG.dividerGifUrl);
    expect(announcement.titleLine).toBe("نزول فصل جديد");
    expect(announcement.mangaTitle).toBe("العمل");
    expect(announcement.fields).toContain("**الفصل:** 9");
    expect(announcement.fields).toContain("**المصدر:** المصدر");
    expect(announcement.fields).toContain("مجاني");
    expect(announcement.chapterLink).toBe("https://site.example/ch/9");
    expect(announcement.mangaLink).toBe("https://site.example/manga/1");
    expect(announcement.footerBrand).toBe("ZEUS");
  });

  it("marks locked chapters as paid and falls back to the name without a number", () => {
    const announcement = buildChapterAnnouncement(config, {
      ...entry,
      chapters: [{ name: "فصل خاص [premium]", number: null, url: "", locked: true }],
    });
    expect(announcement.fields).toContain("مدفوع");
    expect(announcement.fields).toContain("**الفصل:** فصل خاص [premium]");
  });

  it("joins multiple chapter labels in one line", () => {
    const announcement = buildChapterAnnouncement(config, {
      ...entry,
      chapters: [
        { name: "الفصل 8", number: 8, url: "", locked: false },
        { name: "الفصل 9", number: 9, url: "", locked: false },
      ],
    });
    expect(announcement.fields).toContain("**الفصل:** 8، 9");
  });
});

describe("isPaidChapter", () => {
  it("detects the lock flag and lock markers in the name", () => {
    expect(isPaidChapter({ isLocked: true, name: "الفصل 5" })).toBe(true);
    expect(isPaidChapter({ isLocked: false, name: "🔒 الفصل 5" })).toBe(true);
    expect(isPaidChapter({ isLocked: null, name: "الفصل 5 [premium]" })).toBe(true);
    expect(isPaidChapter({ isLocked: false, name: "الفصل 5" })).toBe(false);
    expect(isPaidChapter({ name: "الفصل 5" })).toBe(false);
  });
});

describe("chapterLabel", () => {
  it("formats numbers and falls back to the name", () => {
    expect(chapterLabel({ name: "الفصل 23", number: 23, url: "", locked: false })).toBe("23");
    expect(chapterLabel({ name: "الفصل 23.5", number: 23.5, url: "", locked: false })).toBe("23.5");
    expect(chapterLabel({ name: "فصل خاص", number: null, url: "", locked: false })).toBe("فصل خاص");
  });
});

describe("buildLibraryAnnouncementEntry", () => {
  it("resolves manga and chapter links against the source", () => {
    const manga = { id: 1, title: "العمل", thumbnailUrl: "https://site.example/cover.jpg", url: "", realUrl: "https://site.example/manga/1" };
    const source = { baseUrl: "https://site.example/" };
    const result = buildLibraryAnnouncementEntry(manga, [chapter(9, 9, "الفصل 9")], source, "المصدر");
    expect(result.mangaLink).toBe("https://site.example/manga/1");
    expect(result.link).toBe("https://site.example/ch/9");
    expect(result.sourceName).toBe("المصدر");
    expect(result.thumbnailUrl).toBe("https://site.example/cover.jpg");
    expect(result.chapters[0]?.locked).toBe(false);
  });

  it("resolves relative manga urls against the source base", () => {
    const manga = { id: 1, title: "العمل", thumbnailUrl: null, url: "manga/1", realUrl: null };
    const result = buildLibraryAnnouncementEntry(manga, [chapter(1, 1)], { baseUrl: "https://site.example" }, "S");
    expect(result.mangaLink).toBe("https://site.example/manga/1");
  });
});

describe("detectNewChapters", () => {
  it("treats the first sighting as a baseline with nothing to announce", () => {
    const result = detectNewChapters([chapter(1, 4), chapter(2, 5)], 0);
    expect(result.baseline).toBe(true);
    expect(result.newChapters).toEqual([]);
    expect(result.maxOrder).toBe(5);
  });

  it("detects chapters above the tracked order in ascending order", () => {
    const result = detectNewChapters([chapter(3, 6), chapter(1, 4), chapter(2, 5)], 5);
    expect(result.baseline).toBe(false);
    expect(result.newChapters.map(item => item.id)).toEqual([3]);
    expect(result.maxOrder).toBe(6);
  });

  it("caps the announcement burst to the newest chapters", () => {
    const chapters = Array.from({ length: 11 }, (_, index) => chapter(index + 1, index + 5));
    const result = detectNewChapters(chapters, 4);
    expect(result.newChapters).toHaveLength(5);
    // أحدث خمسة: الترتيب 11..15 أي المعرفات 7..11
    expect(result.newChapters[0]?.id).toBe(7);
    expect(result.newChapters.at(-1)?.id).toBe(11);
  });

  it("reports nothing new when the order did not advance", () => {
    const result = detectNewChapters([chapter(1, 4)], 4);
    expect(result.newChapters).toEqual([]);
    expect(result.maxOrder).toBe(4);
  });
});

describe("resolveChapterLink", () => {
  it("prefers the absolute real url", () => {
    expect(resolveChapterLink(chapter(1, 1), { baseUrl: "https://site.example" })).toBe("https://site.example/ch/1");
    expect(
      resolveChapterLink({ ...chapter(1, 1), realUrl: "https://real.example/ch/1" }, { baseUrl: "https://site.example" })
    ).toBe("https://real.example/ch/1");
  });

  it("resolves relative urls against the source base", () => {
    expect(
      resolveChapterLink({ ...chapter(1, 1), realUrl: "ch/1" }, { baseUrl: "https://site.example/base/" })
    ).toBe("https://site.example/base/ch/1");
  });

  it("returns null without a usable url", () => {
    expect(resolveChapterLink({ ...chapter(1, 1), url: "", realUrl: null }, undefined)).toBeNull();
  });
});

describe("resolveMangaLink", () => {
  it("prefers the absolute real url then falls back to relative url on the source base", () => {
    expect(resolveMangaLink({ url: "", realUrl: "https://real.example/manga/1" }, undefined)).toBe("https://real.example/manga/1");
    expect(resolveMangaLink({ url: "manga/1", realUrl: "" }, { baseUrl: "https://site.example" })).toBe("https://site.example/manga/1");
    expect(resolveMangaLink({ url: "", realUrl: null }, { baseUrl: "https://site.example" })).toBeNull();
  });
});
