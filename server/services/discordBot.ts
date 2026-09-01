import {
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
import {
  addJobAttempt,
  cancelChapterJob,
  getChapterJob,
  listActiveDiscordRoleIds,
  saveIntegrationHealth,
  setDiscordProgressMessage,
} from "../db";
import { queueAuthorizedChapter } from "./jobs";
import { UrlPolicyError } from "./urlPolicy";

let client: Client | null = null;
let started = false;
const pendingChapterPrompts = new Map<string, number>();
const GOLD = 0xd4af37;
const RED = 0xed4245;
const BOT_USERNAME = "ZEUS";

export type JobNotice = {
  jobId?: string;
  status: "pending" | "downloading" | "uploading" | "completed" | "failed" | "cancelled" | "info";
  title: string;
  description: string;
  pageCount?: number;
  uploadedPages?: number;
  driveUrl?: string | null;
  /** تقدم رقمي فعلي، مثل عدد الصفحات المسحوبة أو المرفوعة. */
  progress?: { done: number; total: number };
};

const ACTIVE_STATUSES = ["pending", "downloading", "uploading"];
const TERMINAL_STATUSES = ["completed", "failed", "cancelled"];

const commandPayload = [
  new SlashCommandBuilder()
    .setName("فصل")
    .setDescription("سحب فصل مانهوا وتسليمه برابط")
    .addStringOption(option =>
      option.setName("الرابط").setDescription("رابط الفصل - اختياري").setRequired(false),
    ),
  new SlashCommandBuilder().setName("مساعدة").setDescription("شرح الأوامر"),
].map(command => command.toJSON());

export function getRegisteredDiscordCommands() {
  return commandPayload;
}

function isOwner(userId: string) {
  return Boolean(ENV.ownerDiscordUserId) && userId === ENV.ownerDiscordUserId;
}

async function hasRequestAccess(interaction: any) {
  if (!interaction.inGuild() || !interaction.member || !interaction.channelId) return false;
  if (isOwner(interaction.user.id)) return true;
  const allowed = await listActiveDiscordRoleIds();
  const roles = Array.isArray(interaction.member.roles)
    ? interaction.member.roles
    : interaction.member.roles.cache.map((role: { id: string }) => role.id);
  return allowed.some(role => roles.includes(role));
}

function component(value: Record<string, unknown>): APIMessageTopLevelComponent {
  return value as unknown as APIMessageTopLevelComponent;
}

function buttons(notice: JobNotice, final = false): APIMessageTopLevelComponent | null {
  const list: Record<string, unknown>[] = [];
  if (final && notice.driveUrl) list.push({ type: 2, style: 5, label: "فتح الفصل", url: notice.driveUrl });
  if (!final && notice.jobId && ACTIVE_STATUSES.includes(notice.status)) {
    list.push({ type: 2, style: 2, label: "إلغاء", custom_id: `job:cancel:${notice.jobId}` });
  }
  return list.length ? component({ type: 1, components: list }) : null;
}

export function buildJobComponents(notice: JobNotice, options?: { requesterId?: string; final?: boolean }): APIMessageTopLevelComponent[] {
  const body: APIMessageTopLevelComponent[] = [];
  const heading = options?.requesterId ? `<@${options.requesterId}>\n## ${notice.title}` : `## ${notice.title}`;
  body.push(component({ type: 10, content: heading }));
  const lines: string[] = [];
  if (notice.description) lines.push(notice.description);
  if (notice.progress) lines.push(`**${notice.progress.done} / ${notice.progress.total}**`);
  else if (notice.status === "uploading" && notice.pageCount) lines.push(`**${notice.uploadedPages ?? 0} / ${notice.pageCount}**`);
  if (notice.status === "completed" && notice.driveUrl) lines.push(`**الرابط:** ${notice.driveUrl}`);
  if (lines.length) body.push(component({ type: 10, content: lines.join("\n") }));
  const row = buttons(notice, Boolean(options?.final));
  if (row) body.push(row);
  return [component({ type: 17, accent_color: notice.status === "failed" ? RED : GOLD, components: body })];
}

function payload(notice: JobNotice, options?: { requesterId?: string; final?: boolean }) {
  return {
    flags: MessageFlags.IsComponentsV2 as MessageFlags.IsComponentsV2,
    allowedMentions: options?.requesterId ? { users: [options.requesterId] } : undefined,
    components: buildJobComponents(notice, options),
  };
}

/** يحوّل سجل الطلب إلى بطاقة حالته الحالية، بلا أي نصوص ثابتة إضافية. */
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
  const status = (["pending", "downloading", "uploading", "completed", "failed", "cancelled"].includes(job.status) ? job.status : "pending") as JobNotice["status"];
  const label = [job.mangaTitle, job.chapterTitle].filter(Boolean).join(" — ");
  const titles: Record<JobNotice["status"], string> = {
    pending: "⏳ تم استلام الطلب",
    downloading: "⏳ جاري تجهيز الفصل",
    uploading: "☁️ جاري الرفع",
    completed: "✅ الفصل جاهز",
    failed: "❌ فشل تجهيز الفصل",
    cancelled: "🚫 أُلغي الطلب",
    info: "الأوامر",
  };
  const description = status === "completed"
    ? label || "تم تجهيز الفصل بالكامل."
    : status === "failed"
      ? job.failureMessage ?? "تعذر إكمال تجهيز الفصل."
      : status === "cancelled"
        ? "أوقفتَ هذه العملية."
        : label || "جاري العمل على الفصل الآن.";
  return {
    jobId: job.id,
    status,
    title: titles[status],
    description,
    pageCount: job.totalPages || undefined,
    uploadedPages: job.uploadedPages,
    driveUrl: job.googleDriveUrl,
    progress: status === "uploading" && job.totalPages ? { done: job.uploadedPages, total: job.totalPages } : undefined,
  };
}

