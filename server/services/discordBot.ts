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
const divider = "━━━━━━━━━━━━━━━━━━━━";

export type JobNotice = {
  jobId?: string;
  status: "pending" | "downloading" | "uploading" | "completed" | "failed" | "cancelled" | "info";
  title: string;
  description: string;
  pageCount?: number;
  uploadedPages?: number;
  driveUrl?: string | null;
};

const statusCopy = {
  pending: ["تم استلام الرابط", "الخطوة 1 من 4 — فحص الرابط وتجهيز الفصل"],
  downloading: ["جاري تجهيز الصفحات", "الخطوة 2 من 4 — قراءة الصفحات وترتيبها"],
  uploading: ["جاري حفظ الفصل", "الخطوة 3 من 4 — حفظ الملفات النهائية"],
  completed: ["الفصل جاهز", "الخطوة 4 من 4 — تم التسليم بنجاح"],
  failed: ["تعذر تجهيز الفصل", "توقفت العملية"],
  cancelled: ["تم إلغاء العملية", "أوقفت العملية بناءً على الطلب"],
  info: ["دار الفصول", "دليل الاستخدام"],
} as const;

function chapterCommand(name: "فصل" | "chapter") {
  return new SlashCommandBuilder()
    .setName(name)
    .setDescription(name === "فصل" ? "تجهيز فصل وتسليمه كرابط" : "Prepare a chapter and deliver a link")
    .addStringOption(option =>
      option
        .setName(name === "فصل" ? "الرابط" : "url")
        .setDescription("رابط الفصل الكامل - اختياري")
        .setRequired(false),
    );
}

const commandPayload = [
  chapterCommand("فصل"),
  chapterCommand("chapter"),
  new SlashCommandBuilder().setName("مساعدة").setDescription("شرح استخدام دار الفصول"),
  new SlashCommandBuilder().setName("help").setDescription("How to use Dar Al-Fusul"),
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

function progressText(notice: JobNotice) {
  const stage = statusCopy[notice.status][1];
  if (notice.status === "uploading" && notice.pageCount) return `**${stage}**\n> حُفظ ${notice.uploadedPages ?? 0} من ${notice.pageCount} صفحة.`;
  if (notice.status === "downloading" && notice.pageCount) return `**${stage}**\n> عُثر على ${notice.pageCount} صفحة. جاري تجهيز الصورة النهائية.`;
  return `**${stage}**\n> ${notice.description}`;
}

function buttons(notice: JobNotice, final = false): APIMessageTopLevelComponent | null {
  const list: Record<string, unknown>[] = [];
  if (final && notice.driveUrl) list.push({ type: 2, style: 5, label: "فتح الفصل", url: notice.driveUrl });
  if (!final && notice.jobId && ["pending", "downloading", "uploading"].includes(notice.status)) {
    list.push({ type: 2, style: 2, label: "إلغاء", custom_id: `job:cancel:${notice.jobId}` });
  }
  return list.length ? component({ type: 1, components: list }) : null;
}

export function buildJobComponents(notice: JobNotice, options?: { requesterId?: string; final?: boolean }): APIMessageTopLevelComponent[] {
  const body: APIMessageTopLevelComponent[] = [
    component({ type: 10, content: `${options?.requesterId ? `<@${options.requesterId}>\n` : ""}## ${statusCopy[notice.status][0]}` }),
    component({ type: 14, divider: true, spacing: 1 }),
    component({ type: 10, content: progressText(notice) }),
    component({ type: 14, divider: true, spacing: 1 }),
    component({
      type: 10,
      content: [
        notice.pageCount ? `**عدد الصفحات:** ${notice.pageCount}` : "**الخطوة التالية:** أرسل رابط الفصل الكامل.",
        notice.driveUrl ? `**الرابط:** ${notice.driveUrl}` : null,
        divider,
        "**دار الفصول** · تجربة مرتبة وسريعة للفريق",
      ].filter(Boolean).join("\n"),
    }),
  ];
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

function fromJob(job: { id: string; status: string; totalPages: number; uploadedPages: number; googleDriveUrl: string | null; failureMessage: string | null }): JobNotice {
  const status = (["pending", "downloading", "uploading", "completed", "failed", "cancelled"].includes(job.status) ? job.status : "info") as JobNotice["status"];
  const description = status === "completed"
    ? "اكتمل تجهيز الفصل وحفظه بالرابط النهائي."
    : status === "failed"
      ? job.failureMessage ?? "تعذر إكمال العملية."
      : status === "cancelled"
        ? "أُلغيت العملية قبل الاكتمال."
        : "العملية قيد التنفيذ.";
  return { jobId: job.id, status, title: "فصل", description, pageCount: job.totalPages || undefined, uploadedPages: job.uploadedPages, driveUrl: job.googleDriveUrl };
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
    title: "المساعدة",
    description: "استخدم `/فصل` مع الرابط مباشرة، أو أرسل `/فصل` بدون رابط وسأطلب منك الرابط في رسالة تالية. بعد ذلك ستظهر بطاقة متابعة تتحدث تلقائيًا حتى يصلك رابط الفصل النهائي.",
  }));
}

