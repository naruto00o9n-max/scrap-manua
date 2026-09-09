import { describe, expect, it } from "vitest";
import {
  decodeHtmlEntities,
  parseDriveFilePageTitle,
  parseEmbeddedFolderView,
  probePublicDriveItem,
} from "./drivePublic";

/**
 * القوائم المبنية من استجابة حقيقية لمجلد Drive علني (13 صورة 1.jpg–13.jpg)
 * بنفس بنية embeddedfolderview تمامًا.
 */
function entry(id: string, name: string, kind: "file" | "folder" = "file"): string {
  const href =
    kind === "file"
      ? `https://drive.google.com/file/d/${id}/view?usp=drive_web`
      : `https://drive.google.com/drive/folders/${id}`;
  return (
    `<div class="flip-entry" id="entry-${id}" tabindex="0" role="link">` +
    `<div class="flip-entry-info"><a href="${href}" target="_blank">` +
    `<div class="flip-entry-visual"><div class="flip-entry-title">${name}</div>` +
    `</a></div></div>`
  );
}

const FOLDER_PAGE_HTML =
  `<!DOCTYPE html><html><head><title>Ch 21</title></head><body>` +
  `<div class="flip-entries">` +
  entry("1Aox8sQ6LFWcvOF2jQnzv5kW09E_jZ4Wp", "1.jpg") +
  entry("1j_PaGE7kujMbnEq8NPWKWBWEKQKgVXXE", "10.jpg") +
  entry("1BBU6wnGkmmyzUr_RVD7QNNnyNjmQQnbc", "11.jpg") +
  entry("1sQy5v-k3IZu7Dd9yCitEZNOsh9xlqex-", "13.jpg &amp; bonus.jpg") +
  entry("1SubFolderId000000000000000000000", "sub", "folder") +
  `</div></body></html>`;

const FILE_VIEW_HTML =
  `<!DOCTYPE html><html><head><title>1.jpg - Google 雲端硬碟</title></head><body>page</body></html>`;

const SIGN_IN_HTML =
  `<!DOCTYPE html><html><head><title>Sign in - Google Accounts</title></head><body></body></html>`;

const ERROR_404_HTML =
  `<!DOCTYPE html><html><head><title>Error 404 (Not Found)!!1</title></head><body></body></html>`;

describe("decodeHtmlEntities", () => {
  it("decodes the common named and numeric entities", () => {
    expect(decodeHtmlEntities("A &amp; B")).toBe("A & B");
    expect(decodeHtmlEntities("&#39;quoted&#39;")).toBe("'quoted'");
    expect(decodeHtmlEntities("&#x2665;")).toBe("♥");
    expect(decodeHtmlEntities("&lt;img&gt;")).toBe("<img>");
  });
});

describe("parseEmbeddedFolderView", () => {
  it("parses a real public folder listing: name, files, and entity-decoded names", () => {
    const parsed = parseEmbeddedFolderView(FOLDER_PAGE_HTML);
    expect(parsed.kind).toBe("folder");
    if (parsed.kind !== "folder") return;
    expect(parsed.name).toBe("Ch 21");
    // إدخال المجلد الفرعي لا يُدرج ضمن الملفات — نفس سلوك القائمة العادية.
    expect(parsed.files).toHaveLength(4);
    expect(parsed.files[0]).toEqual({
      id: "1Aox8sQ6LFWcvOF2jQnzv5kW09E_jZ4Wp",
      name: "1.jpg",
    });
    expect(parsed.files[3]).toEqual({
      id: "1sQy5v-k3IZu7Dd9yCitEZNOsh9xlqex-",
      name: "13.jpg & bonus.jpg",
    });
  });

  it("rejects sign-in, error, and title-less pages", () => {
    expect(parseEmbeddedFolderView(SIGN_IN_HTML).kind).toBe("other");
    expect(parseEmbeddedFolderView(ERROR_404_HTML).kind).toBe("other");
    expect(parseEmbeddedFolderView("<html><body>no title</body></html>").kind).toBe("other");
  });

  it("accepts an empty public folder when its title is present", () => {
    const parsed = parseEmbeddedFolderView(
      "<html><head><title>Ch فارغ</title></head><body></body></html>"
    );
    expect(parsed.kind).toBe("folder");
    if (parsed.kind !== "folder") return;
    expect(parsed.name).toBe("Ch فارغ");
    expect(parsed.files).toEqual([]);
  });
});

describe("parseDriveFilePageTitle", () => {
  it("strips the Google suffix in any language", () => {
    expect(parseDriveFilePageTitle(FILE_VIEW_HTML)).toBe("1.jpg");
    expect(
      parseDriveFilePageTitle("<title>My Archive - Google Drive</title>")
    ).toBe("My Archive");
  });

  it("rejects sign-in, error, and empty pages", () => {
    expect(parseDriveFilePageTitle(SIGN_IN_HTML)).toBeNull();
    expect(parseDriveFilePageTitle(ERROR_404_HTML)).toBeNull();
    expect(parseDriveFilePageTitle("<html><body></body></html>")).toBeNull();
  });
});

describe("probePublicDriveItem", () => {
  const okFetch = (body: string, status = 200) => async (url: string) => {
    expect(url).toContain("drive.google.com");
    return { status, body };
  };

  it("returns a folder item for a public folder link", async () => {
    const item = await probePublicDriveItem(
      "1EaJYu1ou4CavcwiOHF47LEA7Vpqkb-E8",
      "folder",
      okFetch(FOLDER_PAGE_HTML)
    );
    expect(item).toMatchObject({ kind: "folder", name: "Ch 21" });
    if (item?.kind !== "folder") return;
    expect(item.files).toHaveLength(4);
  });

  it("returns null when the folder endpoint 404s or shows a sign-in page", async () => {
    expect(
      await probePublicDriveItem("1Bad", "folder", okFetch(ERROR_404_HTML, 404))
    ).toBeNull();
    expect(await probePublicDriveItem("1Bad", "folder", okFetch(SIGN_IN_HTML))).toBeNull();
  });

  it("returns null when the probe fails (network error)", async () => {
    expect(await probePublicDriveItem("1Bad", "folder", async () => null)).toBeNull();
  });

  it("returns a file item for a public file link", async () => {
    const item = await probePublicDriveItem(
      "1Aox8sQ6LFWcvOF2jQnzv5kW09E_jZ4Wp",
      "file",
      okFetch(FILE_VIEW_HTML)
    );
    expect(item).toEqual({
      kind: "file",
      id: "1Aox8sQ6LFWcvOF2jQnzv5kW09E_jZ4Wp",
      name: "1.jpg",
    });
  });

  it("returns null for a non-public file link", async () => {
    expect(await probePublicDriveItem("1Bad", "file", okFetch(SIGN_IN_HTML))).toBeNull();
    expect(await probePublicDriveItem("1Bad", "file", okFetch("", 403))).toBeNull();
  });
});