export async function refreshDiscordCommands() {
  if (!ENV.discordBotToken || !ENV.discordApplicationId || !ENV.discordGuildId) return;
  await new REST({ version: "10" }).setToken(ENV.discordBotToken).put(Routes.applicationGuildCommands(ENV.discordApplicationId, ENV.discordGuildId), { body: commandPayload });
}

export function isDiscordBotReady() {
  return Boolean(client?.isReady());
}

async function replyHelp(interaction: any) {
  await interaction.deferReply();
  await interaction.editReply(payload({
    status: "info",
    title: "الأوامر",
    description: [
      "**/فصل الرابط** — ضع رابط الفصل مباشرة وسيبدأ السحب فورًا، وتتابع التقدم في نفس الرسالة حتى يصلك الرابط النهائي.",
      "**/فصل** — بدون رابط، ثم أرسل الرابط في القناة خلال دقيقتين.",
    ].join("\n"),
  }));
}

async function startChapterFromUrl(interaction: any, chapterUrl: string) {
  // أول رد: مؤشر انتظار فوري أثناء فحص الرابط والمصدر.
  await interaction.editReply(payload({
    status: "pending",
    title: "⏳ جاري فحص الرابط",
    description: "لحظات، جاري التحقق من الموقع والمصدر.",
  }));
  const { job, created } = await queueAuthorizedChapter({
    chapterUrl,
    requester: { discordId: interaction.user.id, displayName: interaction.user.username, channelId: interaction.channelId },
  });
  if (!created) {
    // يحدث فقط إذا كان الفصل قيد التجهيز فعلًا الآن.
    await interaction.editReply(payload({
      jobId: job.id,
      status: job.status as JobNotice["status"],
      title: "⏳ هذا الفصل قيد التجهيز بالفعل",
      description: "تابع التقدم في بطاقة المتابعة الخاصة به في هذه القناة.",
      pageCount: job.totalPages || undefined,
      uploadedPages: job.uploadedPages,
    }));
    return;
  }
  const progress = await interaction.editReply(payload({
    jobId: job.id,
    status: "pending",
    title: "⏳ تم استلام الطلب",
    description: "بدأت المعالجة الآن، هذه الرسالة ستتحدث مع كل خطوة حتى يصلك الفصل.",
  }));
  await setDiscordProgressMessage(job.id, progress.id);
  void import("./jobWorker").then(({ processPendingChapterJobs }) => processPendingChapterJobs());
}

