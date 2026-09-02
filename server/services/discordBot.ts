import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  ActivityType,
  Client,
  Events,
  GatewayIntentBits,
  MessageFlags,
  REST,
  Routes,
  SlashCommandBuilder,
  type APIMessageTopLevelComponent,
} from "discord.js";
import { ENV } from "../_core/env";
import { ZEUS_AVATAR_BASE64 } from "../assets/zeusAvatar";
import {
  addJobAttempt,
  cancelChapterJob,
  getChapterJob,
  getSetting,
  listActiveDiscordRoleIds,
  saveIntegrationHealth,
  setDiscordProgressMessage,
  setSetting,
} from "../db";
import { queueAuthorizedChapter } from "./jobs";
import {
  GoogleDriveError,
} from "./googleDrive";
import {
  ManualMergeCancelled,
  ManualMergeCancelToken,
  downloadHttpsToPath,
  isSupportedArchiveName,
  parseDriveLink,
  runManualMerge,
} from "./manualMerge";
import { UrlPolicyError } from "./urlPolicy";

let client: Client | null = null;
let started = false;

const GOLD = 0xd4af37;
const GREEN = 0x57f287;
const RED = 0xed4245;
const GRAY = 0x95a5a6;
const BOT_USERNAME = "ZEUS";
const BOT_PRESENCE = "ZEUS | /مساعدة";
const PROMPT_TIMEOUT_MS = 120_000;

/**
 * مراحل تجهيز الفصل بالترتيب. البطاقة الحية تعرضها كقائمة تحقق:
 * ✓ للمنتهية، ▸ للمرحلة الجارية مع تقدمها الرقمي، · للمت بقايا، ✗/⊘ عند الفشل/الإلغاء.
 */
export type JobStage = "validate" | "chapter" | "download" | "merge" | "upload";
export type JobStatus =
  | "pending"
  | "downloading"
  | "uploading"
  | "completed"
  | "failed"
  | "cancelled"
  | "info";

export type JobNotice = {
  jobId?: string;
  status: JobStatus;
  stage?: JobStage;
  /** تجاوز عنوان البطاقة الافتراضي المشتق من المرحلة الحالية. */
  title?: string;
  /** سطر التعريف بالمانها والفصل. */
  label?: string | null;
  /** سطر سياقي إضافي (رسالة خطأ أو ملاحظة) يظهر في أسفل البطاقة. */
  detail?: string | null;
  /** تقدم رقمي حي للمرحلة الجارية. */
  progress?: { done: number; total: number };
  /** عدد صفحات الفصل كما عادها المصدر. */
  pageCount?: number;
  /** عدد الصور الطويلة الناتجة بعد الدمج. */
  mergedCount?: number;
  driveUrl?: string | null;
};

export type JobCardOptions = { requesterId?: string };

const ACTIVE_STATUSES: JobStatus[] = ["pending", "downloading", "uploading"];
const TERMINAL_STATUSES: JobStatus[] = ["completed", "failed", "cancelled"];

const STAGE_ORDER: JobStage[] = [
  "validate",
  "chapter",
  "download",
  "merge",
  "upload",
];

const STAGE_LABELS: Record<JobStage, string> = {
  validate: "فحص الرابط والمصدر",
  chapter: "العثور على الفصل",
  download: "سحب الصفحات",
  merge: "دمج الصفحات",
  upload: "رفع الصور إلى Drive",
};

const STAGE_TITLES: Record<JobStage, string> = {
  validate: "⏳ جاري فحص الرابط",
  chapter: "⏳ جاري التحقق من الفصل",
  download: "⬇️ جاري سحب الصفحات",
  merge: "🧩 جاري دمج الصفحات",
  upload: "☁️ جاري رفع الصور",
};

const STATUS_TITLES: Record<"completed" | "failed" | "cancelled", string> = {
  completed: "✅ الفصل جاهز",
  failed: "❌ فشل تجهيز الفصل",
  cancelled: "🚫 أُلغي الطلب",
};

const ACCENTS: Record<JobStatus, number> = {
  pending: GOLD,
  downloading: GOLD,
  uploading: GOLD,
  completed: GREEN,
  failed: RED,
  cancelled: GRAY,
  info: GOLD,
};

const commandPayload = [
  new SlashCommandBuilder()
    .setName("فصل")
    .setDescription("سحب فصل مانهوا وتسليمه جاهزًا برابط")
    .addStringOption(option =>
      option
        .setName("الرابط")
        .setDescription("رابط الفصل - اختياري")
        .setRequired(false)
    ),
  new SlashCommandBuilder()
    .setName("دمج")
    .setDescription("دمج صور جاهزة في صور طويلة بدون سحب - ZIP/CBZ أو رابط Drive")
    .addStringOption(option =>
      option
        .setName("الرابط")
        .setDescription("رابط مجلد Google Drive الذي يحتوي الصور - اختياري")
        .setRequired(false)
    )
    .addAttachmentOption(option =>
      option
        .setName("الملف")
        .setDescription("ملف ZIP أو CBZ يحتوي صور الفصل - اختياري")
        .setRequired(false)
    ),
  new SlashCommandBuilder()
    .setName("مساعدة")
    .setDescription("شرح الأوامر وطريقة الاستخدام"),
].map(command => command.toJSON());

export function getRegisteredDiscordCommands() {
  return commandPayload;
}

function isOwner(userId: string) {
  return Boolean(ENV.ownerDiscordUserId) && userId === ENV.ownerDiscordUserId;
}

async function hasRequestAccess(interaction: any) {
  if (!interaction.inGuild() || !interaction.member || !interaction.channelId)
    return false;
  if (isOwner(interaction.user.id)) return true;
  const allowed = await listActiveDiscordRoleIds();
  const roles = Array.isArray(interaction.member.roles)
    ? interaction.member.roles
    : interaction.member.roles.cache.map((role: { id: string }) => role.id);
  return allowed.some(role => roles.includes(role));
}

