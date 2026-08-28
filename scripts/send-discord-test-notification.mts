import { REST, Routes } from "discord.js";
import { ENV } from "../server/_core/env";

if (!ENV.discordBotToken || !ENV.ownerDiscordUserId) {
  throw new Error("Discord bot token and owner ID are required.");
}

const rest = new REST({ version: "10" }).setToken(ENV.discordBotToken);
const channel = await rest.post(Routes.userChannels(), { body: { recipient_id: ENV.ownerDiscordUserId } }) as { id: string };
await rest.post(Routes.channelMessages(channel.id), {
  body: {
    content: "اختبار Manga Drive Discord Bot: اكتمل اختبار الفصل 157 بنجاح، وتم إنشاء مجلد Google Drive ورفع 25 صفحة مرتبة.",
  },
});
console.log("Discord test notification sent.");
process.exit(0);