async function replyChapter(interaction: any) {
  await interaction.deferReply();
  try {
    if (!(await hasRequestAccess(interaction))) {
      await interaction.editReply(payload({ status: "failed", title: "لا تملك صلاحية", description: "هذا الأمر متاح لأدوار محددة فقط." }));
      return;
    }
    const url = interaction.options.getString("الرابط", false);
    if (!url) {
      pendingChapterPrompts.set(`${interaction.channelId}:${interaction.user.id}`, Date.now());
      await interaction.editReply(payload({ status: "info", title: "✍️ أرسل رابط الفصل", description: "اكتب رابط الفصل في هذه القناة خلال دقيقتين وسيبدأ السحب مباشرة." }));
      return;
    }
    await startChapterFromUrl(interaction, url);
  } catch (error) {
    const message = error instanceof UrlPolicyError ? error.message : "تعذر قبول الرابط، تحقق منه ثم أعد المحاولة.";
    await interaction.editReply(payload({ status: "failed", title: "❌ تعذر بدء السحب", description: message }));
  }
}

async function handleButton(interaction: any) {
  if (!interaction.customId.startsWith("job:cancel:")) return;
  await interaction.deferUpdate();
  const job = await getChapterJob(interaction.customId.split(":")[2]);
  if (!job || (!isOwner(interaction.user.id) && job.requestedByDiscordId !== interaction.user.id)) return;
  try {
    const cancelled = await cancelChapterJob(job.id);
    await addJobAttempt(job.id, "cancelled", `أوقف ${interaction.user.username} العملية من Discord.`);
    await updateJobProgressMessage(cancelled.requestedInChannelId, cancelled.discordProgressMessageId, noticeFromJob(cancelled), { final: true });
  } catch (error) {
    console.warn("[Discord] Could not cancel job", error);
  }
}