// ============================================================
// بناء بطاقات Components V2 (حاوية + قسم + فواصل + قائمة تحقق)
// ============================================================

type Raw = Record<string, unknown>;

const raw = (value: Raw): APIMessageTopLevelComponent =>
  value as unknown as APIMessageTopLevelComponent;

const text = (content: string): Raw => ({ type: 10, content });

const separator = (spacing: 1 | 2 = 1): Raw => ({
  // نوع مكوّن الفاصل في Discord API هو 14 حصريًا؛ أي قيمة أخرى (مثل 18)
  // ترفضها المنصة بخطأ 50035 Invalid Form Body.
  type: 14,
  divider: true,
  spacing,
});

function headerBlock(
  title: string,
  lines: string[],
  avatarUrl: string | null
): Raw {
  const content = [title, ...lines.filter(Boolean)].join("\n\n");
  if (!avatarUrl) return text(content);
  return {
    type: 9,
    components: [text(content)],
    accessory: { type: 11, media: { url: avatarUrl } },
  };
}

function avatarUrl(): string | null {
  try {
    if (client?.user)
      return client.user.displayAvatarURL({ extension: "png", size: 256 });
  } catch {
    /* الحصول على الصورة الرمزية اختياري */
  }
  return null;
}

function progressBar(done: number, total: number): string {
  const cells = 10;
  if (total <= 0) return "▱".repeat(cells);
  const ratio = Math.min(1, Math.max(0, done / total));
  let filled = Math.round(ratio * cells);
  if (done > 0 && filled === 0) filled = 1;
  return "▰".repeat(filled) + "▱".repeat(cells - filled);
}

function stageSuffixDone(notice: JobNotice, stage: JobStage): string {
  if (stage === "chapter" || stage === "download") {
    return notice.pageCount ? ` — ${notice.pageCount} صفحة` : "";
  }
  if (stage === "merge" || stage === "upload") {
    return notice.mergedCount ? ` — ${notice.mergedCount} صورة` : "";
  }
  return "";
}

function checklistLines(notice: JobNotice): string[] {
  const current = notice.stage ? STAGE_ORDER.indexOf(notice.stage) : -1;
  return STAGE_ORDER.map((stage, index) => {
    const label = STAGE_LABELS[stage];
    if (notice.status === "completed" || index < current) {
      return `✓ ${label}${stageSuffixDone(notice, stage)}`;
    }
    if (index === current) {
      if (notice.status === "failed") return `✗ ${label}`;
      if (notice.status === "cancelled") return `⊘ ${label}`;
      const live = notice.progress
        ? ` — ${notice.progress.done}/${notice.progress.total}`
        : "";
      return `▸ ${label}${live}`;
    }
    return `· ${label}`;
  });
}

function cardTitle(notice: JobNotice): string {
  if (notice.title) return notice.title;
  if (
    notice.status === "completed" ||
    notice.status === "failed" ||
    notice.status === "cancelled"
  ) {
    return STATUS_TITLES[notice.status];
  }
  if (notice.stage) return STAGE_TITLES[notice.stage];
  return "⏳ جاري العمل على الفصل";
}

function actionRows(notice: JobNotice): Raw[] {
  const buttons: Raw[] = [];
  if (notice.status === "completed" && notice.driveUrl) {
    buttons.push({
      type: 2,
      style: 5,
      label: "فتح الفصل",
      url: notice.driveUrl,
    });
  } else if (ACTIVE_STATUSES.includes(notice.status) && notice.jobId) {
    buttons.push({
      type: 2,
      style: 4,
      label: "إلغاء",
      custom_id: `job:cancel:${notice.jobId}`,
    });
  }
  if (!buttons.length) return [];
  return [{ type: 1, components: buttons }];
}

/** بطاقة حالة الفصل: رأس بمرحلة حالية + شريط تقدم + قائمة تحقق المراحل + أزرار سياقية. */
export function buildJobCard(
  notice: JobNotice,
  options?: JobCardOptions
): APIMessageTopLevelComponent[] {
  const title = cardTitle(notice);
  const labelLines: string[] = [];
  if (TERMINAL_STATUSES.includes(notice.status) && options?.requesterId) {
    labelLines.push(`<@${options.requesterId}>`);
  }
  if (notice.label) labelLines.push(notice.label);

  const body: Raw[] = [
    headerBlock(title, labelLines, avatarUrl()),
    separator(2),
  ];

  if (notice.progress && ACTIVE_STATUSES.includes(notice.status)) {
    body.push(
      text(
        `${progressBar(notice.progress.done, notice.progress.total)} **${notice.progress.done} / ${notice.progress.total}**`
      )
    );
    body.push(separator());
  }

  // قائمة التحقق تظهر فقط للبطاقات المرتبطة بمسار تجهيز فعلي (لها مرحلة).
  if (notice.stage) {
    body.push(text(checklistLines(notice).join("\n")));
  }

  const detail = notice.detail?.trim();
  if (detail) {
    body.push(separator());
    body.push(text(detail.slice(0, 1000)));
  }

  if (notice.status === "completed" && notice.driveUrl) {
    body.push(separator());
    body.push(text(`**رابط الفصل:** ${notice.driveUrl}`));
  }

  const rows = actionRows(notice);
  if (rows.length) {
    body.push(separator());
    body.push(...rows);
  }

  return [
    raw({ type: 17, accent_color: ACCENTS[notice.status], components: body }),
  ];
}

