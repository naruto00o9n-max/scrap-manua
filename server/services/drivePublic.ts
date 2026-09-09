import { createWriteStream } from "node:fs";
import { Readable, Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
import { GoogleDriveError } from "./googleDrive";

/**
 * مسار القراءة العلنية لروابط Google Drive.
 *
 * لماذا وُجد هذا الملف: بعض توكنات OAuth تُمنح بنطاق «لكل ملف أنشأه التطبيق»
 * (drive.file) — بموجبه يرى البوت ملفات التي أنشأها بنفسه (سحب الفصول يعمل)
 * لكن أي مجلد خارجي — حتى لو كان مشاركًا «أي شخص لديه الرابط» — يعيد 404
 * من Drive API. المستخدم يرى الرابط يعمل في متصفحه فيظن البوت معطّلًا.
 *
 * الحل: عندما لا يرى حساب البوت العنصر، نجرّب القراءة عبر واجهات Drive
 * العلنية نفسها التي يستخدمها المتصفح (بدون أي توكن):
 * - سرد مجلد عام:  https://drive.google.com/embeddedfolderview?id=<id>
 * - اسم ملف عام:   https://drive.google.com/file/d/<id>/view
 * - تنزيل ملف عام: https://drive.usercontent.google.com/download?id=<id>&export=download&confirm=t
 *
 * تعمل هذه المسارات فقط مع عناصر مشاركة علنًا، وبذلك يظل أي عنصر خاص
 * خارج وصول البوت (يُبلغ عنه برسالة واضحة).
 */

const FOLDER_VIEW_URL = "https://drive.google.com/embeddedfolderview?id=";
const FILE_VIEW_URL = "https://drive.google.com/file/d/";
const DOWNLOAD_URL = "https://drive.usercontent.google.com/download?id=";

const PROBE_TIMEOUT_MS = 20_000;
const DOWNLOAD_TIMEOUT_MS = 60_000;

/** صفحة دخول/خطأ من Google — ليست عنصرًا علنيًا. */
const NON_PUBLIC_TITLE = /sign\s*in|google\s*accounts|^error\s*\d+|not\s*found|لا يمكن الوصول|تحتاج إلى الإذن/i;

export type PublicDriveFile = { id: string; name: string };

export type PublicDriveItem =
  | { kind: "folder"; id: string; name: string; files: PublicDriveFile[] }
  | { kind: "file"; id: string; name: string };

export type TextFetch = (url: string) => Promise<{ status: number; body: string } | null>;

/** فك ترميز HTML الأساسي في أسماء الملفات والمجلدات (&amp; و&#39; …). */
export function decodeHtmlEntities(value: string): string {
  return value
    .replace(/&#x([0-9a-f]+);/gi, (_, hex: string) => String.fromCodePoint(parseInt(hex, 16)))
    .replace(/&#(\d+);/g, (_, dec: string) => String.fromCodePoint(parseInt(dec, 10)))
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&#39;/g, "'")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&amp;/g, "&");
}

export type EmbeddedFolderView =
  | { kind: "folder"; name: string | null; files: PublicDriveFile[] }
  | { kind: "other" };

/**
 * يحلل صفحة embeddedfolderview لمجلد Drive علني.
 * بنية الصفحة: عنوان <title> باسم المجلد، ثم لكل عنصر كتلة
 * `<div class="flip-entry" id="entry-<fileId>" … href="…/file/d/<id>/view…"> … flip-entry-title">الاسم<`.
 * روابط المجلدات الفرعية تحتوي /folders/<id> — تُعيد قائمة مستقلة عنها.
 * تعيد kind:"other" إن لم تكن صفحة مجلد علني (صفحة دخول/خطأ/فارغة بلا عنوان).
 */
export function parseEmbeddedFolderView(html: string): EmbeddedFolderView {
  const titleMatch = html.match(/<title>([^<]*)<\/title>/i);
  const rawTitle = titleMatch?.[1]?.trim() ?? "";
  const title = decodeHtmlEntities(rawTitle);
  if (!title || NON_PUBLIC_TITLE.test(title)) return { kind: "other" };

  const files: PublicDriveFile[] = [];
  const blocks = html.split(/(?=<div class="flip-entry")/).slice(1);
  for (const block of blocks) {
    const id = block.match(/id="entry-([-\w]{10,})"/)?.[1];
    if (!id) continue;
    const href = block.match(/href="([^"]+)"/)?.[1] ?? "";
    // مجلد فرعي — لا يُدرج ضمن الملفات (نفس سلوك القائمة العادية).
    if (/\/folders\//.test(href) && !/\/file\/d\//.test(href)) continue;
    const nameMatch = block.match(/flip-entry-title">([^<]*)</);
    if (!nameMatch) continue;
    files.push({ id, name: decodeHtmlEntities(nameMatch[1].trim()) || "ملف" });
  }
  return { kind: "folder", name: title || null, files };
}

/**
 * يستخرج اسم ملف علني من صفحة عرض الملف /file/d/<id>/view.
 * صفحة Google تعيد العنوان «<الاسم> - Google Drive» (بأي لغة) — نقص اللاحقة.
 * تعيد null لصفحات الدخول أو الأخطاء.
 */
export function parseDriveFilePageTitle(html: string): string | null {
  const titleMatch = html.match(/<title>([^<]*)<\/title>/i);
  const rawTitle = titleMatch?.[1]?.trim() ?? "";
  if (!rawTitle) return null;
  if (NON_PUBLIC_TITLE.test(rawTitle)) return null;
  const name = decodeHtmlEntities(rawTitle).replace(/\s+-\s+Google.*$/, "").trim();
  return name || null;
}

async function defaultTextFetch(url: string): Promise<{ status: number; body: string } | null> {
  try {
    const response = await fetch(url, {
      redirect: "follow",
      signal: AbortSignal.timeout(PROBE_TIMEOUT_MS),
      headers: { "user-agent": "Mozilla/5.0 (compatible; manga-merge-bot)" },
    });
    if (!response.ok) return { status: response.status, body: "" };
    return { status: response.status, body: await response.text() };
  } catch {
    return null;
  }
}

/**
 * يتحقق أن عنصر Drive علني (يُرى من المتصفح بلا تسجيل دخول) ويعيد بياناته.
 * linkKind يأتي من رابط المستخدم نفسه (folders/… ← مجلد، file/d/… أو open?id= ← ملف).
 * يعيد null عندما لا يُرى العنصر علنًا — عندها المشكلة صلاحية مشاركة لا يعالجها الكود.
 */
export async function probePublicDriveItem(
  id: string,
  linkKind: "folder" | "file",
  textFetch: TextFetch = defaultTextFetch
): Promise<PublicDriveItem | null> {
  if (linkKind === "folder") {
    const page = await textFetch(`${FOLDER_VIEW_URL}${encodeURIComponent(id)}`);
    if (page?.status !== 200) return null;
    const parsed = parseEmbeddedFolderView(page.body);
    if (parsed.kind !== "folder") return null;
    return { kind: "folder", id, name: parsed.name ?? "مجلد Drive", files: parsed.files };
  }
  const page = await textFetch(`${FILE_VIEW_URL}${encodeURIComponent(id)}/view`);
  if (page?.status !== 200) return null;
  const name = parseDriveFilePageTitle(page.body);
  if (!name) return null;
  return { kind: "file", id, name };
}

function publicSizeCap(limit: number) {
  let bytes = 0;
  return new Transform({
    transform(chunk: Buffer, _encoding, callback) {
      bytes += chunk.length;
      if (bytes > limit) {
        callback(new Error(`ملف Drive يتجاوز الحد الآمن للحجم (${Math.round(limit / (1024 * 1024))}MB).`));
        return;
      }
      callback(null, chunk);
    },
  });
}

/**
 * ينزّل ملفًا من Drive علنيًا إلى القرص عبر بث مباشر (بلا تحميل في الذاكرة)
 * مع سقف حجم صريح. يرفض صفحات HTML (بوابة الفحص أو رفض الوصول) بدل حفظها.
 */
export async function downloadPublicDriveFile(
  fileId: string,
  targetPath: string,
  maxBytes: number
): Promise<void> {
  const url = `${DOWNLOAD_URL}${encodeURIComponent(fileId)}&export=download&confirm=t`;
  let response: Response;
  try {
    response = await fetch(url, { redirect: "follow", signal: AbortSignal.timeout(DOWNLOAD_TIMEOUT_MS) });
  } catch (error) {
    throw new GoogleDriveError(
      `تعذر تنزيل ملف Drive العام: ${error instanceof Error ? error.message : "خطأ غير معروف"}`
    );
  }
  if (!response.ok) {
    throw new GoogleDriveError(`تعذر تنزيل ملف من Drive العام (${response.status}).`);
  }
  const contentType = response.headers.get("content-type") ?? "";
  if (contentType.toLowerCase().includes("text/html")) {
    throw new GoogleDriveError(
      "رفض Google تنزيل الملف من الرابط العام — تأكد أن مشاركة الملف «أي شخص لديه الرابط»."
    );
  }
  if (!response.body) throw new GoogleDriveError("تعذر قراءة بيانات الملف من Drive العام.");
  await pipeline(
    Readable.fromWeb(response.body as never),
    publicSizeCap(maxBytes),
    createWriteStream(targetPath)
  );
}
