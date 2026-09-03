import { REST, Routes } from "discord.js";
import { ENV } from "../server/_core/env";

// الأوامر الآن تُسجَّل عالميًا وتعمل في كل السيرفرات؛ DISCORD_GUILD_ID
// لم يعد مطلوبًا — إن وُجد نعرض اسم السيرفر للمرجعية فقط.
if (!ENV.discordBotToken || !ENV.discordApplicationId) {
  throw new Error("Discord settings are incomplete.");
}

const rest = new REST({ version: "10" }).setToken(ENV.discordBotToken);
const application = (await rest.get(Routes.currentApplication())) as {
  id: string;
  name: string;
  bot_public: boolean;
};
const commands = (await rest.get(
  Routes.applicationCommands(ENV.discordApplicationId)
)) as Array<{ id: string; name: string; description: string; version: string }>;

let guildName: string | null = null;
if (ENV.discordGuildId) {
  try {
    const guild = (await rest.get(Routes.guild(ENV.discordGuildId))) as {
      name: string;
    };
    guildName = guild.name;
  } catch {
    guildName = null;
  }
}

console.log(
  JSON.stringify({
    configuredApplicationId: ENV.discordApplicationId,
    applicationId: application.id,
    applicationName: application.name,
    scope: "global",
    referenceGuildId: ENV.discordGuildId || null,
    referenceGuildName: guildName,
    commands: commands.map(command => ({
      id: command.id,
      name: command.name,
      description: command.description,
      version: command.version,
    })),
  })
);
process.exit(0);