/** لوحة /مساعدة: تعريف البوت ثم شرح كل أمر بخطوات مرقمة. */
export function buildHelpComponents(
  avatar: string | null = avatarUrl()
): APIMessageTopLevelComponent[] {
  const body: Raw[] = [
    headerBlock(
      "## 📖 ZEUS",
      [
        "بوت سحب فصول المانهوا: أعطه رابط الفصل، ويتولى السحب والدمج والرفع، ويسلّمك الفصل جاهزًا على Google Drive.",
      ],
      avatar
    ),
    separator(2),
    text(
      [
        "### 🔹 /فصل",
        "يسحب فصلًا من المصادر المدعومة ويسلّمك رابطه.",
        "**1.** نفّذ `/فصل` واكتب رابط الفصل في الخانة المخصصة.",
        "**2.** أو نفّذ `/فصل` بدون رابط ثم أرسله كرسالة عادية في القناة خلال دقيقتين.",
        "**3.** بطاقة التقدم تتحدث تلقائيًا مع كل خطوة: فحص الرابط ← العثور على الفصل ← سحب الصفحات ← دمج الصفحات ← الرفع إلى Drive، وعند الاكتمال تجد زر فتح الفصل.",
      ].join("\n")
    ),
    separator(),
    text(
      [
        "### 🔹 /دمج",
        "يدمج صورًا جاهزة في صور طويلة بدون أي سحب — مفيد إذا سحبت الفصل بنفسك من مكان آخر.",
        "**1.** نفّذ `/دمج` وأرفق ملف **ZIP** أو **CBZ** يحتوي صور الفصل في خانة الملف، أو ضع رابط مجلد Google Drive في خانة الرابط.",
        "**2.** أو نفّذ `/دمج` بدون شيء ثم أرسل الملف أو الرابط هنا كرسالة عادية خلال دقيقتين.",
        "**3.** بطاقة التقدم تتحدث مع كل خطوة: فحص المدخلات ← جلب الصور ← دمج الصفحات ← الرفع إلى Drive، وعند الاكتمال تجد زر فتح الفصل.",
      ].join("\n")
    ),
    separator(),
    text(["### 🔹 /مساعدة", "يشرح طريقة الاستخدام — هذه الرسالة."].join("\n")),
    separator(),
    text("-# ZEUS"),
  ];
  return [raw({ type: 17, accent_color: GOLD, components: body })];
}

/** لوحة طلب الرابط حين يُنفَّذ /فصل بدون رابط. */
export function buildPromptComponents(
  avatar: string | null = avatarUrl()
): APIMessageTopLevelComponent[] {
  const body: Raw[] = [
    headerBlock("## ✍️ أرسل رابط الفصل", [], avatar),
    separator(2),
    text(
      [
        "**1.** انسخ رابط الفصل مباشرة من الموقع.",
        "**2.** أرسله هنا كرسالة عادية خلال دقيقتين.",
        "**3.** سيبدأ ZEUS السحب فورًا وستتابع كل خطوة في بطاقة حية.",
      ].join("\n")
    ),
    separator(),
    text("-# ZEUS"),
  ];
  return [raw({ type: 17, accent_color: GOLD, components: body })];
}

function cardPayload(notice: JobNotice, options?: JobCardOptions) {
  return {
    flags: MessageFlags.IsComponentsV2 as MessageFlags.IsComponentsV2,
    allowedMentions: options?.requesterId
      ? { users: [options.requesterId] }
      : undefined,
    components: buildJobCard(notice, options),
  };
}

// ============================================================
// أمر الدمج اليدوي: صور جاهزة (ZIP/CBZ أو مجلد Drive) تُدمج بلا سحب.
// بطاقة مستقلة تمامًا عن بطاقة الفصول — لا تمس منطق /فصل إطلاقًا.
// ============================================================

export type MergeStage = "validate" | "fetch" | "merge" | "upload";

export type MergeNotice = {
  mergeId?: string;
  status: JobStatus;
  stage?: MergeStage;
  /** تجاوز عنوان البطاقة الافتراضي المشتق من المرحلة الحالية. */
  title?: string;
  /** سطر تعريف المصدر (اسم الأرشيف أو المجلد وحصيلته). */
  label?: string | null;
  /** سطر سياقي إضافي (رسالة خطأ أو ملاحظة) يظهر أسفل البطاقة. */
  detail?: string | null;
  /** تقدم رقمي حي للمرحلة الجارية. */
  progress?: { done: number; total: number };
  /** عدد صور المصدر قبل الدمج. */
  imageCount?: number;
  /** عدد الصور الطويلة الناتجة بعد الدمج. */
  mergedCount?: number;
  driveUrl?: string | null;
};

type MergeCardOptions = { requesterId?: string };

const MERGE_STAGE_ORDER: MergeStage[] = ["validate", "fetch", "merge", "upload"];

const MERGE_STAGE_LABELS: Record<MergeStage, string> = {
  validate: "فحص المدخلات",
  fetch: "جلب الصور",
  merge: "دمج الصفحات",
  upload: "رفع الصور إلى Drive",
};

const MERGE_STAGE_TITLES: Record<MergeStage, string> = {
  validate: "⏳ جاري فحص المدخلات",
  fetch: "⬇️ جاري جلب الصور",
  merge: "🧩 جاري دمج الصفحات",
  upload: "☁️ جاري رفع الصور",
};

const MERGE_STATUS_TITLES: Record<"completed" | "failed" | "cancelled", string> = {
  completed: "✅ اكتمل الدمج — الفصل جاهز",
  failed: "❌ فشل الدمج",
  cancelled: "🚫 أُلغي الدمج",
};

function mergeStageSuffix(notice: MergeNotice, stage: MergeStage): string {
  if (stage === "fetch") {
    return notice.imageCount ? ` — ${notice.imageCount} صورة` : "";
  }
  if (stage === "merge" || stage === "upload") {
    return notice.mergedCount ? ` — ${notice.mergedCount} صورة` : "";
  }
  return "";
}

function mergeChecklistLines(notice: MergeNotice): string[] {
  const current = notice.stage ? MERGE_STAGE_ORDER.indexOf(notice.stage) : -1;
  return MERGE_STAGE_ORDER.map((stage, index) => {
    const label = MERGE_STAGE_LABELS[stage];
    if (notice.status === "completed" || index < current) {
      return `✓ ${label}${mergeStageSuffix(notice, stage)}`;
    }
    if (index === current) {
      if (notice.status === "failed") return `✗ ${label}`;
      if (notice.status === "cancelled") return `⊘ ${label}`;
      const live = notice.progress
        ? ` — ${notice.progress.done}/${notice.progress.total}`
        : "";
      return `▸ ${label}${live}`;
    }
    return `· ${label}`;
  });
}