export async function startDiscordBot() {
  if (started || !ENV.discordBotToken || !ENV.discordApplicationId || !ENV.discordGuildId) return;
  started = true;
  client = new Client({ intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMessages, GatewayIntentBits.MessageContent] });
  client.once(Events.ClientReady, async ready => {
    console.info(`[Discord] Connected as ${ready.user.tag}`);
    // هوية البوت: ZEUS فقط.
    if (ready.user.username !== BOT_USERNAME) {
      await ready.user.setUsername(BOT_USERNAME)
        .then(() => console.info("[Discord] Username set to ZEUS"))
        .catch(error => console.warn("[Discord] Could not set username", error));
    }
    // Registering guild commands can fail with DiscordAPIError[50001]
    // "Missing Access" when the bot was invited only with the `bot` scope.
    // Re-authorizing the app with the `applications.commands` scope fixes it,
    // so retry a few times instead of giving up after a single attempt.
    const maxAttempts = 6;
    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      try {
        await refreshDiscordCommands();
        console.info(`[Discord] Guild commands refreshed (${commandPayload.length})`);
        await saveIntegrationHealth("discord", "healthy", `البوت متصل وحُدّثت ${commandPayload.length} أوامر.`);
        break;
      } catch (error) {
        const missingAccess = (error as { code?: number })?.code === 50001;
        console.error(
          `[Discord] Command registration attempt ${attempt}/${maxAttempts} failed`,
          error
        );
        if (attempt === maxAttempts) break;
        if (missingAccess) {
          console.warn(
            "[Discord] Missing Access: أعِد دعوة التطبيق إلى السيرفر مع نطاق applications.commands (رابط الدعوة في README/السجل). سنعيد المحاولة بعد 30 ثانية."
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
      else if (interaction.commandName === "فصل") await replyChapter(interaction);
    } catch (error) {
      console.error("[Discord] Interaction handler failed", error);
      if (interaction.isRepliable()) {
        if (interaction.deferred || interaction.replied) await interaction.editReply({ content: "تعذر تنفيذ الأمر الآن.", components: [] }).catch(() => undefined);
        else await interaction.reply({ content: "تعذر تنفيذ الأمر الآن." }).catch(() => undefined);
      }
    }
  });
  client.on(Events.MessageCreate, async message => {
    const key = `${message.channelId}:${message.author.id}`;
    const startedAt = pendingChapterPrompts.get(key);
    if (!startedAt || message.author.bot) return;
    if (Date.now() - startedAt > 120000) {
      pendingChapterPrompts.delete(key);
      return;
    }
    const content = message.content.trim();
    if (!/^https:\/\//i.test(content)) return;
    pendingChapterPrompts.delete(key);
    const fakeInteraction = { user: message.author, channelId: message.channelId, editReply: (data: unknown) => message.reply(data as any) };
    try {
      await startChapterFromUrl(fakeInteraction, content);
    } catch (error) {
      const description = error instanceof UrlPolicyError ? error.message : "تعذر قبول الرابط.";
      await message.reply(payload({ status: "failed", title: "❌ تعذر بدء السحب", description }));
    }
  });
  client.on(Events.Error, error => {
    console.error("[Discord] Client error", error);
    void saveIntegrationHealth("discord", "offline", "تعرض اتصال Discord لخطأ.");
  });
  await client.login(ENV.discordBotToken);
}

async function channel(channelId: string | null) {
  if (!client || !channelId) return null;
  const found = await client.channels.fetch(channelId);
  return found?.isTextBased() && "send" in found ? found : null;
}

export async function updateJobProgressMessage(
  channelId: string | null,
  messageId: string | null,
  notice: JobNotice,
  options?: { requesterId?: string; final?: boolean },
) {
  if (!client || !channelId || !messageId) return;
  const found = await client.channels.fetch(channelId);
  if (!found?.isTextBased() || !("messages" in found)) return;
  try {
    const message = await found.messages.fetch(messageId);
    await message.edit(payload(notice, options));
  } catch (error) {
    console.warn(`[Discord] Could not update progress message ${messageId}`, error);
  }
}

export async function sendJobUpdate(channelId: string | null, requesterId: string, notice: JobNotice) {
  const job = notice.jobId ? await getChapterJob(notice.jobId) : undefined;
  const isFinal = TERMINAL_STATUSES.includes(notice.status);
  await updateJobProgressMessage(
    channelId,
    job?.discordProgressMessageId ?? null,
    notice,
    isFinal ? { requesterId, final: true } : undefined,
  );
  // بطاقة المتابعة تتحدث دائمًا؛ رسالة منفصلة قصيرة فقط عند النتيجة النهائية
  // لأن التنبيه (المنشن) لا يعمل عبر تعديل رسالة قائمة.
  if (!isFinal) return;
  const found = await channel(channelId);
  if (!found) return;
  try {
    if (notice.status === "completed") {
      const link = notice.driveUrl ?? job?.googleDriveUrl ?? "";
      await found.send({
        content: `<@${requesterId}> ✅ الفصل جاهز${link ? `\n${link}` : ""}`,
        allowedMentions: { users: [requesterId] },
      });
    } else if (notice.status === "failed") {
      await found.send({
        content: `<@${requesterId}> ❌ فشل تجهيز الفصل: ${notice.description}`.slice(0, 2000),
        allowedMentions: { users: [requesterId] },
      });
    }
  } catch (error) {
    console.warn("[Discord] Could not send final job notice", error);
  }
}

export async function sendOwnerAlert(message: string) {
  if (!client || !ENV.ownerDiscordUserId) return;
  const owner = await client.users.fetch(ENV.ownerDiscordUserId);
  await owner.send({ content: `## تنبيه\n${message}` });
}
