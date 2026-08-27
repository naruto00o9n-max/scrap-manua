import { Readable, Transform } from "node:stream";
import { isIP } from "node:net";
import { google } from "googleapis";
import { ENV } from "../_core/env";

const FOLDER_MIME_TYPE = "application/vnd.google-apps.folder";
const MAX_PAGE_SIZE_BYTES = 40 * 1024 * 1024;

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

  async verifyRootFolder(folderId: string): Promise<{ id: string; name: string }> {
    const response = await this.drive.files.get({ fileId: folderId, fields: "id,name,mimeType,trashed" });
    if (!response.data.id || response.data.mimeType !== FOLDER_MIME_TYPE || response.data.trashed) {
      throw new GoogleDriveError("معرف Google Drive لا يشير إلى مجلد متاح.");
    }
    return { id: response.data.id, name: response.data.name ?? "مجلد بلا اسم" };
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

  async createChapterFolder(rootFolderId: string, mangaTitle: string, chapterTitle: string) {
    await this.verifyRootFolder(rootFolderId);
    const mangaFolder = await this.ensureFolder(rootFolderId, mangaTitle);
    const chapterFolder = await this.ensureFolder(mangaFolder.id, chapterTitle);
    return { id: chapterFolder.id, url: `https://drive.google.com/drive/folders/${chapterFolder.id}` };
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
    await this.drive.files.create({
      requestBody: { name: filename, parents: [folderId] },
      media: { mimeType: contentType, body: stream },
      fields: "id",
    });
  }
}