function mergeCardTitle(notice: MergeNotice): string {
  if (notice.title) return notice.title;
  if (
    notice.status === "completed" ||
    notice.status === "failed" ||
    notice.status === "cancelled"
  ) {
    return MERGE_STATUS_TITLES[notice.status];
  }
  if (notice.stage) return MERGE_STAGE_TITLES[notice.stage];
  return "⏳ جاري العمل على الدمج";
}

function mergeActionRows(notice: MergeNotice): Raw[] {
  const buttons: Raw[] = [];
  if (notice.status === "completed" && notice.driveUrl) {
    buttons.push({
      type: 2,
      style: 5,
      label: "فتح الفصل",
      url: notice.driveUrl,
    });
  } else if (ACTIVE_STATUSES.includes(notice.status) && notice.mergeId) {
    buttons.push({
      type: 2,
      style: 4,
      label: "إلغاء",
      custom_id: `merge:cancel:${notice.mergeId}`,
    });
  }
  if (!buttons.length) return [];
  return [{ type: 1, components: buttons }];
}

/** بطاقة الدمج اليدوي: رأس + شريط تقدم + قائمة تحقق المراحل + أزرار سياقية. */
export function buildMergeCard(
  notice: MergeNotice,
  options?: MergeCardOptions
): APIMessageTopLevelComponent[] {
  const title = mergeCardTitle(notice);
  const labelLines: string[] = [];
  if (TERMINAL_STATUSES.includes(notice.status) && options?.requesterId) {
    labelLines.push(`<@${options.requesterId}>`);
  }
  if (notice.label) labelLines.push(notice.label);

  const body: Raw[] = [
    headerBlock(title, labelLines, avatarUrl()),
    separator(2),
  ];

  if (notice.progress && ACTIVE_STATUSES.includes(notice.status)) {
    body.push(
      text(
        `${progressBar(notice.progress.done, notice.progress.total)} **${notice.progress.done} / ${notice.progress.total}**`
      )
    );
    body.push(separator());
  }

  if (notice.stage) {
    body.push(text(mergeChecklistLines(notice).join("\n")));
  }

  const detail = notice.detail?.trim();
  if (detail) {
    body.push(separator());
    body.push(text(detail.slice(0, 1000)));
  }

  if (notice.status === "completed" && notice.driveUrl) {
    body.push(separator());
    body.push(text(`**رابط الفصل:** ${notice.driveUrl}`));
  }

  const rows = mergeActionRows(notice);
  if (rows.length) {
    body.push(separator());
    body.push(...rows);
  }

  return [
    raw({ type: 17, accent_color: ACCENTS[notice.status], components: body }),
  ];
}

/** لوحة طلب مدخلات الدمج حين يُنفَّذ /دمج بدون ملف ولا رابط. */
export function buildMergePromptComponents(
  avatar: string | null = avatarUrl()
): APIMessageTopLevelComponent[] {
  const body: Raw[] = [
    headerBlock("## 🧩 أرسل صور الفصل للدمج", [], avatar),
    separator(2),
    text(
      [
        "**1.** أرفق ملف **ZIP** أو **CBZ** يحتوي صور الفصل، أو انسخ رابط مجلد Google Drive الذي يحتويها.",
        "**2.** أرسلها هنا كرسالة عادية خلال دقيقتين.",
        "**3.** سيبدأ ZEUS الدمج فورًا وستتابع كل خطوة في بطاقة حية حتى رابط الفصل الجاهز.",
      ].join("\n")
    ),
    separator(),
    text("-# ZEUS"),
  ];
  return [raw({ type: 17, accent_color: GOLD, components: body })];
}

function mergeCardPayload(notice: MergeNotice, options?: MergeCardOptions) {
  return {
    flags: MessageFlags.IsComponentsV2 as MessageFlags.IsComponentsV2,
    allowedMentions: options?.requesterId
      ? { users: [options.requesterId] }
      : undefined,
    components: buildMergeCard(notice, options),
  };
}

function panelPayload(components: APIMessageTopLevelComponent[]) {
  return {
    flags: MessageFlags.IsComponentsV2 as MessageFlags.IsComponentsV2,
    components,
  };
}

/** يحوّل سجل الطلب في قاعدة البيانات إلى بطاقة حالته الحالية. */
export function noticeFromJob(job: {
  id: string;
  status: string;
  totalPages: number;
  uploadedPages: number;
  googleDriveUrl: string | null;
  mangaTitle: string | null;
  chapterTitle: string | null;
  failureMessage: string | null;
}): JobNotice {
  const status = (
    [
      "pending",
      "downloading",
      "uploading",
      "completed",
      "failed",
      "cancelled",
    ].includes(job.status)
      ? job.status
      : "pending"
  ) as Exclude<JobStatus, "info">;
  let stage: JobStage = "validate";
  if (status === "uploading" || job.uploadedPages > 0) stage = "upload";
  else if (status === "downloading" || job.totalPages > 0) stage = "download";
  const label =
    [job.mangaTitle, job.chapterTitle].filter(Boolean).join(" — ") || null;
  return {
    jobId: job.id,
    status,
    stage,
    label,
    detail: status === "failed" ? (job.failureMessage ?? null) : null,
    pageCount: job.totalPages || undefined,
    mergedCount: job.totalPages || undefined,
    progress:
      status === "uploading" && job.totalPages
        ? { done: job.uploadedPages, total: job.totalPages }
        : undefined,
    driveUrl: job.googleDriveUrl,
  };
}

