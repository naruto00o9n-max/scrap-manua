import { Client, Events, GatewayIntentBits, REST, Routes, SlashCommandBuilder } from "discord.js";
import { ENV } from "../_core/env";
import { listActiveDiscordRoleIds, saveIntegrationHealth } from "../db";
import { queueAuthorizedChapter } from "./jobs";
import { UrlPolicyError } from "./urlPolicy";

let client: Client | null = null;
let started = false;

export function isDiscordBotReady(): boolean {
  return Boolean(client?.isReady());
}

const chapterCommand = new SlashCommandBuilder()
  .setName("فصل")
  .setDescription("إرسال رابط فصل مصرح به إلى طابور الحفظ")
  .addStringOption(option => option.setName("الرابط").setDescription("رابط الفصل الكامل").setRequired(true));

function hasAllowedRole(roleIds: readonly string[], allowedRoleIds: readonly string[]) {
  return allowedRoleIds.some(roleId => roleIds.includes(roleId));
}

export async function startDiscordBot(): Promise<void> {
  if (started || !ENV.discordBotToken || !ENV.discordApplicationId || !ENV.discordGuildId) return;
  started = true;
  client = new Client({ intents: [GatewayIntentBits.Guilds] });

  client.once(Events.ClientReady, async readyClient => {
    console.info(`[Discord] Connected as ${readyClient.user.tag}`);
    try {
      const rest = new REST({ version: "10" }).setToken(ENV.discordBotToken);
      await rest.put(Routes.applicationGuildCommands(ENV.discordApplicationId, ENV.discordGuildId), { body: [chapterCommand.toJSON()] });
      console.info("[Discord] Guild command registered");
      await saveIntegrationHealth("discord", "healthy", `البوت متصل وسُجل أمر الفصل في Guild ${ENV.discordGuildId}.`);
    } catch (error) {
      console.error("[Discord] Command registration failed", error);
      await saveIntegrationHealth("discord", "degraded", "اتصل البوت لكن تعذر تسجيل أمر الفصل في Discord.");
    }
  });

  client.on(Events.InteractionCreate, async interaction => {
    if (!interaction.isChatInputCommand() || interaction.commandName !== "فصل") return;
    if (!interaction.inGuild() || !interaction.member || !interaction.channelId) {
      await interaction.reply({ content: "يُستخدم هذا الأمر داخل السيرفر فقط.", ephemeral: true });
      return;
    }

    const allowedRoleIds = await listActiveDiscordRoleIds();
    const memberRoleIds = Array.isArray(interaction.member.roles)
      ? interaction.member.roles
      : interaction.member.roles.cache.map(role => role.id);
    if (!allowedRoleIds.length || !hasAllowedRole(memberRoleIds, allowedRoleIds)) {
      await interaction.reply({ content: "ليس لديك دور معتمد لاستخدام أمر الفصول. تواصل مع مدير الفريق.", ephemeral: true });
      return;
    }

    const chapterUrl = interaction.options.getString("الرابط", true);
    await interaction.deferReply({ ephemeral: true });
    try {
      const { job, created } = await queueAuthorizedChapter({
        chapterUrl,
        requester: { discordId: interaction.user.id, displayName: interaction.member.user.username, channelId: interaction.channelId },
      });
      if (!created) {
        const existingLink = job.googleDriveUrl ? ` رابط Google Drive: ${job.googleDriveUrl}` : "";
        await interaction.editReply(`هذا الرابط مسجل مسبقًا بحالة «${job.status}».${existingLink}`);
        return;
      }
      await interaction.editReply("تم قبول الرابط ووضعه في طابور المعالجة. سأرسل النتيجة في هذه القناة عند اكتمال الرفع.");
      void import("./jobWorker").then(({ processPendingChapterJobs }) => processPendingChapterJobs());
    } catch (error) {
      const message = error instanceof UrlPolicyError ? error.message : "تعذر قبول الطلب. تحقق من المصدر وإعداداته ثم أعد المحاولة.";
      await interaction.editReply(message);
    }
  });

  client.on(Events.Error, error => {
    console.error("[Discord] Client error", error);
    void saveIntegrationHealth("discord", "offline", "تعرض اتصال Discord لخطأ.");
  });
  await client.login(ENV.discordBotToken);
}

export async function sendJobUpdate(channelId: string | null, requesterId: string, message: string): Promise<void> {
  if (!client) return;
  try {
    const requester = await client.users.fetch(requesterId);
    await requester.send({ content: message });
  } catch {
    // قد تكون الرسائل الخاصة معطلة؛ تظل قناة الطلب مسار التسليم الاحتياطي.
  }
  if (channelId) {
    const channel = await client.channels.fetch(channelId);
    if (channel?.isTextBased() && "send" in channel) await channel.send({ content: `<@${requesterId}> ${message}` });
  }
}

export async function sendOwnerAlert(message: string): Promise<void> {
  if (!client || !ENV.ownerDiscordUserId) return;
  const owner = await client.users.fetch(ENV.ownerDiscordUserId);
  await owner.send({ content: `تنبيه دار الفصول: ${message}` });
}
