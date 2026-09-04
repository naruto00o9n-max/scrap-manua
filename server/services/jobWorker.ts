import {
  addJobAttempt,
  getChapterJob,
  getEffectiveImageOutputConfig,
  getGuildChapterMergeConfig,
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
import type { ChapterJob, ContentSource } from "../../shared/dbTypes";
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
import {
  DirectSourceError,
  directSourceMode,
  fetchDirectChapterWithSession,
  getDirectSessionCookie,
  probeDirectChapterPage,
  type DirectProbe,
} from "./directSource";
import { SuwayomiClient, type SuwayomiChapter } from "./suwayomi";
import {
  imageOutputDescription,
  openChapterMergeSession,
  openChapterPagesSession,
  resolveMergeDimensions,
  type MergeProgressListener,
} from "./imageMerging";
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

/** الفصل بعد إيجاده بالكامل: بيانات العرض وقائمة الصفحات — من أي مسار. */
type ResolvedChapter = {
  mangaTitle: string;
  chapterName: string;
  pages: string[];
  sourceChapterId: string;
};

/**
 * المسار المعتاد: إيجاد الفصل وجلب صفحاته عبر خادم السحب والإضافة المثبتة.
 * محاولات العثور على الفصل ثلاث مع فترات انتظار، وآخر سبب حقيقي يُحفظ لبطاقة
 * الفشل بدل رسالة عامة.
 */
async function resolveChapterViaSuwayomi(
  job: ChapterJob,
  source: ContentSource,
  hooks: {
    onRetry: (attempt: number) => Promise<void>;
    onFinalFailure: () => Promise<void>;
  }
): Promise<ResolvedChapter> {
  if (!source.suwayomiSourceId) {
    throw new Error("المصدر لم يعد مفعّلًا أو غير مربوط بمصدر مصرح به.");
  }
  const suwayomi = new SuwayomiClient(
    ENV.suwayomiBaseUrl,
    getUsableSuwayomiToken()
  );
  const installedSource = (await suwayomi.listInstalledSources()).find(
    item => item.id === source.suwayomiSourceId
  );
  if (!installedSource?.extension?.isInstalled) {
    throw new Error("الإضافة المطابقة للمصدر غير مثبتة أو لم تعد متاحة.");
  }
  if (
    source.extensionPackage &&
    installedSource.extension.pkgName !== source.extensionPackage
  ) {
    throw new Error(
      "حزمة الإضافة المثبتة لا تطابق الحزمة المعتمدة للمصدر."
    );
  }
  if (
    source.extensionName &&
    installedSource.extension.name !== source.extensionName
  ) {
    throw new Error(
      "اسم الإضافة المثبتة لا يطابق الإضافة المعتمدة للمصدر."
    );
  }
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
      await hooks.onRetry(attempt);
      await new Promise(resolve =>
        setTimeout(resolve, attempt === 1 ? 5_000 : 15_000)
      );
    }
  }
  if (!chapter) {
    // فرصة أخيرة لسبب أوضح: الموقع المدعوم بالسحب المباشر قد يكون فصله
    // مقفلًا (مدفوعًا) — وهذا وحده يفسر غيابه عن فصول الخادم المفهرسة.
    await hooks.onFinalFailure();
    throw lastResolutionError instanceof Error && lastResolutionError.message
      ? lastResolutionError
      : new Error(
          "لم أعثر على الفصل بهذا الرابط في المصادر المفعلة. تأكد من تثبيت الإضافة المصرح بها وأن الفصل معروف للخادم."
        );
  }
  if (chapter.manga.sourceId !== source.suwayomiSourceId) {
    throw new Error(
      "الفصل الموجود لا يطابق المصدر المصرح به لهذا النطاق."
    );
  }
  const fetched = await suwayomi.fetchChapterPages(chapter.id);
  if (!fetched.pages.length)
    throw new Error("لم تُعثر على أي صفحات قابلة للرفع لهذا الفصل.");
  return {
    mangaTitle: fetched.chapter.manga.title,
    chapterName: fetched.chapter.name,
    pages: fetched.pages,
    sourceChapterId: String(chapter.id),
  };
}