export async function refreshDiscordCommands() {
  if (!ENV.discordBotToken || !ENV.discordApplicationId || !ENV.discordGuildId)
    return;
  await new REST({ version: "10" })
    .setToken(ENV.discordBotToken)
    .put(
      Routes.applicationGuildCommands(
        ENV.discordApplicationId,
        ENV.discordGuildId
      ),
      {
        body: commandPayload,
      }
    );
}

export function isDiscordBotReady() {
  return Boolean(client?.isReady());
}

// ============================================================
// تدفق الأوامر
// ============================================================

/**
 * هدف بطاقة حية: كل استدعاء show يرسم في نفس الرسالة دائمًا،
 * فلا تتكرر الرسائل مهما تكررت مراحل التحديث.
 */
type CardTarget = { show: (notice: JobNotice) => Promise<string> };

function interactionCard(interaction: any): CardTarget {
  return {
    show: async notice => (await interaction.editReply(cardPayload(notice))).id,
  };
}

function messageCard(message: any): CardTarget {
  let sent: any = null;
  return {
    show: async notice => {
      if (!sent) sent = await message.reply(cardPayload(notice));
      else await sent.edit(cardPayload(notice));
      return sent.id;
    },
  };
}

type Requester = { id: string; username: string; channelId: string };

async function startChapterFromUrl(
  target: CardTarget,
  chapterUrl: string,
  requester: Requester
) {
  // أول رسم: مؤشر انتظار فوري داخل البطاقة نفسها.
  await target.show({ status: "pending", stage: "validate" });
  const { job, created } = await queueAuthorizedChapter({
    chapterUrl,
    requester: {
      discordId: requester.id,
      displayName: requester.username,
      channelId: requester.channelId,
    },
  });
  if (!created) {
    // يحدث فقط إذا كان الفصل قيد التجهيز فعلًا الآن؛ السجلات المنتهية تُعاد تهيئتها كليًا.
    await target.show({
      status: "info",
      title: "⏳ هذا الفصل قيد التجهيز بالفعل",
      detail: "سبق طلب هذا الفصل وسيصلك رابطه عند اكتمال بطاقته الأصلية.",
    });
    return;
  }
  const messageId = await target.show({
    jobId: job.id,
    status: "pending",
    stage: "validate",
  });
  await setDiscordProgressMessage(job.id, messageId);
  void import("./jobWorker").then(({ processPendingChapterJobs }) =>
    processPendingChapterJobs()
  );
}

type PendingPrompt = { timer: NodeJS.Timeout };
const pendingChapterPrompts = new Map<string, PendingPrompt>();

function clearPrompt(key: string) {
  const pending = pendingChapterPrompts.get(key);
  if (pending) clearTimeout(pending.timer);
  pendingChapterPrompts.delete(key);
}

/** طلبات مدخلات الدمج المعلقة — مستقلة تمامًا عن طلبات روابط الفصول. */
const pendingMergePrompts = new Map<string, PendingPrompt>();

function clearMergePrompt(key: string) {
  const pending = pendingMergePrompts.get(key);
  if (pending) clearTimeout(pending.timer);
  pendingMergePrompts.delete(key);
}

/** عمليات الدمج الجارية في هذه العملية — لزر الإلغاء في البطاقة. */
const activeMergeJobs = new Map<
  string,
  { requesterId: string; token: ManualMergeCancelToken }
>();

async function editMessageContent(
  channelId: string,
  messageId: string,
  body: object
) {
  if (!client || !channelId || !messageId) return;
  const found = await client.channels.fetch(channelId);
  if (!found?.isTextBased() || !("messages" in found)) return;
  await found.messages.edit(messageId, body as never);
}

// ============================================================
// تدفق أمر الدمج اليدوي /دمج
// ============================================================

/**
 * هدف بطاقة الدمج: كل استدعاء show يرسم في نفس الرسالة دائمًا.
 * الرسم الأول عبر ردّ التفاعل ثم كل التحديثات عبر رسالة القناة نفسها،
 * حتى لا يتوقف التحديث بانتهاء صلاحية توكن التفاعل (15 دقيقة) في العمليات الطويلة.
 */
type MergeCardTarget = {
  show: (notice: MergeNotice, options?: MergeCardOptions) => Promise<string>;
};

function mergeInteractionCard(interaction: any): MergeCardTarget {
  let messageId: string | null = null;
  const channelId = interaction.channelId as string;
  return {
    show: async (notice, options) => {
      if (!messageId) {
        const sent = await interaction.editReply(mergeCardPayload(notice, options));
        messageId = String(sent.id);
        return messageId;
      }
      await editMessageContent(channelId, messageId, mergeCardPayload(notice, options));
      return messageId;
    },
  };
}

function mergeMessageCard(message: any): MergeCardTarget {
  let sent: any = null;
  return {
    show: async (notice, options) => {
      if (!sent) sent = await message.reply(mergeCardPayload(notice, options));
      else await sent.edit(mergeCardPayload(notice, options));
      return sent.id;
    },
  };
}

/**
 * تحديث مخنوق (كل 2.5 ثانية) احترامًا لحدود معدل Discord، مع إجبار التحديث
 * عند نهاية كل مرحلة أو تغيّرها — نفس أسلوب بطاقة الفصول.
 */
function createMergeProgressPoster(target: MergeCardTarget) {
  let lastKey = "";
  let lastAt = 0;
  return async (notice: MergeNotice, force = false) => {
    const key = `${notice.status}|${notice.stage ?? ""}|${
      notice.progress ? `${notice.progress.done}/${notice.progress.total}` : ""
    }`;
    const isPhaseEnd = notice.progress
      ? notice.progress.done >= notice.progress.total
      : false;
    const nowMs = Date.now();
    if (!force && !isPhaseEnd && (key === lastKey || nowMs - lastAt < 2500)) return;
    lastKey = key;
    lastAt = nowMs;
    try {
      await target.show(notice);
    } catch {
      /* فشل تحديث البطاقة لا يُفشل الدمج */
    }
  };
}

