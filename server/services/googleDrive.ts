import { createReadStream, createWriteStream } from "node:fs";
import { stat } from "node:fs/promises";
import { Readable, Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
import { isIP } from "node:net";
import { google } from "googleapis";
import { ENV } from "../_core/env";

const FOLDER_MIME_TYPE = "application/vnd.google-apps.folder";
const MAX_PAGE_SIZE_BYTES = 40 * 1024 * 1024;
// الصورة المدمجة تُولَّد داخليًا وقد يتجاوز طول 14000px حد الصفحة الواحدة،
// لذلك لها سقف أعلى من سقف صفحات المصدر.
const MAX_MERGED_IMAGE_BYTES = 120 * 1024 * 1024;
const PLATFORM_FOLDER_NAME = "Manga Drive Discord Bot";

export type DriveSharingPolicy =
  | { mode: "private" }
  | { mode: "link_reader" }
  | { mode: "domain_reader"; domain: string };

export class GoogleDriveError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "GoogleDriveError";
  }
}

function escapeDriveQuery(value: string) {
  return value.replace(/\\/g, "\\\\").replace(/'/g, "\\'");
}

function safeFolderName(value: string, fallback: string) {
  const cleaned = value.replace(/[\\/:*?"<>|\u0000-\u001F]/g, " ").replace(/\s+/g, " ").trim();
  return (cleaned || fallback).slice(0, 120);
}

/**
 * يضيف نطاق مصدر الفصل (من الرابط نفسه) إلى اسم مجلد العمل في Drive.
 * سبب ذلك: كانت المجلدات تُطابق بالاسم فقط، فإذا سُحب نفس العمل ونفس الفصل
 * من مصدرين مختلفين وجدا نفس المجلد، ثم كانت ملفات الصور تُسمى 001.png…
 * فكانت ملفات السحبة الثانية تُتجاهل بصمت عند تصادم الأسماء.
 * بس suffix النطاق يصبح لكل مصدر مجلده المستقل، وإعادة سحب نفس الفصل
 * من نفس المصدر تعيد استخدام نفس المجلد كالمعتاد (استكمال الرفع بدل التكرار).
 */
export function mangaFolderTitle(mangaTitle: string, chapterUrl: string | null | undefined): string {
  let host = "";
  try {
    host = chapterUrl ? new URL(chapterUrl).hostname.toLowerCase().replace(/^www\./, "") : "";
  } catch {
    host = "";
  }
  if (!host || mangaTitle.includes(`[${host}]`)) return mangaTitle;
  return `${mangaTitle} [${host}]`;
}

function mediaExtension(contentType: string | null): string {
  const normalized = contentType?.split(";", 1)[0].toLowerCase();
  const map: Record<string, string> = { "image/jpeg": "jpg", "image/png": "png", "image/webp": "webp", "image/gif": "gif", "image/avif": "avif" };
  return map[normalized ?? ""] ?? "jpg";
}

export function buildPageFilename(pageIndex: number, contentType: string | null): string {
  if (!Number.isInteger(pageIndex) || pageIndex < 1) throw new GoogleDriveError("رقم الصفحة غير صالح.");
  return `${String(pageIndex).padStart(3, "0")}.${mediaExtension(contentType)}`;
}

function assertSafePageUrl(rawUrl: string): URL {
  let url: URL;
  try { url = new URL(rawUrl); } catch { throw new GoogleDriveError("أعاد Suwayomi رابط صفحة غير صالح."); }
  const host = url.hostname.toLowerCase();
  if (url.protocol !== "https:" || url.username || url.password || host === "localhost" || isIP(host) !== 0 || host.endsWith(".local") || host.endsWith(".internal")) {
    throw new GoogleDriveError("رفض النظام رابط صفحة غير آمن من المصدر.");
  }
  return url;
}

function countBytes(limit: number) {
  let count = 0;
  return new Transform({
    transform(chunk, _encoding, callback) {
      count += chunk.length;
      if (count > limit) callback(new GoogleDriveError("حجم صفحة الصورة أكبر من الحد الآمن."));
      else callback(null, chunk);
    },
  });
}

export class GoogleDriveClient {
  private readonly drive;

  constructor() {
    if (!ENV.googleDriveClientId || !ENV.googleDriveClientSecret || !ENV.googleDriveRefreshToken) {
      throw new GoogleDriveError("لم تُكمل أسرار Google Drive المطلوبة.");
    }
    const auth = new google.auth.OAuth2(ENV.googleDriveClientId, ENV.googleDriveClientSecret);
    auth.setCredentials({ refresh_token: ENV.googleDriveRefreshToken });
    this.drive = google.drive({ version: "v3", auth });
  }

  async healthcheck(): Promise<void> {
    await this.drive.files.list({ pageSize: 1, fields: "files(id)" });
  }


  async ensureFolder(parentId: string, requestedName: string): Promise<{ id: string; name: string }> {
    const name = safeFolderName(requestedName, "فصل بلا عنوان");
    const query = [
      `'${escapeDriveQuery(parentId)}' in parents`,
      `name = '${escapeDriveQuery(name)}'`,
      `mimeType = '${FOLDER_MIME_TYPE}'`,
      "trashed = false",
    ].join(" and ");
    const existing = await this.drive.files.list({ q: query, fields: "files(id,name)", pageSize: 1 });
    if (existing.data.files?.[0]?.id) return { id: existing.data.files[0].id, name: existing.data.files[0].name ?? name };

    const created = await this.drive.files.create({
      requestBody: { name, mimeType: FOLDER_MIME_TYPE, parents: [parentId] },
      fields: "id,name",
    });
    if (!created.data.id) throw new GoogleDriveError("تعذر إنشاء مجلد في Google Drive.");
    return { id: created.data.id, name: created.data.name ?? name };
  }

  private async applyFolderSharing(folderId: string, policy: DriveSharingPolicy): Promise<void> {
    if (policy.mode === "private") return;
    try {
      await this.drive.permissions.create({
        fileId: folderId,
        requestBody: policy.mode === "domain_reader"
          ? { type: "domain", role: "reader", domain: policy.domain }
          : { type: "anyone", role: "reader" },
        fields: "id",
      });
    } catch (error) {
      throw new GoogleDriveError(`تعذر ضبط مشاركة رابط المجلد للقراءة. تحقق من سياسة Google Drive: ${error instanceof Error ? error.message : "خطأ غير معروف"}`);
    }
  }

  async createChapterFolder(mangaTitle: string, chapterTitle: string, sharing: DriveSharingPolicy = { mode: "link_reader" }) {
    const platformFolder = await this.ensureFolder("root", PLATFORM_FOLDER_NAME);
    const mangaFolder = await this.ensureFolder(platformFolder.id, mangaTitle);
    const chapterFolder = await this.ensureFolder(mangaFolder.id, chapterTitle);
    await this.applyFolderSharing(chapterFolder.id, sharing);
    return { id: chapterFolder.id, url: `https://drive.google.com/drive/folders/${chapterFolder.id}` };
  }

  async uploadMergedPage(data: Buffer, folderId: string, imageIndex: number): Promise<void> {
    if (!data.length || data.length > MAX_PAGE_SIZE_BYTES) throw new GoogleDriveError("حجم الصورة المدمجة غير صالح.");
    const filename = buildPageFilename(imageIndex, "image/png");
    const existing = await this.drive.files.list({
      q: `'${escapeDriveQuery(folderId)}' in parents and name = '${escapeDriveQuery(filename)}' and trashed = false`,
      fields: "files(id)",
      pageSize: 1,
    });
    if (existing.data.files?.[0]?.id) return;
    await this.drive.files.create({
      requestBody: { name: filename, parents: [folderId] },
      media: { mimeType: "image/png", body: Readable.from(data) },
      fields: "id",
    });
  }

  /** يرفع صورة مدمجة من ملف مؤقت على القرص عبر تدفق مباشر دون تحميلها في الذاكرة. */
  async uploadMergedPageFile(filePath: string, folderId: string, imageIndex: number): Promise<void> {
    const stats = await stat(filePath);
    if (!stats.size || stats.size > MAX_MERGED_IMAGE_BYTES) throw new GoogleDriveError("حجم الصورة المدمجة غير صالح.");
    const filename = buildPageFilename(imageIndex, "image/png");
    const existing = await this.drive.files.list({
      q: `'${escapeDriveQuery(folderId)}' in parents and name = '${escapeDriveQuery(filename)}' and trashed = false`,
      fields: "files(id)",
      pageSize: 1,
    });
    if (existing.data.files?.[0]?.id) return;
    await this.drive.files.create({
      requestBody: { name: filename, parents: [folderId] },
      media: { mimeType: "image/png", body: createReadStream(filePath) },
      fields: "id",
    });
  }

  async uploadPage(pageUrl: string, folderId: string, pageIndex: number): Promise<void> {
    const url = assertSafePageUrl(pageUrl);
    const response = await fetch(url, { redirect: "error", signal: AbortSignal.timeout(45_000) });
    if (!response.ok) throw new GoogleDriveError(`تعذر تنزيل الصفحة ${pageIndex} (${response.status}).`);
    const contentType = response.headers.get("content-type");
    if (!contentType?.toLowerCase().startsWith("image/")) throw new GoogleDriveError(`الصفحة ${pageIndex} ليست ملف صورة صالحًا.`);
    const contentLength = Number(response.headers.get("content-length") ?? "0");
    if (Number.isFinite(contentLength) && contentLength > MAX_PAGE_SIZE_BYTES) throw new GoogleDriveError(`الصفحة ${pageIndex} تتجاوز الحد الآمن للحجم.`);
    if (!response.body) throw new GoogleDriveError(`تعذر قراءة بيانات الصفحة ${pageIndex}.`);

    const stream = Readable.fromWeb(response.body as never).pipe(countBytes(MAX_PAGE_SIZE_BYTES));
    const filename = buildPageFilename(pageIndex, contentType);
    const existing = await this.drive.files.list({
      q: `'${escapeDriveQuery(folderId)}' in parents and name = '${escapeDriveQuery(filename)}' and trashed = false`,
      fields: "files(id)",
      pageSize: 1,
    });
    if (existing.data.files?.[0]?.id) return;
    await this.drive.files.create({
      requestBody: { name: filename, parents: [folderId] },
      media: { mimeType: contentType, body: stream },
      fields: "id",
    });
  }

  /** يقرأ بيانات ملف أو مجلد Drive بالمعرّف (الاسم والنوع والحجم). */
  async getFileMeta(fileId: string): Promise<{ id: string; name: string; mimeType: string; size: number | null }> {
    try {
      const meta = await this.drive.files.get({
        fileId,
        fields: "id,name,mimeType,size",
        supportsAllDrives: true,
      });
      return {
        id: meta.data.id ?? fileId,
        name: meta.data.name ?? "ملف",
        mimeType: meta.data.mimeType ?? "",
        size: meta.data.size ? Number(meta.data.size) : null,
      };
    } catch (error) {
      const status = (error as { code?: number; response?: { status?: number } })?.response?.status
        ?? (error as { code?: number }).code;
      if (status === 404 || status === 403) {
        throw new GoogleDriveError(
          "تعذر الوصول إلى الملف أو المجلد على Google Drive. تأكد أن الرابط صحيح وأن المشاركة مضبوطة على «أي شخص لديه الرابط»."
        );
      }
      throw new GoogleDriveError(`تعذر قراءة بيانات العنصر من Google Drive: ${error instanceof Error ? error.message : "خطأ غير معروف"}`);
    }
  }

  /** يسرد ملفات مجلد Drive (غير المحذوفة وبلا مجلدات فرعية) مع ترقيم صفحات كامل. */
  async listFolderFiles(folderId: string): Promise<Array<{ id: string; name: string; mimeType: string; size: number | null }>> {
    const files: Array<{ id: string; name: string; mimeType: string; size: number | null }> = [];
    let pageToken: string | undefined;
    try {
      do {
        const page = await this.drive.files.list({
          q: `'${escapeDriveQuery(folderId)}' in parents and trashed = false and mimeType != '${FOLDER_MIME_TYPE}'`,
          fields: "nextPageToken,files(id,name,mimeType,size)",
          pageSize: 1000,
          pageToken,
          supportsAllDrives: true,
          includeItemsFromAllDrives: true,
        });
        for (const file of page.data.files ?? []) {
          if (!file.id) continue;
          files.push({
            id: file.id,
            name: file.name ?? "ملف",
            mimeType: file.mimeType ?? "",
            size: file.size ? Number(file.size) : null,
          });
        }
        pageToken = page.data.nextPageToken ?? undefined;
      } while (pageToken);
    } catch (error) {
      const status = (error as { code?: number; response?: { status?: number } })?.response?.status
        ?? (error as { code?: number }).code;
      if (status === 404 || status === 403) {
        throw new GoogleDriveError(
          "تعذر الوصول إلى المجلد على Google Drive. تأكد أن الرابط صحيح وأن مشاركة المجلد مضبوطة على «أي شخص لديه الرابط»."
        );
      }
      throw new GoogleDriveError(`تعذر قراءة محتويات المجلد من Google Drive: ${error instanceof Error ? error.message : "خطأ غير معروف"}`);
    }
    return files;
  }

  /**
   * ينزّل ملفًا من Drive إلى ملف على القرص عبر بث مباشر دون تحميله في الذاكرة،
   * مع سقف حجم صريح لكل ملف.
   */
  async downloadFileToPath(fileId: string, targetPath: string, maxBytes: number): Promise<void> {
    let responseStream: Readable;
    try {
      const response = await this.drive.files.get(
        { fileId, alt: "media", supportsAllDrives: true },
        { responseType: "stream" }
      );
      responseStream = response.data as Readable;
    } catch (error) {
      const status = (error as { code?: number; response?: { status?: number } })?.response?.status
        ?? (error as { code?: number }).code;
      if (status === 404 || status === 403) {
        throw new GoogleDriveError(
          "تعذر تنزيل الملف من Google Drive. تأكد أن المشاركة مضبوطة على «أي شخص لديه الرابط»."
        );
      }
      throw new GoogleDriveError(`تعذر تنزيل الملف من Google Drive: ${error instanceof Error ? error.message : "خطأ غير معروف"}`);
    }
    await pipeline(
      responseStream,
      countBytes(maxBytes),
      createWriteStream(targetPath)
    );
  }
}
