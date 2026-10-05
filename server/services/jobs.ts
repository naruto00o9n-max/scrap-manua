import { randomUUID } from "node:crypto";
import {
  addJobAttempt,
  createOrGetChapterJob,
  getActiveSources,
  getBlockedSources,
  listSources,
} from "../db";
import { validateChapterUrl, normalizeHostname, type ValidatedChapterUrl } from "./urlPolicy";
import { ENV } from "../_core/env";
import { getUsableSuwayomiToken } from "./settings";
import { SuwayomiClient, withTransientRetry } from "./suwayomi";
import { isDirectSourceSupported } from "./directSource";
import { syncSourcesFromSuwayomi } from "./sourceSync";
import { UrlPolicyError } from "./urlPolicy";

export type ChapterRequest = {
  chapterUrl: string;
  requester: {
    discordId: string;
    displayName: string;
    channelId?: string;
    guildId?: string;
  };
};

export async function queueAuthorizedChapter(request: ChapterRequest) {
  // الطلب الأول بعد خمول الخدمات كان يفشل برسالة زائفة (Suwayomi/DB يفيقان
  // خلال ثواني) — ثلاث محاولات مع مهلات قصيرة تحسم البرودة، وسياسة الروابط
  // (UrlPolicyError) حتمية فتُرمى من أول محاولة بلا إعادة.
  return withTransientRetry(() => queueAuthorizedChapterOnce(request), {
    attempts: 3,
    backoffMs: [2_500, 7_000],
  });
}

/** رموز الرفض التي قد تشفيها مزامنة فورية (تركيب إضافة لم تُزامن بعد، أو صف عُطّل ثم عاد). */
export function isSelfHealCandidate(error: unknown): boolean {
  return (
    error instanceof UrlPolicyError &&
    (error.code === "SOURCE_NOT_ALLOWED" || error.code === "SOURCE_NOT_READY")
  );
}

// مزامنة الشفاء تكلّف نداء خادم كاملًا — تكفي مرة كل خمس دقائق كي لا يتحمل
// كل رابط خاطئ فعلاً انتظارها، ودورة المزامنة الدورية تغطي الباقي.
const HEAL_SYNC_MIN_INTERVAL_MS = 5 * 60 * 1000;
let lastHealSyncAt = 0;

export async function queueAuthorizedChapterOnce(request: ChapterRequest) {
  try {
    return await queueAuthorizedChapterValidated(request);
  } catch (error) {
    if (!isSelfHealCandidate(error)) throw error;
    const now = Date.now();
    if (now - lastHealSyncAt < HEAL_SYNC_MIN_INTERVAL_MS) throw error;
    lastHealSyncAt = now;
    // المصدر مثبت في خادم السحب لكن سجله عندنا فاتته المزامنة (تركيب حديث،
    // نطاق مؤقت لم يُستكمل، إلخ) — مزامنة فورية ثم محاولة ثانية قبل الرفض.
    await syncSourcesFromSuwayomi().catch(() => null);
    try {
      return await queueAuthorizedChapterValidated(request);
    } catch (secondError) {
      if (
        error instanceof UrlPolicyError &&
        error.code === "SOURCE_NOT_ALLOWED" &&
        secondError instanceof UrlPolicyError &&
        secondError.code === "SOURCE_NOT_ALLOWED"
      ) {
        throw await describeSourceBlocker(secondError, request.chapterUrl);
      }
      throw secondError;
    }
  }
}

/**
 * رسالة أوضح حين يثبت الرفض: يميّز «موجود لكنه موقوف» و«محذوف من قائمة
 * المواقع» عن «غير مسجّل أصلًا»، فكل حالة لها حل مختلف عند صاحب الأمر.
 */
export async function describeSourceBlocker(fallback: UrlPolicyError, chapterUrl: string): Promise<UrlPolicyError> {
  try {
    const hostname = normalizeHostname(new URL(chapterUrl).hostname);
    const [all, blocked] = await Promise.all([listSources(), getBlockedSources()]);
    const row = all.find(item => normalizeHostname(item.hostname) === hostname);
    if (row && row.status !== "active") {
      return new UrlPolicyError(
        "SOURCE_NOT_READY",
        "هذا الموقع مُسجّل في قائمة المواقع لكنه موقوف — فعّله من «إدارة المواقع» ثم أعد المحاولة."
      );
    }
    if (row && !row.allowDirectChapterLookup) {
      if (row.origin === "suwayomi") {
        return new UrlPolicyError(
          "SOURCE_NOT_READY",
          "هذا الموقع مُسجّل بلا نطاق محقق بعد — ابحث عن أي عمل منه عبر /بحث ثم اطلب الفصل، فيكتمل نطاقه تلقائيًا."
        );
      }
      return new UrlPolicyError(
        "SOURCE_NOT_READY",
        "السحب المباشر معطّل لهذا الموقع — فعّله من «إدارة المواقع» ثم أعد المحاولة."
      );
    }
    if (blocked.hostnames.includes(hostname)) {
      return new UrlPolicyError(
        "SOURCE_BLOCKED",
        "هذا الموقع محذوف من قائمة مواقع البوت — أعد إضافته من «إدارة المواقع» ليُقبل رابطه."
      );
    }
  } catch {
    // فشل تشخيص السبب لا يغيّر الرفض الأصلي.
  }
  return fallback;
}

async function queueAuthorizedChapterValidated(request: ChapterRequest) {
  const sources = await getActiveSources();
  const validated: ValidatedChapterUrl = validateChapterUrl(request.chapterUrl, sources);
  const source = sources.find(item => item.id === validated.sourceId);
  // المصادر المدعومة بالسحب المباشر (rokari، شونين جامب+) لا تشترط ربط
  // إضافة خادم: شونين جامب+ يُسحب مباشرة كليًا، وrokari يحتاج الربط لفصوله
  // المجانية فيفحصه العامل وقت التنفيذ. غير المدعوم يبقى مشروطًا بالربط.
  if (!source?.suwayomiSourceId && !isDirectSourceSupported(source?.hostname)) {
    throw new UrlPolicyError("SOURCE_NOT_READY", "هذا المصدر غير مربوط بمصدر معتمد بعد.");
  }
  if (source?.suwayomiSourceId) {
    const installedSource = (await new SuwayomiClient(ENV.suwayomiBaseUrl, getUsableSuwayomiToken()).listInstalledSources())
      .find(item => item.id === source.suwayomiSourceId);
    if (!installedSource?.extension?.isInstalled) {
      throw new UrlPolicyError("SOURCE_NOT_READY", "الإضافة المطابقة لهذا المصدر ليست مثبّتة حاليًا.");
    }
    if (source.extensionPackage && installedSource.extension.pkgName !== source.extensionPackage) {
      throw new UrlPolicyError("SOURCE_NOT_READY", "حزمة الإضافة لا تطابق المصدر المعتمد.");
    }
    if (source.extensionName && installedSource.extension.name !== source.extensionName) {
      throw new UrlPolicyError("SOURCE_NOT_READY", "اسم الإضافة لا يطابق المصدر المعتمد.");
    }
  }
  const result = await createOrGetChapterJob({
    id: randomUUID(),
    sourceId: validated.sourceId,
    urlHash: validated.urlHash,
    canonicalUrl: validated.canonicalUrl,
    requestedByDiscordId: request.requester.discordId,
    requestedByName: request.requester.displayName,
    requestedInChannelId: request.requester.channelId,
    requestedInGuildId: request.requester.guildId,
  });

  if (result.created) {
    await addJobAttempt(result.job.id, "pending", "تم التحقق من الرابط وبدأت المعالجة.");
  }
  return result;
}