type MergeRequest =
  | { type: "zip"; url: string; name: string; zipPath?: string }
  | { type: "drive"; id: string };

/** يشغّل عملية دمج كاملة أمام بطاقة حية واحدة من أول فحص إلى رابط النتيجة. */
async function startManualMerge(
  target: MergeCardTarget,
  request: MergeRequest,
  requester: Requester
) {
  const mergeId = randomUUID();
  const token: ManualMergeCancelToken = { cancelled: false };
  let stage: MergeStage = "validate";
  let label: string | null = null;
  let imageCount: number | undefined;
  let mergedCount: number | undefined;
  activeMergeJobs.set(mergeId, { requesterId: requester.id, token });
  const post = createMergeProgressPoster(target);
  let attachDir: string | null = null;
  try {
    await target.show({ mergeId, status: "pending", stage });

    let effectiveRequest: MergeRequest = request;
    if (request.type === "zip") {
      // تنزيل مرفق Discord إلى القرص عبر بث مباشر (لا شيء في الذاكرة).
      stage = "fetch";
      await post(
        { mergeId, status: "downloading", stage, progress: { done: 0, total: 1 } },
        true
      );
      attachDir = await mkdtemp(path.join(tmpdir(), "merge-attach-"));
      const zipPath = path.join(attachDir, "attachment-archive");
      await downloadHttpsToPath(request.url, zipPath, 250 * 1024 * 1024);
      await post(
        { mergeId, status: "downloading", stage, progress: { done: 1, total: 1 } },
        true
      );
      effectiveRequest = { type: "zip", url: "", name: request.name, zipPath };
    }

    const result = await runManualMerge(
      effectiveRequest.type === "zip"
        ? { kind: "zip", zipPath: effectiveRequest.zipPath!, title: effectiveRequest.name }
        : { kind: "drive", id: effectiveRequest.id },
      {
        onEvent: async event => {
          if (event.phase === "fetch") {
            stage = "fetch";
            await post({
              mergeId,
              status: "downloading",
              stage,
              progress: { done: event.done, total: event.total },
            });
          } else if (event.phase === "merge") {
            stage = "merge";
            await post({
              mergeId,
              status: "downloading",
              stage,
              progress: { done: event.done, total: event.total },
            });
          } else {
            stage = "upload";
            await post({
              mergeId,
              status: "uploading",
              stage,
              progress: { done: event.done, total: event.total },
            });
          }
        },
        isCancelled: () => token.cancelled,
      }
    );
    imageCount = result.imageCount;
    mergedCount = result.mergedCount;
    label = `**${result.title}** — ${result.mergedCount} صورة طويلة من ${result.imageCount} صورة`;
    await target.show(
      {
        mergeId,
        status: "completed",
        stage: "upload",
        mergedCount: result.mergedCount,
        imageCount: result.imageCount,
        label,
        driveUrl: result.driveUrl,
      },
      { requesterId: requester.id }
    );
  } catch (error) {
    if (error instanceof ManualMergeCancelled) {
      await target
        .show(
          {
            mergeId,
            status: "cancelled",
            stage,
            label,
            imageCount,
            mergedCount,
            detail: "أوقفتَ هذه العملية من زر الإلغاء.",
          },
          { requesterId: requester.id }
        )
        .catch(() => undefined);
      return;
    }
    const detail =
      error instanceof GoogleDriveError || error instanceof Error
        ? error.message
        : "حدث خطأ غير معروف أثناء الدمج.";
    console.warn("[Discord] Manual merge failed", error);
    await target
      .show(
        { mergeId, status: "failed", stage, label, imageCount, mergedCount, detail },
        { requesterId: requester.id }
      )
      .catch(() => undefined);
  } finally {
    if (attachDir) {
      await rm(attachDir, { recursive: true, force: true }).catch(() => undefined);
    }
    activeMergeJobs.delete(mergeId);
  }
}

async function replyMerge(interaction: any) {
  await interaction.deferReply();
  try {
    if (!(await hasRequestAccess(interaction))) {
      await interaction.editReply(
        mergeCardPayload({
          status: "failed",
          title: "🔒 لا تملك صلاحية",
          detail: "هذا الأمر متاح لأدوار محددة فقط.",
        })
      );
      return;
    }
    const attachment = interaction.options.getAttachment("الملف", false);
    const rawUrl = interaction.options.getString("الرابط", false)?.trim();
    const requester: Requester = {
      id: interaction.user.id,
      username: interaction.user.username,
      channelId: interaction.channelId,
    };

    // بلا ملف ولا رابط: لوحة طلب المدخلات بنفس نمط /فصل التفاعلي.
    if (!attachment && !rawUrl) {
      const key = `${interaction.channelId}:${interaction.user.id}`;
      clearMergePrompt(key);
      const promptMessage = await interaction.editReply(
        panelPayload(buildMergePromptComponents())
      );
      const timer = setTimeout(() => {
        pendingMergePrompts.delete(key);
        void editMessageContent(
          interaction.channelId,
          promptMessage.id,
          mergeCardPayload({
            status: "info",
            title: "⏳ انتهت مهلة الإرسال",
            detail: "نفّذ /دمج مرة أخرى ثم أرفق ملف ZIP/CBZ أو أرسل رابط مجلد Drive.",
          })
        ).catch(() => undefined);
      }, PROMPT_TIMEOUT_MS);
      timer.unref?.();
      pendingMergePrompts.set(key, { timer });
      return;
    }

    if (attachment) {
      if (!isSupportedArchiveName(attachment.name)) {
        await interaction.editReply(
          mergeCardPayload({
            status: "failed",
            title: "❌ الملف المرفق غير مدعوم",
            detail: "المدعوم: ملف ZIP أو CBZ يحتوي صور الفصل، أو رابط مجلد Google Drive.",
          })
        );
        return;
      }
      await startManualMerge(
        mergeInteractionCard(interaction),
        { type: "zip", url: attachment.url, name: attachment.name ?? "أرشيف" },
        requester
      );
      return;
    }

    const link = parseDriveLink(rawUrl!);
    if (!link) {
      await interaction.editReply(
        mergeCardPayload({
          status: "failed",
          title: "❌ الرابط غير مدعوم",
          detail:
            "أرسل رابط مجلد Google Drive يحتوي صور الفصل (المشاركة: أي شخص لديه الرابط)، أو أعد المحاولة مع إرفاق ملف ZIP/CBZ.",
        })
      );
      return;
    }
    await startManualMerge(
      mergeInteractionCard(interaction),
      { type: "drive", id: link.id },
      requester
    );
  } catch (error) {
    const detail =
      error instanceof GoogleDriveError
        ? error.message
        : "تعذر بدء الدمج، تحقق من المدخلات ثم أعد المحاولة.";
    console.warn("[Discord] /دمج failed", error);
    await interaction
      .editReply(
        mergeCardPayload({ status: "failed", title: "❌ تعذر بدء الدمج", detail })
      )
      .catch(() => undefined);
  }
}

