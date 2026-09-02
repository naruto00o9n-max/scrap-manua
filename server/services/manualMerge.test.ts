import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import sharp from "sharp";
import { afterEach, describe, expect, it } from "vitest";
import {
  collectImageFiles,
  isSupportedArchiveName,
  naturalCompare,
  parseDriveLink,
} from "./manualMerge";
import { openLocalImageMergeSession } from "./imageMerging";

const tempDirs: string[] = [];

async function makeTempDir(prefix: string): Promise<string> {
  const dir = await mkdtemp(path.join(tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

afterEach(async () => {
  while (tempDirs.length) {
    const dir = tempDirs.pop()!;
    await rm(dir, { recursive: true, force: true });
  }
});

describe("parseDriveLink", () => {
  it("parses folder links", () => {
    expect(
      parseDriveLink("https://drive.google.com/drive/folders/1AbC-deF_ghIjKlMn")
    ).toEqual({ kind: "folder", id: "1AbC-deF_ghIjKlMn" });
    expect(
      parseDriveLink(
        "https://drive.google.com/drive/u/0/folders/1AbC-deF_ghIjKlMn?resourcekey=abc"
      )
    ).toEqual({ kind: "folder", id: "1AbC-deF_ghIjKlMn" });
  });

  it("parses file links and id-based links", () => {
    expect(
      parseDriveLink(
        "https://drive.google.com/file/d/1XyZ_abcDEF123456/view?usp=sharing"
      )
    ).toEqual({ kind: "file", id: "1XyZ_abcDEF123456" });
    expect(
      parseDriveLink("https://drive.google.com/open?id=1XyZ_abcDEF123456")
    ).toEqual({ kind: "file", id: "1XyZ_abcDEF123456" });
    expect(
      parseDriveLink(
        "https://drive.google.com/uc?export=download&id=1XyZ_abcDEF123456"
      )
    ).toEqual({ kind: "file", id: "1XyZ_abcDEF123456" });
  });

  it("rejects non-Drive or unsafe links", () => {
    expect(parseDriveLink("https://example.com/drive/folders/1AbC-deF_ghIj")).toBeNull();
    expect(parseDriveLink("http://drive.google.com/drive/folders/1AbC-deF_ghIj")).toBeNull();
    expect(parseDriveLink("https://drive.google.com/drive/folders/short")).toBeNull();
    expect(parseDriveLink("not a link")).toBeNull();
    expect(parseDriveLink("")).toBeNull();
  });
});

describe("natural image ordering", () => {
  it("sorts page numbers numerically instead of lexically", () => {
    const names = ["page_10.jpg", "page_2.jpg", "page_1.jpg", "Page_3.PNG"];
    const sorted = [...names].sort(naturalCompare);
    expect(sorted).toEqual(["page_1.jpg", "page_2.jpg", "Page_3.PNG", "page_10.jpg"]);
  });

  it("collects only images recursively and sorts them naturally", async () => {
    const dir = await makeTempDir("collect-images-");
    await mkdir(path.join(dir, "sub"), { recursive: true });
    await writeFile(path.join(dir, "page_2.jpg"), "x");
    await writeFile(path.join(dir, "page_10.jpg"), "x");
    await writeFile(path.join(dir, "notes.txt"), "x");
    await writeFile(path.join(dir, "sub", "page_1.png"), "x");
    const files = await collectImageFiles(dir);
    const relative = files.map(file => path.relative(dir, file));
    // الفرز على المسار الكامل: ملفات الجذر بترتيب رقمي طبيعي، ثم المجلدات الفرعية.
    expect(relative).toEqual([
      "page_2.jpg",
      "page_10.jpg",
      path.join("sub", "page_1.png"),
    ]);
  });
});

describe("supported archive names", () => {
  it("accepts zip and cbz only", () => {
    expect(isSupportedArchiveName("chapter.zip")).toBe(true);
    expect(isSupportedArchiveName("Chapter.CBZ")).toBe(true);
    expect(isSupportedArchiveName("chapter.rar")).toBe(false);
    expect(isSupportedArchiveName("chapter.png")).toBe(false);
    expect(isSupportedArchiveName(null)).toBe(false);
    expect(isSupportedArchiveName(undefined)).toBe(false);
  });
});

describe("openLocalImageMergeSession", () => {
  it("merges local image files with the same no-crop grouping as chapters", async () => {
    const dir = await makeTempDir("local-merge-");
    const pagePaths: string[] = [];
    for (let index = 0; index < 3; index += 1) {
      const pagePath = path.join(dir, `page-${index + 1}.png`);
      await sharp({
        create: {
          width: 100,
          height: 6000,
          channels: 3,
          background: { r: 200, g: 180, b: 120 },
        },
      })
        .png()
        .toFile(pagePath);
      pagePaths.push(pagePath);
    }

    const session = await openLocalImageMergeSession(pagePaths);
    try {
      // صفحتان 6000px تُجمّعان في صورة 12000px، والثالثة تبقى مستقلة.
      expect(session.images).toHaveLength(2);
      expect(session.images[0]!.height).toBe(12000);
      expect(session.images[1]!.height).toBe(6000);
      for (const image of session.images) {
        const metadata = await sharp(image.filePath).metadata();
        expect(metadata.width).toBe(100);
      }
    } finally {
      await session.cleanup();
    }
  });
});
