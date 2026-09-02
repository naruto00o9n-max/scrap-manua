import { describe, expect, it } from "vitest";
import { mangaFolderTitle } from "./googleDrive";

describe("mangaFolderTitle", () => {
  it("appends the chapter source host to the manga title", () => {
    expect(mangaFolderTitle("Solo Leveling", "https://rokaricomics.com/solo-leveling-chapter-38/")).toBe(
      "Solo Leveling [rokaricomics.com]"
    );
  });

  it("strips www from the host", () => {
    expect(mangaFolderTitle("Solo Leveling", "https://www.rokaricomics.com/solo-leveling-chapter-38/")).toBe(
      "Solo Leveling [rokaricomics.com]"
    );
  });

  it("keeps different sources in different folders even with the same title", () => {
    const a = mangaFolderTitle("Same Manga", "https://source-a.com/chapter-38");
    const b = mangaFolderTitle("Same Manga", "https://source-b.com/chapter-38");
    expect(a).not.toBe(b);
  });

  it("reuses the same folder for the same source (resume behavior)", () => {
    const a = mangaFolderTitle("Same Manga", "https://source-a.com/chapter-38");
    const b = mangaFolderTitle("Same Manga", "https://source-a.com/chapter-38");
    expect(a).toBe(b);
  });

  it("returns the title unchanged without a usable url", () => {
    expect(mangaFolderTitle("Solo Leveling", null)).toBe("Solo Leveling");
    expect(mangaFolderTitle("Solo Leveling", undefined)).toBe("Solo Leveling");
    expect(mangaFolderTitle("Solo Leveling", "")).toBe("Solo Leveling");
    expect(mangaFolderTitle("Solo Leveling", "not-a-url")).toBe("Solo Leveling");
  });

  it("is idempotent when the host label already exists", () => {
    expect(mangaFolderTitle("Solo Leveling [rokaricomics.com]", "https://rokaricomics.com/chapter-1/")).toBe(
      "Solo Leveling [rokaricomics.com]"
    );
  });
});
