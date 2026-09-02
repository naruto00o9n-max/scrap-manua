import { createWriteStream } from "node:fs";
import { mkdir, mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { Readable, Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
import extract from "extract-zip";
import { getSetting } from "../db";
import {
  GoogleDriveClient,
  GoogleDriveError,
  type DriveSharingPolicy,
} from "./googleDrive";
import { openLocalImageMergeSession } from "./imageMerging";

// سقوف الأحمان: كل التنزيلات تُكتب على القرص عبر بث مباشر ولا تُحمَّل في الذاكرة،
// وبهذا يبقي ذروة الاستهلاك منخفضة كما في عامل الفصول (درس خطأ exit 137).
const MAX_IMAGE_BYTES = 60 * 1024 * 1024;
const MAX_ARCHIVE_BYTES = 250 * 1024 * 1024;
const IMAGE_EXTENSIONS = /\.(jpe?g|png|webp|gif|bmp|avif)$/i;
const ARCHIVE_EXTENSIONS = /\.(zip|cbz)$/i;
const DOWNLOAD_TIMEOUT_MS = 60_000;

/** يُرمى عند إيقاف الدمج من زر الإلغاء في Discord. */
export class ManualMergeCancelled extends Error {
  constructor() {
    super("أُلغي الدمج من Discord.");
    this.name = "ManualMergeCancelled";
  }
}

export type DriveLink =
  | { kind: "folder"; id: string }
  | { kind: "file"; id: string };

/**
 * يستخرج معرّف العنصر من رابط Google Drive:
 * مجلد /drive/folders/<id>، ملف /file/d/<id>/، أو open?id= وuc?id=.
 * يُعيد null لأي رابط آخر (ليس Drive أو غير آمن).
 */
export function parseDriveLink(raw: string): DriveLink | null {
  let url: URL;
  try {
    url = new URL(raw.trim());
  } catch {
    return null;
  }
  if (url.protocol !== "https:") return null;
  const host = url.hostname.toLowerCase();
  if (host !== "drive.google.com" && host !== "docs.google.com") return null;
  if (url.username || url.password) return null;

  const folderMatch = url.pathname.match(/\/drive\/(?:u\/\d+\/)?folders\/([-\w]{10,})/);
  if (folderMatch?.[1]) return { kind: "folder", id: folderMatch[1] };

  const fileMatch = url.pathname.match(/\/file\/d\/([-\w]{10,})/);
  if (fileMatch?.[1]) return { kind: "file", id: fileMatch[1] };

  const idParam = url.searchParams.get("id");
  if (idParam && /^[-\w]{10,}$/.test(idParam)) return { kind: "file", id: idParam };

  return null;
}

/** ترتيب طبيعي للأسماء: page2 قبل page10. */
export function naturalCompare(a: string, b: string): number {
  const collator = new Intl.Collator("en", { numeric: true, sensitivity: "base" });
  return collator.compare(a, b);
}

/** يجمع مسارات الصور من مجلد (بشكل تكراري) ويرتبها ترتيبًا طبيعيًا حسب المسار. */
export async function collectImageFiles(dir: string): Promise<string[]> {
  const entries = await readdir(dir, { recursive: true, withFileTypes: true });
  const paths: string[] = [];
  for (const entry of entries) {
    if (!entry.isFile()) continue;
    const full = path.join(entry.parentPath, entry.name);
    if (!IMAGE_EXTENSIONS.test(entry.name)) continue;
    paths.push(full);
  }
  return paths.sort((a, b) => naturalCompare(a, b));
}

function cappedStream(limit: number, label: string) {
  let bytes = 0;
  return new Transform({
    transform(chunk: Buffer, _encoding, callback) {
      bytes += chunk.length;
      if (bytes > limit) {
        callback(new Error(`${label} يتجاوز الحد الآمن للحجم (${Math.round(limit / (1024 * 1024))}MB).`));
        return;
      }
      callback(null, chunk);
    },
  });
}

/** ينزّل ملفًا من رابط https مباشر إلى القرص عبر بث (روابط مرفقات Discord). */
export async function downloadHttpsToPath(url: string, targetPath: string, maxBytes: number): Promise<void> {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new GoogleDriveError("رابط الملف غير صالح.");
  }
  if (parsed.protocol !== "https:" || parsed.username || parsed.password) {
    throw new GoogleDriveError("رابط الملف غير آمن.");
  }
  const response = await fetch(parsed, { redirect: "follow", signal: AbortSignal.timeout(DOWNLOAD_TIMEOUT_MS) });
  if (!response.ok) throw new GoogleDriveError(`تعذر تنزيل الملف المرفق (${response.status}).`);
  if (!response.body) throw new GoogleDriveError("تعذر قراءة بيانات الملف المرفق.");
  await pipeline(
    Readable.fromWeb(response.body as never),
    cappedStream(maxBytes, "الملف المرفق"),
    createWriteStream(targetPath)
  );
}

export type ManualMergeSource =
  | { kind: "zip"; zipPath: string; title: string }
  | { kind: "drive"; id: string };

export type ManualMergePhase = "fetch" | "merge" | "upload";

export type ManualMergeEvent = {
  phase: ManualMergePhase;
  done: number;
  total: number;
};

export type ManualMergeCancelToken = { cancelled: boolean };

export type ManualMergeHandlers = {
  onEvent?: (event: ManualMergeEvent) => Promise<void> | void;
  isCancelled?: () => boolean;
};

export type ManualMergeResult = {
  driveUrl: string;
  mergedCount: number;
  imageCount: number;
  title: string;
};

function assertNotCancelled(token?: ManualMergeCancelToken): void {
  if (token?.cancelled) throw new ManualMergeCancelled();
}

async function resolveSharing(): Promise<DriveSharingPolicy> {
  const mode = (await getSetting("google_drive_sharing_mode")) ?? "link_reader";
  const domain = await getSetting("google_drive_sharing_domain");
  if (mode === "private") return { mode: "private" };
  if (mode === "domain_reader" && domain) return { mode: "domain_reader", domain };
  return { mode: "link_reader" };
}

function titleFromName(name: string): string {
  const withoutExtension = name.replace(ARCHIVE_EXTENSIONS, "").trim();
  return withoutExtension || "دمج يدوي";
}

/**
 * خط الدمج اليدوي الكامل: يستقبل صورًا جاهزة (ملف ZIP/CBZ على القرص أو عنصر
 * Google Drive: مجلد صور أو ملف أرشيف)، يجهزها على القرص، يدمجها في صور طويلة
 * بنفس خوارزمية عامل الفصول (11000–14000px بلا قصّ)، ثم يرفع الناتج إلى
 * مجلد Drive جديد ويعيد رابطه. كل مراحل التنزيل والدمج والرفع تبلغ المستخدم
 * عبر onEvent، ويمكن إيقاف كل شيء في أي لحظة عبر isCancelled.
 */
export async function runManualMerge(
  source: ManualMergeSource,
  handlers: ManualMergeHandlers = {}
): Promise<ManualMergeResult> {
  const { onEvent, isCancelled } = handlers;
  const token: ManualMergeCancelToken = { cancelled: false };
  const checkCancelled = () => {
    if (token.cancelled || isCancelled?.()) throw new ManualMergeCancelled();
  };
  const emit = async (event: ManualMergeEvent) => {
    if (!onEvent) return;
    try {
      await onEvent(event);
    } catch {
      /* فشل الإشعار لا يُفشل المعالجة */
    }
  };

  const drive = new GoogleDriveClient();
  const workDir = await mkdtemp(path.join(tmpdir(), "manual-merge-"));
  try {
    let imagePaths: string[] = [];
    let title = "دمج يدوي";

    if (source.kind === "zip") {
      // أرشيف مرفق من Discord: فكّه على القرص ثم اجمع الصور.
      checkCancelled();
      title = titleFromName(source.title);
      const extractDir = path.join(workDir, "zip");
      await extract(source.zipPath, { dir: extractDir });
      checkCancelled();
      imagePaths = await collectImageFiles(extractDir);
      if (!imagePaths.length) {
        throw new GoogleDriveError(
          "لم يُعثر على صور داخل الأرشيف. تأكد أنه يحتوي ملفات JPG/PNG/WEBP مباشرة أو داخل مجلدات."
        );
      }
    } else {
      // عنصر Drive: مجلد صور أو ملف أرشيف ZIP/CBZ.
      checkCancelled();
      const meta = await drive.getFileMeta(source.id);
      const isFolder = meta.mimeType === "application/vnd.google-apps.folder";
      if (isFolder) {
        title = titleFromName(meta.name);
        const files = await drive.listFolderFiles(source.id);
        const images = files.filter(
          file =>
            file.mimeType.toLowerCase().startsWith("image/") ||
            IMAGE_EXTENSIONS.test(file.name)
        );
        if (!images.length) {
          throw new GoogleDriveError(
            "مجلد Drive لا يحتوي صورًا. ضع صور الفصل مباشرة داخل المجلد ثم أعد المحاولة."
          );
        }
        images.sort((a, b) => naturalCompare(a.name, b.name));
        const imagesDir = path.join(workDir, "images");
        await mkdir(imagesDir, { recursive: true });
        imagePaths = [];
        for (let index = 0; index < images.length; index += 1) {
          checkCancelled();
          const targetPath = path.join(imagesDir, `image-${String(index + 1).padStart(4, "0")}.img`);
          await drive.downloadFileToPath(images[index]!.id, targetPath, MAX_IMAGE_BYTES);
          imagePaths.push(targetPath);
          await emit({ phase: "fetch", done: index + 1, total: images.length });
        }
      } else {
        if (!ARCHIVE_EXTENSIONS.test(meta.name)) {
          throw new GoogleDriveError(
            "رابط Drive لا يشير إلى مجلد صور ولا إلى ملف ZIP/CBZ. أرسل رابط مجلد يحتوي الصور."
          );
        }
        title = titleFromName(meta.name);
        if (meta.size && meta.size > MAX_ARCHIVE_BYTES) {
          throw new GoogleDriveError(
            `حجم الأرشيف على Drive يتجاوز الحد الآمن (${Math.round(MAX_ARCHIVE_BYTES / (1024 * 1024))}MB).`
          );
        }
        checkCancelled();
        const zipPath = path.join(workDir, "source-archive.zip");
        await drive.downloadFileToPath(source.id, zipPath, MAX_ARCHIVE_BYTES);
        await emit({ phase: "fetch", done: 1, total: 1 });
        checkCancelled();
        const extractDir = path.join(workDir, "zip");
        await extract(zipPath, { dir: extractDir });
        checkCancelled();
        imagePaths = await collectImageFiles(extractDir);
        if (!imagePaths.length) {
          throw new GoogleDriveError(
            "لم يُعثر على صور داخل الأرشيف. تأكد أنه يحتوي ملفات JPG/PNG/WEBP مباشرة أو داخل مجلدات."
          );
        }
      }
    }

    checkCancelled();
    // الدمج بنفس خوارزمية الفصول: أكبر عرض، مجموعات 11000–14000px، بلا قصّ.
    const session = await openLocalImageMergeSession(imagePaths, async event => {
      await emit({ phase: "merge", done: event.done, total: event.total });
    });
    try {
      const mergedImages = session.images;
      if (!mergedImages.length) {
        throw new GoogleDriveError("تعذر دمج الصور في صور طويلة قابلة للرفع.");
      }

      checkCancelled();
      const now = new Date();
      const stamp = `${String(now.getFullYear()).padStart(4, "0")}-${String(now.getMonth() + 1).padStart(2, "0")}-${String(now.getDate()).padStart(2, "0")} ${String(now.getHours()).padStart(2, "0")}:${String(now.getMinutes()).padStart(2, "0")}`;
      const folder = await drive.createChapterFolder(
        title,
        `دمج ${stamp}`,
        await resolveSharing()
      );

      for (let offset = 0; offset < mergedImages.length; offset += 1) {
        checkCancelled();
        const mergedImage = mergedImages[offset]!;
        await drive.uploadMergedPageFile(mergedImage.filePath, folder.id, offset + 1);
        await emit({ phase: "upload", done: offset + 1, total: mergedImages.length });
      }

      return {
        driveUrl: folder.url,
        mergedCount: mergedImages.length,
        imageCount: imagePaths.length,
        title,
      };
    } finally {
      await session.cleanup();
    }
  } finally {
    await rm(workDir, { recursive: true, force: true });
  }
}

/** يفحص أن اسم ملف مرفق هو أرشيف مدعوم (ZIP أو CBZ). */
export function isSupportedArchiveName(name: string | null | undefined): boolean {
  return Boolean(name && ARCHIVE_EXTENSIONS.test(name));
}
