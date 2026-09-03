import {
  addJobAttempt,
  getChapterJob,
  getNextPendingChapterJob,
  getSetting,
  getSourceById,
  getStaleInFlightChapterJobs,
  markJobCompleted,
  markJobFailed,
  markJobStarted,
  markJobUploading,
  saveIntegrationHealth,
  setJobChapterDetails,
  updateJobUploadProgress,
} from "../db";
import type { ChapterJob } from "../../shared/dbTypes";
import { ENV } from "../_core/env";
import {
  noticeFromJob,
  sendJobUpdate,
  updateJobProgressMessage,
  type JobNotice,
  type JobStage,
} from "./discordBot";
import {
  GoogleDriveClient,
  GoogleDriveError,
  mangaFolderTitle,
  sharingPolicyFromMode,
} from "./googleDrive";
import { getUsableSuwayomiToken } from "./settings";
import { SuwayomiClient, type SuwayomiChapter } from "./suwayomi";
import { openChapterMergeSession } from "./imageMerging";
import { recordOwnerAlert } from "./alerts";

let isDraining = false;

function describeError(error: unknown) {
  return error instanceof Error
    ? error.message
    : "حدث خطأ غير معروف أثناء معالجة الطلب.";
}

/**
 * يحدّث بطاقة المتابعة في Discord في كل خطوة. التحديث مخنوق (كل 2.5 ثانية)
 * احترامًا لحدود معدل Discord، مع إجبار التحديث عند نهاية كل مرحلة أو تغيّرها.
 */
function createProgressPoster(
  channelId: string | null,
  messageId: string | null
) {
  let lastKey = "";
  let lastAt = 0;
  return async (notice: JobNotice, force = false) => {
    if (!channelId || !messageId) return;
    const key = `${notice.status}|${notice.stage ?? ""}|${notice.progress ? `${notice.progress.done}/${notice.progress.total}` : ""}`;
    const isPhaseEnd = notice.progress
      ? notice.progress.done >= notice.progress.total
      : false;
    const nowMs = Date.now();
    if (!force && !isPhaseEnd && (key === lastKey || nowMs - lastAt < 2500))
      return;
    lastKey = key;
    lastAt = nowMs;
    try {
      await updateJobProgressMessage(channelId, messageId, notice);
    } catch {
      /* فشل تحديث البطاقة لا يُفشل معالجة الفصل */
    }
  };
}

