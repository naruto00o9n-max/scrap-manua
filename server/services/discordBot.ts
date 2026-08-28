import {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  Client,
  EmbedBuilder,
  Events,
  GatewayIntentBits,
  MessageFlags,
  REST,
  Routes,
  SlashCommandBuilder,
} from "discord.js";
import { ENV } from "../_core/env";
import { addJobAttempt, cancelChapterJob, getChapterJob, listActiveDiscordRoleIds, saveIntegrationHealth } from "../db";
import { queueAuthorizedChapter } from "./jobs";
import { UrlPolicyError } from "./urlPolicy";

let client: Client | null = null;
let started = false;

type JobNotice = {
  jobId?: string;
  status: "pending" | "downloading" | "uploading" | "completed" | "failed" | "cancelled" | "info";
  title: string;
  description: string;
  pageCount?: number;
  driveUrl?: string | null;
};

const palette = { pending: 0xD4A644, downloading: 0x5B8DEF, uploading: 0x9B6BFF, completed: 0x30B978, failed: 0xE05252, cancelled: 0x888888, info: 0xD4A644 };
const statusLabel = { pending: "في الطابور", downloading: "جارٍ التحميل", uploading: "جارٍ الرفع", completed: "مكتمل", failed: "فشل", cancelled: "مُلغى", info: "معلومة" };

function chapterCommand(name: "فصل" | "chapter") {
  return new SlashCommandBuilder()
    .setName(name)
    .setDescription(name === "فصل" ? "حفظ فصل مصرح به في Google Drive" : "Save an authorized chapter to Google Drive")
    .addStringOption(option => option.setName(name === "فصل" ? "الرابط" : "url").setDescription("رابط الفصل الكامل").setRequired(true));
}

const helpCommand = new SlashCommandBuilder().setName("مساعدة").setDescription("دليل أوامر Manga Drive");
const helpFallbackCommand = new SlashCommandBuilder().setName("help").setDescription("Manga Drive command guide");
const statusCommand = new SlashCommandBuilder().setName("حالة").setDescription("عرض حالة مهمة فصل")
  .addStringOption(option => option.setName("المهمة").setDescription("معرّف المهمة").setRequired(true));
const commandPayload = [chapterCommand("فصل"), chapterCommand("chapter"), helpCommand, helpFallbackCommand, statusCommand].map(command => command.toJSON());

function isOwner(userId: string): boolean {
  return Boolean(ENV.ownerDiscordUserId) && userId === ENV.ownerDiscordUserId;
}

async function hasRequestAccess(interaction: any): Promise<boolean> {
  if (!interaction.inGuild() || !interaction.member || !interaction.channelId) return false;
  if (isOwner(interaction.user.id)) return true;
  const allowedRoleIds = await listActiveDiscordRoleIds();
  const memberRoleIds = Array.isArray(interaction.member.roles)
    ? interaction.member.roles
    : interaction.member.roles.cache.map((role: { id: string }) => role.id);
  return allowedRoleIds.some(roleId => memberRoleIds.includes(roleId));
}

function jobEmbed(notice: JobNotice): EmbedBuilder {
  const shortId = notice.jobId ? notice.jobId.slice(0, 8) : "SYSTEM";
  const embed = new EmbedBuilder()
    .setColor(palette[notice.status])
    .setTitle(`${statusLabel[notice.status]} · ${notice.title}`)
    .setDescription(notice.description)
    .setTimestamp()
    .setFooter({ text: `Manga Drive • ${shortId}` });
  if (notice.pageCount !== undefined) embed.addFields({ name: "الصفحات", value: String(notice.pageCount), inline: true });
  if (notice.jobId) embed.addFields({ name: "معرّف المهمة", value: `\`${notice.jobId}\``, inline: false });
  return embed;
}

function jobButtons(notice: JobNotice): ActionRowBuilder<ButtonBuilder>[] {
  const buttons: ButtonBuilder[] = [];
  if (notice.driveUrl) buttons.push(new ButtonBuilder().setStyle(ButtonStyle.Link).setLabel("فتح Google Drive").setURL(notice.driveUrl));
  if (notice.jobId) buttons.push(new ButtonBuilder().setStyle(ButtonStyle.Secondary).setLabel("عرض الحالة").setCustomId(`job:status:${notice.jobId}`));
  if (notice.jobId && ["pending", "downloading", "uploading"].includes(notice.status)) buttons.push(new ButtonBuilder().setStyle(ButtonStyle.Danger).setLabel("إلغاء المهمة").setCustomId(`job:cancel:${notice.jobId}`));
  return buttons.length ? [new ActionRowBuilder<ButtonBuilder>().addComponents(buttons)] : [];
}