async function handleMergeCancelButton(interaction: any) {
  await interaction.deferUpdate();
  const mergeId = interaction.customId.split(":")[2];
  const entry = activeMergeJobs.get(mergeId);
  if (!entry) return;
  if (
    !isOwner(interaction.user.id) &&
    entry.requesterId !== interaction.user.id
  )
    return;
  // يوقف خط الدمج عند أقرب نقطة فحص، والبطاقة تُحدَّث إلى الحالة النهائية
  // من مسار الدمج نفسه — بلا رسالة ثانية ولا تعارض كتابة.
  entry.token.cancelled = true;
}

async function replyHelp(interaction: any) {
  await interaction.deferReply();
  await interaction.editReply(panelPayload(buildHelpComponents()));
}

async function replyChapter(interaction: any) {
  await interaction.deferReply();
  try {
    if (!(await hasRequestAccess(interaction))) {
      await interaction.editReply(
        cardPayload({
          status: "failed",
          title: "🔒 لا تملك صلاحية",
          detail: "هذا الأمر متاح لأدوار محددة فقط.",
        })
      );
      return;
    }
    const url = interaction.options.getString("الرابط", false);
    if (!url) {
      const key = `${interaction.channelId}:${interaction.user.id}`;
      clearPrompt(key);
      const promptMessage = await interaction.editReply(
        panelPayload(buildPromptComponents())
      );
      const timer = setTimeout(() => {
        pendingChapterPrompts.delete(key);
        void editMessageContent(
          interaction.channelId,
          promptMessage.id,
          cardPayload({
            status: "info",
            title: "⏳ انتهت مهلة الإرسال",
            detail: "نفّذ /فصل مرة أخرى وأرسل رابط الفصل.",
          })
        ).catch(() => undefined);
      }, PROMPT_TIMEOUT_MS);
      timer.unref?.();
      pendingChapterPrompts.set(key, { timer });
      return;
    }
    await startChapterFromUrl(interactionCard(interaction), url, {
      id: interaction.user.id,
      username: interaction.user.username,
      channelId: interaction.channelId,
    });
  } catch (error) {
    const detail =
      error instanceof UrlPolicyError
        ? error.message
        : "تعذر قبول الرابط، تحقق منه ثم أعد المحاولة.";
    await interaction
      .editReply(
        cardPayload({ status: "failed", title: "❌ تعذر بدء السحب", detail })
      )
      .catch(() => undefined);
  }
}

async function handleButton(interaction: any) {
  if (interaction.customId.startsWith("merge:cancel:"))
    return void handleMergeCancelButton(interaction);
  if (!interaction.customId.startsWith("job:cancel:")) return;
  await interaction.deferUpdate();
  const job = await getChapterJob(interaction.customId.split(":")[2]);
  if (
    !job ||
    (!isOwner(interaction.user.id) &&
      job.requestedByDiscordId !== interaction.user.id)
  )
    return;
  try {
    const cancelled = await cancelChapterJob(job.id);
    await addJobAttempt(
      job.id,
      "cancelled",
      `أوقف ${interaction.user.username} العملية من Discord.`
    );
    await updateJobProgressMessage(
      cancelled.requestedInChannelId,
      cancelled.discordProgressMessageId,
      noticeFromJob(cancelled)
    );
  } catch (error) {
    console.warn("[Discord] Could not cancel job", error);
  }
}

