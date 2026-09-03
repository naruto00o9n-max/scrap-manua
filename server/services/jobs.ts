import { randomUUID } from "node:crypto";
import { addJobAttempt, createOrGetChapterJob, getActiveSources } from "../db";
import { validateChapterUrl, type ValidatedChapterUrl } from "./urlPolicy";
import { ENV } from "../_core/env";
import { getUsableSuwayomiToken } from "./settings";
import { SuwayomiClient } from "./suwayomi";
import { UrlPolicyError } from "./urlPolicy";

export type ChapterRequest = {
  chapterUrl: string;
  requester: {
    discordId: string;
    displayName: string;
    channelId?: string;
  };
};

export async function queueAuthorizedChapter(request: ChapterRequest) {
  const sources = await getActiveSources();
  const validated: ValidatedChapterUrl = validateChapterUrl(request.chapterUrl, sources);
  const source = sources.find(item => item.id === validated.sourceId);
  if (!source?.suwayomiSourceId) {
    throw new UrlPolicyError("SOURCE_NOT_READY", "هذا المصدر غير مربوط بمصدر معتمد بعد.");
  }
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
  const result = await createOrGetChapterJob({
    id: randomUUID(),
    sourceId: validated.sourceId,
    urlHash: validated.urlHash,
    canonicalUrl: validated.canonicalUrl,
    requestedByDiscordId: request.requester.discordId,
    requestedByName: request.requester.displayName,
    requestedInChannelId: request.requester.channelId,
  });

  if (result.created) {
    await addJobAttempt(result.job.id, "pending", "تم التحقق من الرابط وبدأت المعالجة.");
  }
  return result;
}