function fromJob(job: { id: string; status: string; totalPages: number; uploadedPages: number; googleDriveUrl: string | null; failureMessage: string | null }): JobNotice {
  const status = (["pending", "downloading", "uploading", "completed", "failed", "cancelled"].includes(job.status) ? job.status : "info") as JobNotice["status"];
  const description = status === "completed"
    ? "اكتمل رفع الفصل بنجاح. استخدم الزر لفتح مجلد Google Drive."
    : status === "failed" ? `تعذرت معالجة المهمة. ${job.failureMessage ?? "راجع إعدادات المصدر."}`
      : status === "cancelled" ? "أُلغي هذا الطلب قبل اكتمال المعالجة."
        : `التقدم: ${job.uploadedPages} من ${job.totalPages || "؟"} صفحة.`;
  return { jobId: job.id, status, title: "حالة مهمة الفصل", description, pageCount: job.totalPages || undefined, driveUrl: job.googleDriveUrl };
}

export async function refreshDiscordCommands(): Promise<void> {
  if (!ENV.discordBotToken || !ENV.discordApplicationId || !ENV.discordGuildId) return;
  const rest = new REST({ version: "10" }).setToken(ENV.discordBotToken);
  await rest.put(Routes.applicationGuildCommands(ENV.discordApplicationId, ENV.discordGuildId), { body: commandPayload });
}

export function isDiscordBotReady(): boolean {
  return Boolean(client?.isReady());
}

async function replyHelp(interaction: any) {
  await interaction.deferReply({ flags: MessageFlags.Ephemeral });
  const embed = new EmbedBuilder()
    .setColor(palette.info)
    .setTitle("Manga Drive · مركز الأوامر")
    .setDescription("أرسل روابط الفصول من المصادر المعتمدة فقط. يعالج البوت الطلب عبر Suwayomi ويرفع الصفحات مرتبة إلى Google Drive.")
    .addFields(
      { name: "/فصل أو /chapter", value: "يقبل رابط فصل كامل ويبدأ المعالجة.", inline: false },
      { name: "/حالة", value: "يعرض تقدم مهمة باستخدام معرّفها.", inline: false },
      { name: "النتيجة", value: "تصل رسالة خاصة، وتصل نسخة في قناة الطلب إن كانت الرسائل الخاصة مغلقة.", inline: false },
    )
    .setFooter({ text: "Manga Drive • مصادر مصرح بها فقط" });
  await interaction.editReply({ embeds: [embed] });
}

async function replyChapter(interaction: any) {
  await interaction.deferReply({ flags: MessageFlags.Ephemeral });
  if (!(await hasRequestAccess(interaction))) {
    await interaction.editReply({ content: "لا تملك دورًا معتمدًا لاستخدام أوامر الفصول. تواصل مع مدير الفريق." });
    return;
  }
  const inputName = interaction.commandName === "chapter" ? "url" : "الرابط";
  const chapterUrl = interaction.options.getString(inputName, true);
  try {
    const { job, created } = await queueAuthorizedChapter({
      chapterUrl,
      requester: { discordId: interaction.user.id, displayName: interaction.member.user.username, channelId: interaction.channelId },
    });
    const notice = fromJob(job);
    if (created) {
      notice.status = "pending";
      notice.title = "تم قبول طلب الفصل";
      notice.description = "فُحص المصدر وأُضيف الطلب إلى الطابور. ستصلك بطاقة بالنتيجة عند اكتمال الرفع.";
    }
    await interaction.editReply({ embeds: [jobEmbed(notice)], components: jobButtons(notice) });
    if (created) void import("./jobWorker").then(({ processPendingChapterJobs }) => processPendingChapterJobs());
  } catch (error) {
    const message = error instanceof UrlPolicyError ? error.message : "تعذر قبول الطلب. تحقق من المصدر وإعداداته ثم أعد المحاولة.";
    await interaction.editReply({ embeds: [jobEmbed({ status: "failed", title: "لم يُقبل الطلب", description: message })] });
  }
}

async function replyStatus(interaction: any) {
  await interaction.deferReply({ flags: MessageFlags.Ephemeral });
  if (!(await hasRequestAccess(interaction))) {
    await interaction.editReply({ content: "لا تملك صلاحية عرض حالة المهام." });
    return;
  }
  const jobId = interaction.options.getString("المهمة", true);
  const job = await getChapterJob(jobId);
  if (!job || (!isOwner(interaction.user.id) && job.requestedByDiscordId !== interaction.user.id)) {
    await interaction.editReply({ content: "لم تُعثر مهمة متاحة بهذا المعرّف." });
    return;
  }
  const notice = fromJob(job);
  await interaction.editReply({ embeds: [jobEmbed(notice)], components: jobButtons(notice) });
}