async function processChapterJob(job: ChapterJob): Promise<void> {
  // حالة المسار الحية لهذا الطلب؛ تُغذّي بطاقة Discord في كل تحديث.
  let stage: JobStage = "validate";
  let label: string | null = null;
  let pageCount: number | undefined;
  let mergedCount: number | undefined;
  try {
    await markJobStarted(job.id);
    const live = await getChapterJob(job.id);
    const post = createProgressPoster(
      job.requestedInChannelId,
      live?.discordProgressMessageId ?? null
    );
    const base = () => ({
      jobId: job.id,
      stage,
      label,
      pageCount,
      mergedCount,
    });
    await addJobAttempt(
      job.id,
      "downloading",
      "بدأ التحقق من الفصل عبر Suwayomi."
    );
    await post({ ...base(), status: "downloading" }, true);
    const source = await getSourceById(job.sourceId);
    if (
      !source ||
      source.status !== "active" ||
      !source.allowDirectChapterLookup ||
      !source.suwayomiSourceId
    ) {
      throw new Error(
        "المصدر لم يعد مفعّلًا أو غير مربوط بمصدر Suwayomi مصرح به."
      );
    }

    const suwayomi = new SuwayomiClient(
      ENV.suwayomiBaseUrl,
      getUsableSuwayomiToken()
    );
    const installedSource = (await suwayomi.listInstalledSources()).find(
      item => item.id === source.suwayomiSourceId
    );
    if (!installedSource?.extension?.isInstalled) {
      throw new Error(
        "إضافة Suwayomi المطابقة للمصدر غير مثبتة أو لم تعد متاحة."
      );
    }
    if (
      source.extensionPackage &&
      installedSource.extension.pkgName !== source.extensionPackage
    ) {
      throw new Error(
        "حزمة إضافة Suwayomi المثبتة لا تطابق الحزمة المعتمدة للمصدر."
      );
    }
    if (
      source.extensionName &&
      installedSource.extension.name !== source.extensionName
    ) {
      throw new Error(
        "اسم إضافة Suwayomi المثبتة لا يطابق الإضافة المعتمدة للمصدر."
      );
    }
    stage = "chapter";
    await post({ ...base(), status: "downloading" }, true);
    // Live source refreshes (webtoons.com, Naver, ...) occasionally return an
    // empty chapter list or briefly fail. Retry resolution with a short
    // backoff before declaring the job failed.
    let chapter: SuwayomiChapter | null = null;
    const resolutionAttempts = 3;
    let lastResolutionError: unknown = null;
    for (let attempt = 1; attempt <= resolutionAttempts; attempt++) {
      try {
        chapter = await suwayomi.findOrFetchChapterFromSource(
          source.suwayomiSourceId,
          job.canonicalUrl
        );
        if (chapter) break;
      } catch (error) {
        // الأخطاء الحية (اتصال/إضافة/بحث) تُحفظ لإظهار السبب الحقيقي في البطاقة
        // بدل رسالة عامة، والمحاولة التالية تعيد المحاولة طالما لم تنهِ المحاولات.
        lastResolutionError = error;
        chapter = null;
      }
      if (attempt < resolutionAttempts) {
        await addJobAttempt(
          job.id,
          "downloading",
          `لم يُعثر على الفصل في المحاولة ${attempt}، تتم إعادة المحاولة بعد مهلة.`
        );
        await new Promise(resolve =>
          setTimeout(resolve, attempt === 1 ? 5_000 : 15_000)
        );
      }
    }
    if (!chapter) {
      throw lastResolutionError instanceof Error && lastResolutionError.message
        ? lastResolutionError
        : new Error(
            "لم يعثر Suwayomi على الفصل بهذا الرابط. تأكد من تثبيت الإضافة المصرح بها وأن الفصل معروف للخادم."
          );
    }
    if (chapter.manga.sourceId !== source.suwayomiSourceId) {
      throw new Error(
        "الفصل الموجود في Suwayomi لا يطابق المصدر المصرح به لهذا النطاق."
      );
    }

    const fetched = await suwayomi.fetchChapterPages(chapter.id);
    if (!fetched.pages.length)
      throw new Error("لم يعد Suwayomi أي صفحات قابلة للرفع لهذا الفصل.");
    pageCount = fetched.pages.length;
    label = `**${fetched.chapter.manga.title}** — ${fetched.chapter.name}`;
    stage = "download";
    await post({ ...base(), status: "downloading" }, true);
    // تُنزّل الصفحات وتُدمج عبر ملفات مؤقتة على القرص بدل الذاكرة؛ ذلك يمنع
    // قتل العملية بسبب نفاد الذاكرة (exit 137) في الفصول الطويلة.
    const mergeSession = await openChapterMergeSession(
      fetched.pages,
      async event => {
        if (event.phase === "downloading") {
          await post({
            ...base(),
            status: "downloading",
            progress: { done: event.done, total: event.total },
          });
        } else {
          stage = "merge";
          await post({
            ...base(),
            status: "downloading",
            progress: { done: event.done, total: event.total },
          });
        }
      }
    );
    try {
      const mergedImages = mergeSession.images;
      if (!mergedImages.length)
        throw new Error("تعذر دمج صفحات الفصل في صور قابلة للرفع.");
      mergedCount = mergedImages.length;
      await setJobChapterDetails(job.id, {
        sourceChapterId: String(chapter.id),
        mangaTitle: fetched.chapter.manga.title,
        chapterTitle: fetched.chapter.name,
        totalPages: mergedImages.length,
      });
      await addJobAttempt(
        job.id,
        "downloading",
        `استلم Suwayomi ${fetched.pages.length} صفحة ودمجها في ${mergedImages.length} صور طويلة غير خسارية.`
      );

      const drive = new GoogleDriveClient();
      const sharing = sharingPolicyFromMode(
        await getSetting("google_drive_sharing_mode"),
        await getSetting("google_drive_sharing_domain")
      );
      const folder = await drive.createChapterFolder(
        // نطاق المصدر يُضاف لاسم العمل حتى لا يشارك مصدران مختلفان نفس المجلد
        // إذا تطابق اسم العمل واسم الفصل بينهما.
        mangaFolderTitle(fetched.chapter.manga.title, job.canonicalUrl),
        fetched.chapter.name,
        sharing
      );
      await markJobUploading(job.id, folder.id, folder.url);
      await addJobAttempt(
        job.id,
        "uploading",
        "أُنشئ مجلد Google Drive وبدأ رفع الصور المرتبة."
      );
      stage = "upload";
      await post(
        {
          ...base(),
          status: "uploading",
          progress: { done: 0, total: mergedCount },
        },
        true
      );

      for (let offset = 0; offset < mergedImages.length; offset += 1) {
        const mergedImage = mergedImages[offset];
        if (!mergedImage) continue;
        const latest = await getChapterJob(job.id);
        if (latest?.cancelRequested) {
          await addJobAttempt(
            job.id,
            "cancelled",
            "أُلغي الطلب قبل اكتمال رفع جميع الصفحات."
          );
          await sendJobUpdate(
            job.requestedInChannelId,
            job.requestedByDiscordId,
            {
              ...base(),
              status: "cancelled",
              detail: "أوقفتَ هذه العملية قبل اكتمال الرفع.",
            }
          );
          return;
        }
        const pageNumber = offset + 1;
        await drive.uploadMergedPageFile(
          mergedImage.filePath,
          folder.id,
          pageNumber
        );
        await updateJobUploadProgress(job.id, pageNumber);
        await post({
          ...base(),
          status: "uploading",
          progress: { done: pageNumber, total: mergedCount },
        });
      }

      await markJobCompleted(job.id);
      await addJobAttempt(
        job.id,
        "completed",
        `اكتمل رفع ${mergedCount} صورة طويلة مدمجة إلى Google Drive.`
      );
      await saveIntegrationHealth(
        "job-worker",
        "healthy",
        "آخر مهمة اكتملت بنجاح."
      );
      await sendJobUpdate(job.requestedInChannelId, job.requestedByDiscordId, {
        ...base(),
        status: "completed",
        driveUrl: folder.url,
      });
    } finally {
      await mergeSession.cleanup();
    }
  } catch (error) {
    const message = describeError(error);
    await markJobFailed(job.id, "PROCESSING_FAILED", message);
    await addJobAttempt(job.id, "failed", message);
    const health = await saveIntegrationHealth(
      "job-worker",
      "degraded",
      message
    );
    await sendJobUpdate(job.requestedInChannelId, job.requestedByDiscordId, {
      jobId: job.id,
      status: "failed",
      stage,
      label,
      pageCount,
      mergedCount,
      detail: message,
    });
    if (health.consecutiveFailures === 3) {
      await recordOwnerAlert(
        "job-worker",
        "critical",
        `فشل عامل الفصول 3 مرات متتالية. آخر سبب: ${message}`
      );
    }
  }
}

