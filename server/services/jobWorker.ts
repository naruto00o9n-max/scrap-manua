import {
  addJobAttempt,
  getChapterJob,
  getNextPendingChapterJob,
  getSetting,
  getSourceById,
  markJobCompleted,
  markJobFailed,
  markJobStarted,
  markJobUploading,
  saveIntegrationHealth,
  setJobChapterDetails,
  updateJobUploadProgress,
} from "../db";
import type { ChapterJob } from "../../drizzle/schema";
import { ENV } from "../_core/env";
import { sendJobUpdate, sendOwnerAlert } from "./discordBot";
import { GoogleDriveClient, GoogleDriveError } from "./googleDrive";
import { getUsableSuwayomiToken } from "./settings";
import { SuwayomiClient } from "./suwayomi";
import { recordOwnerAlert } from "./alerts";

let isDraining = false;

function describeError(error: unknown) {
  return error instanceof Error ? error.message : "حدث خطأ غير معروف أثناء معالجة الطلب.";
}

async function processChapterJob(job: ChapterJob): Promise<void> {
  try {
    await markJobStarted(job.id);
    await addJobAttempt(job.id, "downloading", "بدأ التحقق من الفصل عبر Suwayomi.");
    const source = await getSourceById(job.sourceId);
    if (!source || source.status !== "active" || !source.allowDirectChapterLookup || !source.suwayomiSourceId) {
      throw new Error("المصدر لم يعد مفعّلًا أو غير مربوط بمصدر Suwayomi مصرح به.");
    }

    const suwayomi = new SuwayomiClient(ENV.suwayomiBaseUrl, getUsableSuwayomiToken());
    const installedSource = (await suwayomi.listInstalledSources()).find(item => item.id === source.suwayomiSourceId);
    if (!installedSource?.extension?.isInstalled) {
      throw new Error("إضافة Suwayomi المطابقة للمصدر غير مثبتة أو لم تعد متاحة.");
    }
    if (source.extensionPackage && installedSource.extension.pkgName !== source.extensionPackage) {
      throw new Error("حزمة إضافة Suwayomi المثبتة لا تطابق الحزمة المعتمدة للمصدر.");
    }
    if (source.extensionName && installedSource.extension.name !== source.extensionName) {
      throw new Error("اسم إضافة Suwayomi المثبتة لا يطابق الإضافة المعتمدة للمصدر.");
    }
    const chapter = await suwayomi.findChapterByUrl(job.canonicalUrl);
    if (!chapter) {
      throw new Error("لم يعثر Suwayomi على الفصل بهذا الرابط. تأكد من تثبيت الإضافة المصرح بها وأن الفصل معروف للخادم.");
    }
    if (chapter.manga.sourceId !== source.suwayomiSourceId) {
      throw new Error("الفصل الموجود في Suwayomi لا يطابق المصدر المصرح به لهذا النطاق.");
    }

    const fetched = await suwayomi.fetchChapterPages(chapter.id);
    if (!fetched.pages.length) throw new Error("لم يعد Suwayomi أي صفحات قابلة للرفع لهذا الفصل.");
    await setJobChapterDetails(job.id, {
      sourceChapterId: String(chapter.id),
      mangaTitle: fetched.chapter.manga.title,
      chapterTitle: fetched.chapter.name,
      totalPages: fetched.pages.length,
    });
    await addJobAttempt(job.id, "downloading", `استلم Suwayomi ${fetched.pages.length} صفحة من المصدر المصرح به.`);

    const rootFolderId = await getSetting("google_drive_root_folder_id");
    if (!rootFolderId) throw new GoogleDriveError("لم يُحدد مجلد Google Drive الجذر من لوحة الإدارة.");
    const drive = new GoogleDriveClient();
    const folder = await drive.createChapterFolder(rootFolderId, fetched.chapter.manga.title, fetched.chapter.name);
    await markJobUploading(job.id, folder.id, folder.url);
    await addJobAttempt(job.id, "uploading", "أُنشئ مجلد Google Drive وبدأ رفع الصور المرتبة.");

    for (let offset = 0; offset < fetched.pages.length; offset += 1) {
      const pageUrl = fetched.pages[offset];
      if (!pageUrl) continue;
      const latest = await getChapterJob(job.id);
      if (latest?.cancelRequested) {
        await addJobAttempt(job.id, "cancelled", "أُلغي الطلب قبل اكتمال رفع جميع الصفحات.");
        await sendJobUpdate(job.requestedInChannelId, job.requestedByDiscordId, "أُلغي طلب الفصل قبل اكتمال الرفع.");
        return;
      }
      const pageNumber = offset + 1;
      await drive.uploadPage(pageUrl, folder.id, pageNumber);
      await updateJobUploadProgress(job.id, pageNumber);
    }

    await markJobCompleted(job.id);
    await addJobAttempt(job.id, "completed", `اكتمل رفع ${fetched.pages.length} صفحة إلى Google Drive.`);
    await saveIntegrationHealth("job-worker", "healthy", "آخر مهمة اكتملت بنجاح.");
    await sendJobUpdate(job.requestedInChannelId, job.requestedByDiscordId, `اكتمل حفظ الفصل في Google Drive: ${folder.url}`);
  } catch (error) {
    const message = describeError(error);
    await markJobFailed(job.id, "PROCESSING_FAILED", message);
    await addJobAttempt(job.id, "failed", message);
    const health = await saveIntegrationHealth("job-worker", "degraded", message);
    await sendJobUpdate(job.requestedInChannelId, job.requestedByDiscordId, `فشلت معالجة الطلب: ${message}`);
    if (health.consecutiveFailures === 3) {
      await recordOwnerAlert("job-worker", "critical", `فشل عامل الفصول 3 مرات متتالية. آخر سبب: ${message}`);
    }
  }
}

/**
 * يستنزف الطلبات المتاحة في عملية واحدة. يُستدعى عند وصول أمر Discord وعند تشغيل البوت،
 * لذلك لا يعتمد على setInterval أو مهام داخلية لا تدوم في بيئات autoscale.
 */
export async function processPendingChapterJobs(): Promise<void> {
  if (isDraining) return;
  isDraining = true;
  try {
    let job = await getNextPendingChapterJob();
    while (job) {
      await processChapterJob(job);
      job = await getNextPendingChapterJob();
    }
  } finally {
    isDraining = false;
  }
}

export function startJobWorker(): void {
  void processPendingChapterJobs();
}