/** نوعا بطاقة المتابعة كما تستخدمه processChapterJob — لتمريرهما للمسارات الفرعية. */
type ProgressBase = () => Omit<JobNotice, "status">;
type ProgressPost = (notice: JobNotice, force?: boolean) => Promise<void>;

/** يحوّل نتيجة الفحص المباشر إلى فصل مكتمل — أو null حين لا تحمل صورًا. */
function chapterFromProbe(probe: DirectProbe, fallbackId: string): ResolvedChapter | null {
  if (probe.mode !== "free" || !probe.chapter?.pages.length) return null;
  return {
    mangaTitle: probe.chapter.mangaTitle,
    chapterName: probe.chapter.chapterName,
    pages: probe.chapter.pages,
    sourceChapterId: fallbackId,
  };
}

/**
 * المسار المباشر الأساسي (شونين جامب+): فحص واحد يكفي للمجاني — صوره تُعاد
 * فورًا. المقفل يحتاج جلسة موثقة وإلا رُفض برسالة توضح السبب والخطوة المطلوبة.
 * الفحص غير المحسوم يُعاد مرة واحدة قبل الاستسلام برسالة واضحة.
 */
async function resolveViaDirectFirst(
  job: ChapterJob,
  base: ProgressBase,
  post: ProgressPost
): Promise<ResolvedChapter | null> {
  const attemptProbe = async (): Promise<DirectProbe> => probeDirectChapterPage(job.canonicalUrl);
  let probe = await attemptProbe();
  if (probe.mode === "unknown") {
    await new Promise(resolve => setTimeout(resolve, 4_000));
    probe = await attemptProbe();
  }
  const free = chapterFromProbe(probe, job.canonicalUrl);
  if (free) {
    await addJobAttempt(
      job.id,
      "downloading",
      `فُتح الفصل من الموقع مباشرة — ${free.pages.length} صفحة.`
    );
    await post({ ...base(), status: "downloading" }, true);
    return free;
  }
  if (probe.mode === "locked") {
    const cookie = await getDirectSessionCookie(
      new URL(job.canonicalUrl).hostname
    );
    if (!cookie) {
      throw new DirectSourceError(
        "هذا الفصل مدفوع في الموقع (يتطلب شراء أو اشتراك في الحساب) فلا تظهر صفحاته للزوار. لسحبه وثّق جلسة حسابك في الموقع من لوحة التحكم ثم أعد /فصل."
      );
    }
    await addJobAttempt(
      job.id,
      "downloading",
      "الفصل مدفوع — سيُسحب بجلية الموقع الموثقة من لوحة التحكم."
    );
    await post({ ...base(), status: "downloading" }, true);
    return await resolveLockedWithSession(job, cookie);
  }
  throw new DirectSourceError(
    "تعذر فتح صفحة الفصل من الموقع مباشرة الآن — قد يكون الموقع مشغولًا أو يحمي صفحته بتحقق. أعد /فصل بعد قليل."
  );
}

/** جلب الفصل المقفل بحقن كوكي الجلسة الموثقة (rokari وشونين جامب+). */
async function resolveLockedWithSession(
  job: ChapterJob,
  cookie: string
): Promise<ResolvedChapter> {
  const direct = await fetchDirectChapterWithSession(job.canonicalUrl, cookie);
  await addJobAttempt(
    job.id,
    "downloading",
    `فُتح الفصل بالجلسة الموثقة — ${direct.pages.length} صفحة.`
  );
  return {
    mangaTitle: direct.mangaTitle,
    chapterName: direct.chapterName,
    pages: direct.pages,
    sourceChapterId: job.canonicalUrl,
  };
}