/**
 * يُغلق الطلبات التي كانت قيد المعالجة وتوقفت تحديثاتها لأكثر من 15 دقيقة،
 * مثلما يحدث عند قتل العملية (نفاد الذاكرة) أو إعادة تشغيل الخدمة، ثم يُشعر
 * صاحب الطلب في Discord بدل تركه ينتظر بلا نتيجة ولا رسالة.
 */
async function failStaleInFlightJobs(): Promise<void> {
  const staleJobs = await getStaleInFlightChapterJobs();
  for (const job of staleJobs) {
    const message =
      "توقفت المعالجة فجأة (إعادة تشغيل الخدمة أو نفاد الذاكرة). أعد إرسال الرابط بأمر /فصل وسيبدأ التجهيز من جديد.";
    try {
      await markJobFailed(job.id, "WORKER_INTERRUPTED", message);
      await addJobAttempt(job.id, "failed", message);
      await saveIntegrationHealth("job-worker", "degraded", message);
      await sendJobUpdate(
        job.requestedInChannelId,
        job.requestedByDiscordId,
        noticeFromJob(job)
      );
    } catch (error) {
      console.error("[JobWorker] تعذر إغلاق طلب معلق قديم:", error);
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
  void (async () => {
    try {
      await failStaleInFlightJobs();
    } catch (error) {
      console.error("[JobWorker] تعذر فحص الطلبات المعلقة القديمة:", error);
    }
    await processPendingChapterJobs();
  })();
}
