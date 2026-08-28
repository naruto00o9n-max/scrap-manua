import { ActionRowBuilder, ButtonBuilder, ButtonStyle, EmbedBuilder, REST, Routes } from "discord.js";
import { ENV } from "../server/_core/env";

if (!ENV.discordBotToken || !ENV.ownerDiscordUserId) throw new Error("Discord bot token and owner ID are required.");

const rest = new REST({ version: "10" }).setToken(ENV.discordBotToken);
const channel = await rest.post(Routes.userChannels(), { body: { recipient_id: ENV.ownerDiscordUserId } }) as { id: string };
const embed = new EmbedBuilder()
  .setColor(0x30B978)
  .setTitle("مكتمل · معاينة بطاقة Manga Drive")
  .setDescription("هذه معاينة للبطاقة التي ستصل عند اكتمال حفظ فصل. تعرض الحالة وعدد الصفحات وزر الوصول المباشر إلى Google Drive.")
  .addFields(
    { name: "الصفحات", value: "25", inline: true },
    { name: "معرّف المهمة", value: "`0d6d1bda…`", inline: true },
  )
  .setFooter({ text: "Manga Drive • بطاقة الحالة" })
  .setTimestamp();
const row = new ActionRowBuilder<ButtonBuilder>().addComponents(
  new ButtonBuilder().setStyle(ButtonStyle.Link).setLabel("فتح Google Drive").setURL("https://drive.google.com/drive/folders/1Y11BA520yCpAXsHE7ADP4NyakGWYl3mG"),
);
await rest.post(Routes.channelMessages(channel.id), { body: { embeds: [embed.toJSON()], components: [row.toJSON()] } });
console.log("Discord card preview sent.");
process.exit(0);