async function startChapterFromUrl(interaction: any, chapterUrl: string) {
  const { job, created } = await queueAuthorizedChapter({
    chapterUrl,
    requester: { discordId: interaction.user.id, displayName: interaction.user.username, channelId: interaction.channelId },
  });
  if (!created) {
    await interaction.editReply(payload({
      jobId: job.id,
      status: "completed",
      title: "الفصل موجود",
      description: "سبق تجهيز هذا الفصل. هذا هو رابطه:",
      pageCount: job.totalPages || undefined,
      driveUrl: job.googleDriveUrl,
    }, { requesterId: interaction.user.id, final: true }));
    return;
  }
  const progress = await interaction.editReply(payload({ jobId: job.id, status: "pending", title: "تم استلام الرابط", description: "بدأت معالجة الفصل الآن." }));
  await setDiscordProgressMessage(job.id, progress.id);
  void import("./jobWorker").then(({ processPendingChapterJobs }) => processPendingChapterJobs());
}

async function replyChapter(interaction: any) {
  await interaction.deferReply();
  try {
    if (!(await hasRequestAccess(interaction))) {
      await interaction.editReply(payload({ status: "failed", title: "وصول غير متاح", description: "لا تملك صلاحية استخدام هذا الأمر." }));
      return;
    }
    const name = interaction.commandName === "chapter" ? "url" : "الرابط";
    const url = interaction.options.getString(name, false);
    if (!url) {
      pendingChapterPrompts.set(`${interaction.channelId}:${interaction.user.id}`, Date.now());
      await interaction.editReply(payload({ status: "info", title: "أرسل رابط الفصل", description: "اكتب رابط الفصل في هذه القناة خلال دقيقتين، وسأبدأ التجهيز مباشرة." }));
      return;
    }
    await startChapterFromUrl(interaction, url);
  } catch (error) {
    const message = error instanceof UrlPolicyError ? error.message : "تعذر قبول الرابط. تحقق من الرابط ثم أعد المحاولة.";
    await interaction.editReply(payload({ status: "failed", title: "تعذر بدء العملية", description: message }));
  }
}

async function handleButton(interaction: any) {
  if (!interaction.customId.startsWith("job:cancel:")) return;
  await interaction.deferUpdate();
  const job = await getChapterJob(interaction.customId.split(":")[2]);
  if (!job || (!isOwner(interaction.user.id) && job.requestedByDiscordId !== interaction.user.id)) return;
  try {
    const cancelled = await cancelChapterJob(job.id);
    await addJobAttempt(job.id, "cancelled", `ألغى العضو ${interaction.user.username} العملية من Discord.`);
    await updateJobProgressMessage(cancelled.requestedInChannelId, cancelled.discordProgressMessageId, fromJob(cancelled));
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
      if (["مساعدة", "help"].includes(interaction.commandName)) await replyHelp(interaction);
      else if (["فصل", "chapter"].includes(interaction.commandName)) await replyChapter(interaction);
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
      await message.reply(payload({ status: "failed", title: "تعذر بدء العملية", description }));
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

export async function updateJobProgressMessage(channelId: string | null, messageId: string | null, notice: JobNotice) {
  if (!client || !channelId || !messageId) return;
  const found = await client.channels.fetch(channelId);
  if (!found?.isTextBased() || !("messages" in found)) return;
  try {
    const message = await found.messages.fetch(messageId);
    await message.edit(payload(notice));
  } catch (error) {
    console.warn(`[Discord] Could not update progress message ${messageId}`, error);
  }
}

export async function sendJobUpdate(channelId: string | null, requesterId: string, notice: JobNotice) {
  const job = notice.jobId ? await getChapterJob(notice.jobId) : undefined;
  await updateJobProgressMessage(channelId, job?.discordProgressMessageId ?? null, notice);
  if (!["completed", "failed", "cancelled"].includes(notice.status)) return;
  const found = await channel(channelId);
  if (found) await found.send(payload(notice, { requesterId, final: true }));
}

export async function sendOwnerAlert(message: string) {
  if (!client || !ENV.ownerDiscordUserId) return;
  const owner = await client.users.fetch(ENV.ownerDiscordUserId);
  await owner.send({ content: `## تنبيه\n${divider}\n${message}` });
}