async function handleJobButton(interaction: any) {
  await interaction.deferReply({ flags: MessageFlags.Ephemeral });
  const [, action, jobId] = interaction.customId.split(":");
  const job = await getChapterJob(jobId);
  if (!job || (!isOwner(interaction.user.id) && job.requestedByDiscordId !== interaction.user.id)) {
    await interaction.editReply({ content: "لا تملك صلاحية الوصول إلى هذه المهمة." });
    return;
  }
  if (action === "status") {
    const notice = fromJob(job);
    await interaction.editReply({ embeds: [jobEmbed(notice)], components: jobButtons(notice) });
    return;
  }
  if (action === "cancel") {
    try {
      const cancelled = await cancelChapterJob(job.id);
      await addJobAttempt(job.id, "cancelled", `ألغى العضو ${interaction.user.username} المهمة من زر Discord.`);
      const notice = fromJob(cancelled);
      await interaction.editReply({ embeds: [jobEmbed(notice)], components: jobButtons(notice) });
    } catch (error) {
      await interaction.editReply({ content: error instanceof Error ? error.message : "تعذر إلغاء المهمة." });
    }
  }
}

export async function startDiscordBot(): Promise<void> {
  if (started || !ENV.discordBotToken || !ENV.discordApplicationId || !ENV.discordGuildId) return;
  started = true;
  client = new Client({ intents: [GatewayIntentBits.Guilds] });
  client.once(Events.ClientReady, async readyClient => {
    console.info(`[Discord] Connected as ${readyClient.user.tag}`);
    try {
      await refreshDiscordCommands();
      console.info(`[Discord] Guild commands refreshed (${commandPayload.length})`);
      await saveIntegrationHealth("discord", "healthy", `البوت متصل وحُدّثت ${commandPayload.length} أوامر في Guild ${ENV.discordGuildId}.`);
    } catch (error) {
      console.error("[Discord] Command registration failed", error);
      await saveIntegrationHealth("discord", "degraded", "اتصل البوت لكن تعذر تحديث أوامر Discord.");
    }
  });

  client.on(Events.InteractionCreate, async interaction => {
    try {
      if (interaction.isButton() && interaction.customId.startsWith("job:")) return void handleJobButton(interaction);
      if (!interaction.isChatInputCommand()) return;
      if (["مساعدة", "help"].includes(interaction.commandName)) return void replyHelp(interaction);
      if (["فصل", "chapter"].includes(interaction.commandName)) return void replyChapter(interaction);
      if (interaction.commandName === "حالة") return void replyStatus(interaction);
    } catch (error) {
      console.error("[Discord] Interaction handler failed", error);
      if (interaction.isRepliable()) {
        const message = "تعذر تنفيذ الأمر الآن. راجع إعدادات البوت أو أعد المحاولة.";
        if (interaction.deferred || interaction.replied) await interaction.editReply({ content: message, embeds: [], components: [] });
        else await interaction.reply({ content: message, flags: MessageFlags.Ephemeral });
      }
    }
  });

  client.on(Events.Error, error => {
    console.error("[Discord] Client error", error);
    void saveIntegrationHealth("discord", "offline", "تعرض اتصال Discord لخطأ.");
  });
  await client.login(ENV.discordBotToken);
}

export async function sendJobUpdate(channelId: string | null, requesterId: string, notice: JobNotice): Promise<void> {
  if (!client) return;
  const payload = { embeds: [jobEmbed(notice)], components: jobButtons(notice) };
  try {
    const requester = await client.users.fetch(requesterId);
    await requester.send(payload);
  } catch {
    // قد تكون الرسائل الخاصة معطلة؛ تظل قناة الطلب مسار التسليم الاحتياطي.
  }
  if (channelId) {
    const channel = await client.channels.fetch(channelId);
    if (channel?.isTextBased() && "send" in channel) await channel.send({ content: `<@${requesterId}>`, ...payload });
  }
}

export async function sendOwnerAlert(message: string): Promise<void> {
  if (!client || !ENV.ownerDiscordUserId) return;
  const owner = await client.users.fetch(ENV.ownerDiscordUserId);
  await owner.send({ embeds: [jobEmbed({ status: "failed", title: "تنبيه المنصة", description: message })] });
}
