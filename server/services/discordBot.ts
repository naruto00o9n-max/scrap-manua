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
  getSourceBySuwayomiId,
  listActiveDiscordRoleIds,
  listSources,
  saveSource,
  saveIntegrationHealth,
  setDiscordProgressMessage,
  setSetting,
} from "../db";
import type { ContentSource } from "../../shared/dbTypes";
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
import {
  checkChapterAvailability,
  chapterUrlFromParts,
  parseChapterNumber,
  searchAllSources,
  type SearchMatch,
} from "./sourceSearch";
import { hostnameFromHomeUrl, syncSourcesFromSuwayomi } from "./sourceSync";
import { SuwayomiClient } from "./suwayomi";
import { UrlPolicyError } from "./urlPolicy";
import { getUsableSuwayomiToken } from "./settings";

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
  validate: "فحص الرابط والموقع",
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
    .setName("مواقع")
    .setDescription("عرض المواقع المتاحة في البوت"),
  new SlashCommandBuilder()
    .setName("بحث")
    .setDescription("البحث عن أي عمل في كل المواقع وفحص توفر الفصول")
    .addStringOption(option =>
      option
        .setName("الاسم")
        .setDescription("اسم العمل أو كلمة من اسمه")
        .setRequired(true)
    )
    .addStringOption(option =>
      option
        .setName("الفصل")
        .setDescription("رقم فصل لفحص توفره في كل المواقع — اختياري")
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
        "يسحب فصلًا من المواقع المدعومة ويسلّمك رابطه.",
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
    text(
      [
        "### 🔹 /مواقع",
        "يعرض كل المواقع المتاحة في البوت — أي موقع يُضاف للبوت يظهر هنا تلقائيًا ⚡.",
      ].join("\n")
    ),
    separator(),
    text(
      [
        "### 🔹 /بحث",
        "يبحث عن أي عمل في كل المواقع دفعة واحدة، بدل الدخول لكل موقع والبحث فيه يدويًا.",
        "**1.** نفّذ `/بحث` واكتب اسم العمل (وكلمة واحدة تكفي) — يبحث في كل المواقع ويعرض المطابقات موقعًا بموقع، ولو كثرت النتائج تنقّل بين الصفحات بالأزرار.",
        "**2.** اختر عملًا من القائمة المنسدلة لتعرض فصوله (صفحة صفحة مهما كثرت)، ثم اختر فصلًا ليُسحب ويُدمج ويُرفع Drive كأمر /فصل تمامًا.",
        "**3.** لو تريد معرفة هل الفصل نزل أو لا: ضع رقم الفصل في خانة «الفصل» — سيفحصه في كل المواقع ويعرض فقط المواقع التي وُجد فيه.",
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

// ============================================================
// تدفق الأوامر الجديدة: /مصادر و /بحث — مسار مستقل كليًا عن
// /فصل و /دمج، ولا يعدّل أي سلوك قائم. الطلب النهائي للسحب
// يُسلَّم لنفس خط /فصل الموجود عبر startChapterFromUrl.
// ============================================================

export type SearchNoticeState =
  | "progress"
  | "results"
  | "availability"
  | "chapters"
  | "failed";

export type SearchNotice = {
  state: SearchNoticeState;
  query?: string;
  progress?: { done: number; total: number };
  failedCount?: number;
  resultCount?: number;
  matches?: Array<{ title: string; sourceName: string; lang: string }>;
  chapterNumber?: number;
  /** صفوف التوفر المعروضة: النتائج الإيجابية فقط — المتعثر أو غير المتاح لا يُعرض أبدًا. */
  availability?: Array<{
    ok: boolean;
    sourceName: string;
    title: string;
    detail: string | null;
    failed?: boolean;
  }>;
  anyAvailable?: boolean;
  mangaTitle?: string;
  sourceName?: string;
  totalChapters?: number;
  chaptersShown?: number;
  /** ترقيم صفحات القائمة المعروضة (نتائج البحث أو الفصول) — 1-based للعرض. */
  page?: number;
  totalPages?: number;
  detail?: string | null;
};

export type SearchSelectSpec = {
  customId: string;
  placeholder: string;
  options: Array<{ label: string; description?: string; value: string }>;
};

const SEARCH_SELECT_TYPES = { ROW: 1, STRING_SELECT: 3 } as const;

/** حد Discord الأقصى لخيارات القائمة المنسدلة الواحدة — ما زاد يُصفّح بأزرار. */
export const SEARCH_PAGE_SIZE = 25;
/** عدد نتائج معاينة النص فوق القائمة — القائمة نفسها تعرض صفحتها كاملة. */
const SEARCH_PREVIEW_LIMIT = 8;

/**
 * تُقسّم قائمة إلى صفحات بحجم حد Discord، وتُثبّت رقم الصفحة داخل المدى الصالح.
 * start هو إزاحة أول عنصر في الصفحة داخل القائمة الأصلية (لأُسامة القيم عالميًا).
 */
export function paginateForSelect<T>(items: T[], page: number) {
  const totalPages = Math.max(1, Math.ceil(items.length / SEARCH_PAGE_SIZE));
  const current = Math.min(Math.max(0, page), totalPages - 1);
  const start = current * SEARCH_PAGE_SIZE;
  return {
    slice: items.slice(start, start + SEARCH_PAGE_SIZE),
    page: current,
    totalPages,
    start,
  };
}

/**
 * صف أزرار التنقل بين الصفحات: السابق / مؤشر الصفحة / التالي.
 * زر المؤشر معطّل دائمًا — عرض فقط. يُرجع null لو لا توجد إلا صفحة واحدة.
 */
export function buildSearchPageNavRow(
  kind: "page" | "cpage",
  searchId: string,
  page: number,
  totalPages: number
): Raw | null {
  if (totalPages <= 1) return null;
  return {
    type: 1,
    components: [
      {
        type: 2,
        style: 2,
        label: "السابق",
        emoji: { name: "◀" },
        custom_id: `search:${kind}:${searchId}:prev`,
        disabled: page <= 0,
      },
      {
        type: 2,
        style: 2,
        label: `صفحة ${page + 1} من ${totalPages}`,
        disabled: true,
      },
      {
        type: 2,
        style: 2,
        label: "التالي",
        emoji: { name: "▶" },
        custom_id: `search:${kind}:${searchId}:next`,
        disabled: page >= totalPages - 1,
      },
    ],
  };
}

/** صف قائمة منسدلة — النوع 3 مسموح داخل الصف (1) في رسائل Components V2. */
export function buildSearchSelectRow(spec: SearchSelectSpec): Raw {
  return {
    type: SEARCH_SELECT_TYPES.ROW,
    components: [
      {
        type: SEARCH_SELECT_TYPES.STRING_SELECT,
        custom_id: spec.customId,
        placeholder: spec.placeholder.slice(0, 150),
        options: spec.options.slice(0, 25).map(option => ({
          label: option.label.slice(0, 100) || "—",
          description: option.description?.slice(0, 100),
          value: option.value.slice(0, 100),
        })),
      },
    ],
  };
}

function searchStateTitle(state: SearchNoticeState): string {
  switch (state) {
    case "progress":
      return "🔍 جاري البحث في كل المواقع";
    case "results":
      return "🔎 نتائج البحث";
    case "availability":
      return "🔢 فحص توفر الفصل في كل المواقع";
    case "chapters":
      return "📚 فصول العمل";
    case "failed":
      return "❌ البحث";
  }
}

/** صياغة عدد المواقع عربيًا بعد حرف الجر (إلى/في): موقع واحد، موقعين، مواقع… */
export function sitesCount(count: number): string {
  if (count === 1) return "موقع واحد";
  if (count === 2) return "موقعين";
  if (count <= 10) return `${count} مواقع`;
  return `${count} موقعًا`;
}

export function buildSearchCardComponents(
  notice: SearchNotice,
  select?: SearchSelectSpec | null,
  avatar: string | null = avatarUrl(),
  nav?: Raw | null
): APIMessageTopLevelComponent[] {
  const body: Raw[] = [
    headerBlock(`## ${searchStateTitle(notice.state)}`, [], avatar),
    separator(2),
  ];

  if (notice.state === "progress") {
    const progress = notice.progress ?? { done: 0, total: 0 };
    body.push(
      text(
        [
          `**«${notice.query ?? ""}»**`,
          progressBar(progress.done, progress.total),
          `-# ${progress.done}/${progress.total} موقع${notice.failedCount ? ` — تعذر الوصول إلى ${sitesCount(notice.failedCount)}` : ""}`,
        ].join("\n")
      )
    );
  } else if (notice.state === "results") {
    const lines: string[] = [
      `نتائج البحث عن **«${notice.query ?? ""}»** — ${notice.resultCount ?? 0} نتيجة${notice.failedCount ? ` (تعذر الوصول إلى ${sitesCount(notice.failedCount)})` : ""}`,
    ];
    const matches = notice.matches ?? [];
    for (let index = 0; index < matches.length; index += 1) {
      const match = matches[index]!;
      const number = ((notice.page ?? 1) - 1) * SEARCH_PAGE_SIZE + index + 1;
      lines.push(`**${number}. ${match.title}**\n-# ${match.sourceName} (${match.lang})`);
    }
    if ((notice.totalPages ?? 1) > 1) {
      lines.push(
        `-# الصفحة ${notice.page ?? 1} من ${notice.totalPages} — القائمة المنسدلة تعرض نتائج هذه الصفحة كاملة، وتنقّل بالأزرار.`
      );
    }
    body.push(text(lines.join("\n")));
  } else if (notice.state === "availability") {
    const lines: string[] = [
      `**«${notice.query ?? ""}»** — الفصل ${notice.chapterNumber ?? "?"}`,
      "",
    ];
    // النتائج الإيجابية فقط: الموقع الذي وُجد فيه الفصل يُعرض، وما تعثر أو
    // لم يقدّمه لا يظهر إطلاقًا.
    for (const row of notice.availability ?? []) {
      lines.push(`• **${row.sourceName}** — ${row.title}${row.detail ? `\n-# ${row.detail}` : ""}`);
    }
    if (notice.detail) lines.push("", notice.detail);
    body.push(text(lines.join("\n")));
  } else if (notice.state === "chapters") {
    const pageInfo = (notice.totalPages ?? 1) > 1 ? ` — الصفحة ${notice.page ?? 1} من ${notice.totalPages}` : "";
    body.push(
      text(
        [
          `**${notice.mangaTitle ?? ""}**`,
          `-# الموقع: ${notice.sourceName ?? "—"} — ${notice.totalChapters ?? 0} فصلًا${pageInfo}. اختر فصلًا ليُسحب ويُدمج ويُرفع إلى Drive.`,
        ].join("\n")
      )
    );
  } else {
    body.push(
      text(
        notice.detail ??
          "لم يتم العثور على نتائج. جرّب اسمًا آخر أو كتابة مختلفة."
      )
    );
  }

  body.push(separator());
  if (select && select.options.length) body.push(buildSearchSelectRow(select));
  if (nav) body.push(nav);
  if ((select && select.options.length) || nav) body.push(separator());
  body.push(text("-# ZEUS"));
  return [raw({ type: 17, accent_color: GOLD, components: body })];
}

export function buildSourcesComponents(
  active: ContentSource[],
  totalCount: number,
  avatar: string | null = avatarUrl()
): APIMessageTopLevelComponent[] {
  const lines: string[] = [
    `**${active.length}** ${active.length === 1 ? "موقع متاح" : "مواقع متاحة"} من إجمالي ${totalCount} مسجل.`,
    "كل موقع يُضاف للبوت يظهر هنا تلقائيًا، ويُستخدم عبر /بحث مباشرة.",
    "",
  ];
  const shown = active.slice(0, 40);
  for (const source of shown) {
    lines.push(
      `• **${source.name}** — ${source.hostname && !source.hostname.endsWith(".internal") ? source.hostname : "عبر /بحث"}${source.origin === "suwayomi" ? " ⚡" : ""}`
    );
  }
  if (active.length > shown.length) {
    lines.push(`-# و${active.length - shown.length} موقعًا آخر…`);
  }
  const body: Raw[] = [
    headerBlock("## 🗂️ مواقع ZEUS", [], avatar),
    separator(2),
    text(lines.join("\n")),
    separator(),
    text("-# ⚡ مُضاف تلقائيًا — ZEUS"),
  ];
  return [raw({ type: 17, accent_color: GOLD, components: body })];
}

function searchCardPayload(notice: SearchNotice, select?: SearchSelectSpec | null, nav?: Raw | null) {
  return {
    flags: MessageFlags.IsComponentsV2 as MessageFlags.IsComponentsV2,
    components: buildSearchCardComponents(notice, select, avatarUrl(), nav),
  };
}

type SearchCardTarget = {
  show: (notice: SearchNotice, select?: SearchSelectSpec | null, nav?: Raw | null) => Promise<string>;
};

function searchInteractionCard(interaction: any): SearchCardTarget {
  let messageId: string | null = null;
  const channelId = interaction.channelId as string;
  return {
    show: async (notice, select, nav) => {
      if (!messageId) {
        const sent = await interaction.editReply(searchCardPayload(notice, select, nav));
        messageId = String(sent.id);
        return messageId;
      }
      await editMessageContent(channelId, messageId, searchCardPayload(notice, select, nav));
      return messageId;
    },
  };
}

function createSearchProgressPoster(target: SearchCardTarget) {
  let lastKey = "";
  let lastAt = 0;
  return async (notice: SearchNotice, select?: SearchSelectSpec | null, force = false, nav?: Raw | null) => {
    const key = `${notice.state}|${notice.progress ? `${notice.progress.done}/${notice.progress.total}` : ""}`;
    const isPhaseEnd = notice.progress
      ? notice.progress.done >= notice.progress.total
      : notice.state !== "progress";
    const nowMs = Date.now();
    if (!force && !isPhaseEnd && (key === lastKey || nowMs - lastAt < 2500)) return;
    lastKey = key;
    lastAt = nowMs;
    try {
      await target.show(notice, select, nav);
    } catch {
      /* فشل تحديث البطاقة لا يُفشل البحث */
    }
  };
}

export type SearchSessionView = "results" | "availability" | "chapters";

type SearchSession = {
  requesterId: string;
  channelId: string;
  createdAt: number;
  /** كل نتائج البحث — القائمة المنسدلة تعرضها صفحة صفحة عبر أزرار التنقل. */
  matches: SearchMatch[];
  chapters: Array<{
    label: string;
    url: string;
    realUrl: string | null;
    number: number | null;
  }>;
  /** العرض الحالي الذي تُبنى منه البطاقة عند التنقل بين الصفحات. */
  view: SearchSessionView;
  matchPage: number;
  chapterPage: number;
  query: string;
  failedCount: number;
  chapterNumber: number | null;
  availability?: SearchNotice["availability"];
  anyAvailable?: boolean;
  mangaTitle?: string;
  sourceName?: string;
  suwayomiSourceId?: string;
  matchUrl?: string;
  matchRealUrl?: string | null;
};

const SEARCH_SESSION_TTL_MS = 30 * 60 * 1000;
const activeSearchSessions = new Map<string, SearchSession>();

function scheduleSearchSessionCleanup(searchId: string) {
  setTimeout(() => activeSearchSessions.delete(searchId), SEARCH_SESSION_TTL_MS).unref?.();
}

function searchRequesterOf(interaction: any): Requester {
  return {
    id: interaction.user.id,
    username: interaction.user.username,
    channelId: interaction.channelId,
  };
}

/**
 * يبني حالة العرض (البطاقة + القائمة المنسدلة + أزرار الصفحات) من الجلسة
 * في حالتها الحالية — يستخدم في العرض الأول وفي التنقل وإعادة الرسم.
 */
function buildSearchSessionView(
  session: SearchSession,
  searchId: string
): { notice: SearchNotice; select: SearchSelectSpec | null; nav: Raw | null } {
  if (session.view === "chapters") {
    const pagination = paginateForSelect(session.chapters, session.chapterPage);
    return {
      notice: {
        state: "chapters",
        mangaTitle: session.mangaTitle,
        sourceName: session.sourceName,
        totalChapters: session.chapters.length,
        chaptersShown: pagination.slice.length,
        page: pagination.page + 1,
        totalPages: pagination.totalPages,
      },
      select: {
        customId: `search:chap:${searchId}`,
        placeholder: "اختر فصلًا لسحبه ودمجه ورفعه…",
        options: pagination.slice.map((chapter, index) => ({
          label: chapter.label,
          description: "سحب هذا الفصل وتسليمه على Drive",
          value: String(pagination.start + index),
        })),
      },
      nav: buildSearchPageNavRow("cpage", searchId, pagination.page, pagination.totalPages),
    };
  }

  const pagination = paginateForSelect(session.matches, session.matchPage);
  if (session.view === "availability") {
    return {
      notice: {
        state: "availability",
        query: session.query,
        chapterNumber: session.chapterNumber ?? undefined,
        availability: session.availability,
        anyAvailable: session.anyAvailable,
        failedCount: session.failedCount,
        page: pagination.page + 1,
        totalPages: pagination.totalPages,
        detail: session.anyAvailable
          ? "اختر عملًا من القائمة لعرض فصوله وسحب الفصل مباشرة."
          : "هذا الرقم غير متاح بعد في أي موقع مطابق — قد ينزل قريبًا، جرّب من جديد لاحقًا.",
      },
      select: session.anyAvailable
        ? {
            customId: `search:pick:${searchId}`,
            placeholder: "اختر عملًا لعرض فصوله أو سحبه…",
            options: pagination.slice.map((match, index) => ({
              label: match.title,
              description: `${match.sourceName} (${match.lang})`,
              value: String(pagination.start + index),
            })),
          }
        : null,
      nav: session.anyAvailable
        ? buildSearchPageNavRow("page", searchId, pagination.page, pagination.totalPages)
        : null,
    };
  }

  return {
    notice: {
      state: "results",
      query: session.query,
      resultCount: session.matches.length,
      failedCount: session.failedCount,
      page: pagination.page + 1,
      totalPages: pagination.totalPages,
      matches: pagination.slice.slice(0, SEARCH_PREVIEW_LIMIT).map(match => ({
        title: match.title,
        sourceName: match.sourceName,
        lang: match.lang,
      })),
    },
    select: {
      customId: `search:pick:${searchId}`,
      placeholder: "اختر عملًا لعرض فصوله أو سحبه…",
      options: pagination.slice.map((match, index) => ({
        label: match.title,
        description: `${match.sourceName} (${match.lang})`,
        value: String(pagination.start + index),
      })),
    },
    nav: buildSearchPageNavRow("page", searchId, pagination.page, pagination.totalPages),
  };
}

async function showSearchSessionView(interaction: any, session: SearchSession, searchId: string) {
  const view = buildSearchSessionView(session, searchId);
  await editMessageContent(
    interaction.channelId,
    interaction.message.id,
    searchCardPayload(view.notice, view.select, view.nav)
  );
}

async function replySources(interaction: any) {
  await interaction.deferReply();
  try {
    // مزامنة فورية حتى يظهر أي موقع أُضيف حديثًا بلا انتظار الدورة.
    await syncSourcesFromSuwayomi();
    const sources = await listSources();
    const active = sources.filter(source => source.status === "active");
    await interaction.editReply(
      panelPayload(buildSourcesComponents(active, sources.length))
    );
  } catch (error) {
    console.warn("[Discord] /مواقع failed", error);
    await interaction
      .editReply(
        panelPayload(
          buildSearchCardComponents({
            state: "failed",
            detail: "تعذر قراءة قائمة المواقع الآن — أعد المحاولة بعد قليل.",
          })
        )
      )
      .catch(() => undefined);
  }
}

async function replySearch(interaction: any) {
  await interaction.deferReply();
  try {
    if (!(await hasRequestAccess(interaction))) {
      await interaction.editReply(
        searchCardPayload({
          state: "failed",
          detail: "🔒 هذا الأمر متاح لأدوار محددة فقط.",
        })
      );
      return;
    }
    const query = (interaction.options.getString("الاسم", false) ?? "").trim();
    const chapterInput = interaction.options.getString("الفصل", false);
    const chapterNumber = parseChapterNumber(chapterInput);
    if (!query) {
      await interaction.editReply(
        searchCardPayload({
          state: "failed",
          detail: "اكتب اسم المانها في خانة «الاسم» ثم أعد المحاولة.",
        })
      );
      return;
    }
    if (chapterInput && chapterNumber === null) {
      await interaction.editReply(
        searchCardPayload({
          state: "failed",
          detail: `«${chapterInput}» ليس رقم فصل صالحًا. اكتبه أرقامًا مثل: 38`,
        })
      );
      return;
    }

    await syncSourcesFromSuwayomi().catch(() => null);
    const suwayomi = new SuwayomiClient(
      ENV.suwayomiBaseUrl,
      getUsableSuwayomiToken()
    );
    const installed = await suwayomi.listInstalledSources();
    if (!installed.length) {
      await interaction.editReply(
        searchCardPayload({
          state: "failed",
          detail: "لا توجد مواقع متاحة بعد — أضف موقعًا واحدًا على الأقل ثم أعد المحاولة.",
        })
      );
      return;
    }

    await runSearchFlow(
      searchInteractionCard(interaction),
      suwayomi,
      installed.map(source => ({
        suwayomiSourceId: source.id,
        name: source.displayName || source.name,
        lang: source.lang,
      })),
      { query, chapterNumber },
      searchRequesterOf(interaction)
    );
  } catch (error) {
    console.warn("[Discord] /بحث failed", error);
    await interaction
      .editReply(
        searchCardPayload({
          state: "failed",
          detail: "تعذر تنفيذ البحث الآن — أعد المحاولة بعد قليل.",
        })
      )
      .catch(() => undefined);
  }
}

async function runSearchFlow(
  target: SearchCardTarget,
  searcher: SuwayomiClient,
  sources: Array<{ suwayomiSourceId: string; name: string; lang: string }>,
  request: { query: string; chapterNumber: number | null },
  requester: Requester
) {
  const searchId = randomUUID();
  const post = createSearchProgressPoster(target);
  await target.show(
    {
      state: "progress",
      query: request.query,
      progress: { done: 0, total: sources.length },
    },
    null
  );

  const outcome = await searchAllSources(searcher, sources, request.query, {
    concurrency: 6,
    timeoutMs: 20_000,
    onProgress: async (done, total) => {
      await post({
        state: "progress",
        query: request.query,
        progress: { done, total },
      });
    },
  });

  if (!outcome.matches.length) {
    await target.show(
      {
        state: "failed",
        query: request.query,
        failedCount: outcome.failed.length,
        detail: `لم أعثر على عمل مطابق لـ «${request.query}» في ${sitesCount(outcome.searched)}.${outcome.failed.length ? `\n-# تعذر الوصول إلى ${sitesCount(outcome.failed.length)} أثناء البحث.` : ""} جرّب اسمًا آخر أو كتابة مختلفة.`,
      },
      null
    );
    return;
  }

  // كل النتائج تبقى في الجلسة — القائمة تعرضها صفحة صفحة عبر أزرار التنقل.
  const session: SearchSession = {
    requesterId: requester.id,
    channelId: requester.channelId,
    createdAt: Date.now(),
    query: request.query,
    failedCount: outcome.failed.length,
    chapterNumber: request.chapterNumber,
    matches: outcome.matches,
    matchPage: 0,
    view: "results",
    chapters: [],
    chapterPage: 0,
  };
  activeSearchSessions.set(searchId, session);
  scheduleSearchSessionCleanup(searchId);

  if (request.chapterNumber !== null) {
    await post(
      {
        state: "progress",
        query: request.query,
        progress: { done: sources.length, total: sources.length },
        failedCount: outcome.failed.length,
      },
      null,
      true
    );
    const rows = await checkChapterAvailability(
      searcher,
      session.matches,
      request.chapterNumber,
      { concurrency: 5, timeoutMs: 25_000, limit: 18 }
    );
    // النتائج الإيجابية فقط: يُعرض الموقع الذي وُجد فيه الفصل مع اسمه.
    // المتعثر أو غير المتاح لا يُعرض إطلاقًا — إظهار الأخطاء ضجيج لا يفيد.
    const found = rows.filter(row => row.chapter && !row.error);
    session.view = "availability";
    session.anyAvailable = found.length > 0;
    session.availability = found.map(row => ({
      ok: true,
      sourceName: row.match.sourceName,
      title: row.match.title,
      detail: row.chapter!.name,
      failed: false,
    }));
    const view = buildSearchSessionView(session, searchId);
    await target.show(view.notice, view.select, view.nav);
    return;
  }

  const view = buildSearchSessionView(session, searchId);
  await target.show(view.notice, view.select, view.nav);
}

async function isSearchSessionAllowed(session: SearchSession, interaction: any): Promise<boolean> {
  if (!session) return false;
  return isOwner(interaction.user.id) || session.requesterId === interaction.user.id;
}

async function handleSearchPick(interaction: any) {
  const searchId = interaction.customId.split(":")[2];
  const session = activeSearchSessions.get(searchId);
  if (!session || !(await isSearchSessionAllowed(session, interaction))) {
    await interaction
      .reply({ content: "انتهت صلاحية هذه النتائج أو أنها لطالبها فقط — نفّذ /بحث من جديد.", flags: MessageFlags.Ephemeral })
      .catch(() => undefined);
    return;
  }
  await interaction.deferUpdate();
  const index = Number(interaction.values?.[0]);
  const match = Number.isInteger(index) ? session.matches[index] : undefined;
  if (!match) return;
  try {
    const searcher = new SuwayomiClient(
      ENV.suwayomiBaseUrl,
      getUsableSuwayomiToken()
    );
    const chapters = await searcher.fetchMangaAndChapters(match.mangaId);
    const sorted = chapters
      .filter(chapter => typeof chapter.chapterNumber === "number")
      .sort((a, b) => (b.chapterNumber ?? 0) - (a.chapterNumber ?? 0));
    if (!sorted.length) {
      await editMessageContent(
        interaction.channelId,
        interaction.message.id,
        searchCardPayload({
          state: "failed",
          detail: "لم أعثر على فصول لهذا العمل في هذا الموقع. جرّب عملًا آخر.",
        })
      );
      return;
    }
    session.chapters = sorted.map(chapter => ({
      label: `فصل ${chapter.chapterNumber}${chapter.name && chapter.name !== String(chapter.chapterNumber) ? ` — ${chapter.name}` : ""}`,
      url: chapter.url,
      realUrl: chapter.realUrl ?? null,
      number: chapter.chapterNumber ?? null,
    }));
    session.mangaTitle = match.title;
    session.sourceName = match.sourceName;
    session.suwayomiSourceId = match.sourceId;
    session.matchUrl = match.url;
    session.matchRealUrl = match.realUrl;
    session.view = "chapters";
    session.chapterPage = 0;
    // كل الفصول في الجلسة — القائمة تعرضها صفحة صفحة عبر أزرار التنقل.
    await showSearchSessionView(interaction, session, searchId);
  } catch (error) {
    console.warn("[Discord] Search pick failed", error);
    await editMessageContent(
      interaction.channelId,
      interaction.message.id,
      searchCardPayload({
        state: "failed",
        detail: "تعذر جلب فصول هذا العمل من هذا الموقع. أعد المحاولة أو اختر عملًا آخر.",
      })
    ).catch(() => undefined);
  }
}

async function handleSearchChapterPick(interaction: any) {
  const searchId = interaction.customId.split(":")[2];
  const session = activeSearchSessions.get(searchId);
  if (!session || !(await isSearchSessionAllowed(session, interaction))) {
    await interaction
      .reply({ content: "انتهت صلاحية هذه القائمة أو أنها لطالبها فقط — نفّذ /بحث من جديد.", flags: MessageFlags.Ephemeral })
      .catch(() => undefined);
    return;
  }
  await interaction.deferUpdate();
  const index = Number(interaction.values?.[0]);
  const chapter = session.chapters[index];
  if (!chapter) return;
  const chapterUrl = chapterUrlFromParts(
    { url: session.matchUrl ?? "", realUrl: session.matchRealUrl ?? null },
    chapter
  );
  if (!chapterUrl) {
    await editMessageContent(
      interaction.channelId,
      interaction.message.id,
      searchCardPayload({
        state: "failed",
        detail: "تعذر بناء رابط الفصل من هذا الموقع — اختر موقعًا آخر أو استخدم /فصل برابط مباشر.",
      })
    );
    return;
  }
  // استكمال بيانات مصدر مزامن بلا نطاق: يُشتق النطاق من رابط العمل ويُفعّل السحب المباشر.
  if (session.suwayomiSourceId) {
    try {
      const row = await getSourceBySuwayomiId(session.suwayomiSourceId);
      if (row && row.origin === "suwayomi" && !row.allowDirectChapterLookup) {
        const derived = hostnameFromHomeUrl(chapterUrl);
        if (derived && derived !== row.hostname) {
          await saveSource({
            id: row.id,
            name: row.name,
            hostname: derived,
            baseUrl: new URL(chapterUrl).origin,
            suwayomiSourceId: row.suwayomiSourceId,
            extensionPackage: row.extensionPackage,
            extensionName: row.extensionName,
            status: "active",
            allowDirectChapterLookup: true,
            notes: row.notes,
            origin: "suwayomi",
          });
        }
      }
    } catch (error) {
      console.warn("[Discord] Source hostname backfill skipped:", error);
    }
  }
  activeSearchSessions.delete(searchId);
  // التسليم لخط /فصل الحرفي: نفس التحقق، نفس البطاقة، نفس الصلاحيات — بلا أي فرع جديد.
  await startChapterFromUrl(interactionCard(interaction), chapterUrl, {
    id: interaction.user.id,
    username: interaction.user.username,
    channelId: interaction.channelId,
  }).catch(async error => {
    console.warn("[Discord] Search grab failed", error);
    await editMessageContent(
      interaction.channelId,
      interaction.message.id,
      searchCardPayload({
        state: "failed",
        detail:
          error instanceof UrlPolicyError
            ? error.message
            : "تعذر بدء سحب هذا الفصل. حاول من جديد أو استخدم /فصل برابط مباشر.",
      })
    ).catch(() => undefined);
  });
}

async function handleSearchSelectMenu(interaction: any) {
  if (interaction.customId.startsWith("search:pick:"))
    return void handleSearchPick(interaction);
  if (interaction.customId.startsWith("search:chap:"))
    return void handleSearchChapterPick(interaction);
}

/**
 * أزرار التنقل بين صفحات نتائج البحث أو صفحات قائمة الفصول:
 * customId: search:page:{searchId}:prev|next أو search:cpage:{searchId}:prev|next
 */
async function handleSearchPageButton(interaction: any) {
  const [, kind, searchId, direction] = interaction.customId.split(":");
  const session = activeSearchSessions.get(searchId);
  if (!session || !(await isSearchSessionAllowed(session, interaction))) {
    await interaction
      .reply({ content: "انتهت صلاحية هذه القائمة أو أنها لطالبها فقط — نفّذ /بحث من جديد.", flags: MessageFlags.Ephemeral })
      .catch(() => undefined);
    return;
  }
  await interaction.deferUpdate();
  const delta = direction === "next" ? 1 : -1;
  if (kind === "page") session.matchPage = Math.max(0, session.matchPage + delta);
  else session.chapterPage = Math.max(0, session.chapterPage + delta);
  try {
    await showSearchSessionView(interaction, session, searchId);
  } catch (error) {
    console.warn("[Discord] Search page nav failed", error);
  }
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
  if (
    interaction.customId.startsWith("search:page:") ||
    interaction.customId.startsWith("search:cpage:")
  )
    return void handleSearchPageButton(interaction);
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
      if (interaction.isStringSelectMenu())
        return void handleSearchSelectMenu(interaction);
      if (!interaction.isChatInputCommand()) return;
      if (interaction.commandName === "مساعدة") await replyHelp(interaction);
      else if (interaction.commandName === "فصل")
        await replyChapter(interaction);
      else if (interaction.commandName === "دمج")
        await replyMerge(interaction);
      else if (interaction.commandName === "مواقع")
        await replySources(interaction);
      else if (interaction.commandName === "بحث")
        await replySearch(interaction);
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