export async function startDiscordBot() {
  if (
    started ||
    !ENV.discordBotToken ||
    !ENV.discordApplicationId ||
    !ENV.discordGuildId
  )
    return;
  started = true;
  client = new Client({
    intents: [
      GatewayIntentBits.Guilds,
      GatewayIntentBits.GuildMessages,
      GatewayIntentBits.MessageContent,
    ],
  });
  client.once(Events.ClientReady, async ready => {
    console.info(`[Discord] Connected as ${ready.user.tag}`);
    ready.user.setPresence({
      status: "online",
      activities: [{ name: BOT_PRESENCE, type: ActivityType.Watching }],
    });
    // هوية البوت: ZEUS.
    if (ready.user.username !== BOT_USERNAME) {
      await ready.user
        .setUsername(BOT_USERNAME)
        .then(() => console.info("[Discord] Username set to ZEUS"))
        .catch(error =>
          console.warn("[Discord] Could not set username", error)
        );
    }
    // صورة البوت: شعار ZEUS، تُضبط مرة واحدة فقط لتجنب حدود المعدل.
    try {
      const applied = await getSetting("discord_avatar_applied");
      if (!applied) {
        await ready.user.setAvatar(ZEUS_AVATAR_BASE64);
        await setSetting("discord_avatar_applied", "1");
        console.info("[Discord] Avatar set to the ZEUS logo");
      }
    } catch (error) {
      console.warn("[Discord] Could not set avatar", error);
    }
    // Registering guild commands can fail with DiscordAPIError[50001]
    // "Missing Access" when the bot was invited only with the `bot` scope.
    // Re-authorizing the app with the `applications.commands` scope fixes it,
    // so retry a few times instead of giving up after a single attempt.
    const maxAttempts = 6;
    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      try {
        await refreshDiscordCommands();
        console.info(
          `[Discord] Guild commands refreshed (${commandPayload.length})`
        );
        await saveIntegrationHealth(
          "discord",
          "healthy",
          `البوت متصل وحُدّثت ${commandPayload.length} أوامر.`
        );
        break;
      } catch (error) {
        const missingAccess = (error as { code?: number })?.code === 50001;
        console.error(
          "[Discord] Command registration attempt " +
            attempt +
            "/" +
            maxAttempts +
            " failed",
          error
        );
        if (attempt === maxAttempts) break;
        if (missingAccess) {
          console.warn(
            "[Discord] Missing Access: أعِد دعوة التطبيق إلى السيرفر مع نطاق applications.commands. سنعيد المحاولة بعد 30 ثانية."
          );
        }
        await new Promise(resolve => setTimeout(resolve, 30_000));
      }
    }
  });
  client.on(Events.InteractionCreate, async interaction => {
    try {
      if (interaction.isButton()) return void handleButton(interaction);
      if (!interaction.isChatInputCommand()) return;
      if (interaction.commandName === "مساعدة") await replyHelp(interaction);
      else if (interaction.commandName === "فصل")
        await replyChapter(interaction);
      else if (interaction.commandName === "دمج")
        await replyMerge(interaction);
    } catch (error) {
      console.error("[Discord] Interaction handler failed", error);
      if (interaction.isRepliable()) {
        if (interaction.deferred || interaction.replied) {
          await interaction
            .editReply({ content: "تعذر تنفيذ الأمر الآن.", components: [] })
            .catch(() => undefined);
        } else {
          await interaction
            .reply({ content: "تعذر تنفيذ الأمر الآن." })
            .catch(() => undefined);
        }
      }
    }
  });
  client.on(Events.MessageCreate, async message => {
    if (message.author.bot || !message.guild) return;
    const key = `${message.channelId}:${message.author.id}`;
    // أولاً: طلبات الدمج المعلقة — مرفق ZIP/CBZ أو رابط Drive في رسالة عادية.
    if (pendingMergePrompts.has(key)) {
      const archive = Array.from(message.attachments.values()).find(item =>
        isSupportedArchiveName(item.name)
      );
      const driveLink = message.content.trim()
        ? parseDriveLink(message.content.trim())
        : null;
      if (archive || driveLink) {
        clearMergePrompt(key);
        const card = mergeMessageCard(message);
        const requester: Requester = {
          id: message.author.id,
          username: message.author.username,
          channelId: message.channelId,
        };
        try {
          if (archive) {
            await startManualMerge(
              card,
              { type: "zip", url: archive.url, name: archive.name ?? "أرشيف" },
              requester
            );
          } else {
            await startManualMerge(
              card,
              { type: "drive", id: driveLink!.id },
              requester
            );
          }
        } catch (error) {
          const detail =
            error instanceof GoogleDriveError || error instanceof Error
              ? error.message
              : "تعذر بدء الدمج.";
          await card
            .show({ status: "failed", title: "❌ تعذر بدء الدمج", detail })
            .catch(() => undefined);
        }
        return; // الرسالة استُهلكت لعملية الدمج.
      }
      // ليست مدخل دمج صالحًا — يبقى منطق طلب الفصل العادي يعمل إن وُجد.
    }
    if (!pendingChapterPrompts.has(key)) return;
    const content = message.content.trim();
    if (!/^https:\/\//i.test(content)) return;
    clearPrompt(key);
    const card = messageCard(message);
    try {
      await startChapterFromUrl(card, content, {
        id: message.author.id,
        username: message.author.username,
        channelId: message.channelId,
      });
    } catch (error) {
      const detail =
        error instanceof UrlPolicyError ? error.message : "تعذر قبول الرابط.";
      await card
        .show({ status: "failed", title: "❌ تعذر بدء السحب", detail })
        .catch(() => undefined);
    }
  });
  client.on(Events.Error, error => {
    console.error("[Discord] Client error", error);
    void saveIntegrationHealth(
      "discord",
      "offline",
      "تعرض اتصال Discord لخطأ."
    );
  });
  await client.login(ENV.discordBotToken);
}

// ============================================================
// تحديثات بطاقة المتابعة من العامل
// ============================================================

export async function updateJobProgressMessage(
  channelId: string | null,
  messageId: string | null,
  notice: JobNotice,
  options?: JobCardOptions
) {
  if (!client || !channelId || !messageId) return;
  const found = await client.channels.fetch(channelId);
  if (!found?.isTextBased() || !("messages" in found)) return;
  try {
    await found.messages.edit(messageId, cardPayload(notice, options) as never);
  } catch (error) {
    console.warn(
      `[Discord] Could not update progress message ${messageId}`,
      error
    );
  }
}

/**
 * تحديث حالة المهمة: البطاقة الحية الواحدة هي كل شيء، وتُحدَّث حتى النتيجة
 * النهائية داخل نفسها (الرابط وزر الفتح) بلا أي رسالة ثانية مكررة.
 */
export async function sendJobUpdate(
  channelId: string | null,
  requesterId: string,
  notice: JobNotice
) {
  const job = notice.jobId ? await getChapterJob(notice.jobId) : undefined;
  const options: JobCardOptions = TERMINAL_STATUSES.includes(notice.status)
    ? { requesterId }
    : {};
  await updateJobProgressMessage(
    channelId,
    job?.discordProgressMessageId ?? null,
    notice,
    options
  );
}

export async function sendOwnerAlert(message: string) {
  if (!client || !ENV.ownerDiscordUserId) return;
  const owner = await client.users.fetch(ENV.ownerDiscordUserId);
  await owner.send({ content: `## تنبيه\n${message}` });
}