async function processChapterJob(job: ChapterJob): Promise<void> {
  // حالة المسار الحية لهذا الطلب؛ تُغذّي بطاقة Discord في كل تحديث.
  let stage: JobStage = "validate";
  let label: string | null = null;
  let pageCount: number | undefined;
  let mergedCount: number | undefined;
  // دمج الصفحات إعداد لكل سيرفر من قسم الدمج في /الاعدادات — الافتراضي
  // مفعّل بسقف 15000px وعرض تلقائي، ويمكن تعطيله أو تخصيص الأبعاد.
  // عند التعطيل يُرفع الفصل صفحاته كما هي، ويظهر صف الدمج في القائمة كمتخطى.
  const mergeConfig = await getGuildChapterMergeConfig(job.requestedInGuildId);
  const mergeEnabled = mergeConfig.enabled;
  const mergeDimensions = resolveMergeDimensions(mergeConfig);
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
      mergeDisabled: !mergeEnabled,
    });
    await addJobAttempt(job.id, "downloading", "بدأ التحقق من الفصل في المصدر.");
    await post({ ...base(), status: "downloading" }, true);
    const source = await getSourceById(job.sourceId);
    if (
      !source ||
      source.status !== "active" ||
      !source.allowDirectChapterLookup
    ) {
      throw new Error(
        "المصدر لم يعد مفعّلًا أو غير مربوط بمصدر مصرح به."
      );
    }

    stage = "chapter";
    await post({ ...base(), status: "downloading" }, true);

    // ============================================================
    // التوجيه الذكي حسب نمط الموقع — بلا أي خيار يدوي:
    // • «direct-first» (شونين جامب+): الصفحة تُقرأ مباشرة أولًا دائمًا —
    //   المتاح مجانًا تُستخدم صوره فورًا، والمدفوع بجلسة موثقة أو برفض واضح.
    // • «session-only» (rokari): المسار المعتاد أساسًا، وفقط حين وثّق المالك
    //   جلستها تُفحص الصفحة أولًا ليلتقط الفصل المقفل (المدفوع) بجلستها.
    // • غير المدعوم: المسار المعتاد كما هو — سلوك كل المصادر الأخرى لم يتغير.
    // ============================================================
    let resolved: ResolvedChapter | null = null;
    const mode = directSourceMode(source.hostname);
    if (mode === "direct-first") {
      resolved = await resolveViaDirectFirst(job, base, post);
    } else if (mode === "session-only") {
      const sessionCookie = await getDirectSessionCookie(source.hostname);
      if (sessionCookie) {
        const probe = await probeDirectChapterPage(job.canonicalUrl);
        if (probe.mode === "locked") {
          await addJobAttempt(
            job.id,
            "downloading",
            "الفصل محمي (مدفوع) — سيُسحب مباشرة بجلية الموقع الموثقة من لوحة التحكم."
          );
          await post({ ...base(), status: "downloading" }, true);
          resolved = await resolveLockedWithSession(job, sessionCookie);
        }
      }
    }
    if (!resolved) {
      resolved = await resolveChapterViaSuwayomi(job, source, {
        onRetry: async attempt => {
          await addJobAttempt(
            job.id,
            "downloading",
            `لم يُعثر على الفصل في المحاولة ${attempt}، تتم إعادة المحاولة بعد مهلة.`
          );
        },
        onFinalFailure: async () => {
          if (mode === "session-only") {
            const sessionCookie = await getDirectSessionCookie(source.hostname);
            if (!sessionCookie) {
              const probe = await probeDirectChapterPage(job.canonicalUrl);
              if (probe.mode === "locked") {
                throw new DirectSourceError(
                  "هذا الفصل مقفل (مدفوع) ولا يظهر في فصول الموقع المفهرسة. لسحبه وثّق جلسة الموقع من لوحة التحكم ثم أعد /فصل."
                );
              }
            }
          }
        },
      });
    }

    pageCount = resolved.pages.length;
    label = `**${resolved.mangaTitle}** — ${resolved.chapterName}`;
    stage = "download";
    await post({ ...base(), status: "downloading" }, true);
    // تُنزّل الصفحات وتُعالج عبر ملفات مؤقتة على القرص بدل الذاكرة؛ ذلك يمنع
    // قتل العملية بسبب نفاد الذاكرة (exit 137) في الفصول الطويلة.
    // صيغة الإخراج إعداد لكل سيرفر من أمر /الاعدادات، ولمن لم يخصص يعمل
    // بالإعداد العام من لوحة التحكم؛ الافتراضي في الحالين PNG بضغط أقصى بلا أي فقدان.
    const outputConfig = await getEffectiveImageOutputConfig(job.requestedInGuildId);
    const downloadEvents: MergeProgressListener = async event => {
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
    };
    // المسار المدمج: صفحات الفصل تُدمج في صور طويلة بصيغة إعدادات السيرفر.
    // المسار المعطّل: تُنزّل الصفحات فقط وتُرفع كما هي بأصلها دون أي إعادة
    // ترميز (فك تشويش GigaViewer يبقى شغالًا لأنه جزء من التنزيل)، وأمر /دمج
    // لا يتأثر بهذا الإعداد إطلاقًا.
    let uploadItems: Array<{ filePath: string; mimeType: string }>;
    let cleanupTemp: () => Promise<void>;
    if (mergeEnabled) {
      const mergeSession = await openChapterMergeSession(resolved.pages, downloadEvents, outputConfig, mergeDimensions);
      uploadItems = mergeSession.images.map(image => ({
        filePath: image.filePath,
        mimeType: image.mimeType,
      }));
      cleanupTemp = mergeSession.cleanup;
    } else {
      const pagesSession = await openChapterPagesSession(resolved.pages, downloadEvents);
      uploadItems = pagesSession.pages.map(page => ({
        filePath: page.filePath,
        mimeType: page.mimeType,
      }));
      cleanupTemp = pagesSession.cleanup;
    }
    try {
      if (!uploadItems.length)
        throw new Error("تعذر تجهيز صفحات الفصل لرفعها.");
      mergedCount = uploadItems.length;
      await setJobChapterDetails(job.id, {
        sourceChapterId: resolved.sourceChapterId,
        mangaTitle: resolved.mangaTitle,
        chapterTitle: resolved.chapterName,
        totalPages: uploadItems.length,
      });
      await addJobAttempt(
        job.id,
        "downloading",
        mergeEnabled
          ? `سُحبت ${resolved.pages.length} صفحة ودمجت في ${uploadItems.length} صور طويلة — ${imageOutputDescription(outputConfig)}.`
          : `سُحبت ${resolved.pages.length} صفحة وستُرفع كما هي بدون دمج — الدمج معطّل من إعدادات هذا السيرفر.`
      );

      const drive = new GoogleDriveClient();
      const sharing = sharingPolicyFromMode(
        await getSetting("google_drive_sharing_mode"),
        await getSetting("google_drive_sharing_domain")
      );
      const folder = await drive.createChapterFolder(
        // نطاق المصدر يُضاف لاسم العمل حتى لا يشارك مصدران مختلفان نفس المجلد
        // إذا تطابق اسم العمل واسم الفصل بينهما.
        mangaFolderTitle(resolved.mangaTitle, job.canonicalUrl),
        resolved.chapterName,
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

      for (let offset = 0; offset < uploadItems.length; offset += 1) {
        const uploadItem = uploadItems[offset];
        if (!uploadItem) continue;
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
          uploadItem.filePath,
          folder.id,
          pageNumber,
          uploadItem.mimeType
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
        mergeEnabled
          ? `اكتمل رفع ${mergedCount} صورة طويلة مدمجة إلى Google Drive.`
          : `اكتمل رفع ${mergedCount} صفحة كما هي إلى Google Drive بدون دمج.`
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
      await cleanupTemp();
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
