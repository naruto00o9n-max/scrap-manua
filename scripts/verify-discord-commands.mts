import { REST, Routes } from "discord.js";
import { ENV } from "../server/_core/env";

if (!ENV.discordBotToken || !ENV.discordApplicationId || !ENV.discordGuildId) {
  throw new Error("Discord settings are incomplete.");
}

const rest = new REST({ version: "10" }).setToken(ENV.discordBotToken);
const [application, guild, commands] = await Promise.all([
  rest.get(Routes.currentApplication()) as Promise<{ id: string; name: string; bot_public: boolean }> ,
  rest.get(Routes.guild(ENV.discordGuildId)) as Promise<{ id: string; name: string }> ,
  rest.get(Routes.applicationGuildCommands(ENV.discordApplicationId, ENV.discordGuildId)) as Promise<Array<{ id: string; name: string; description: string; version: string }>>,
]);

console.log(JSON.stringify({
  configuredApplicationId: ENV.discordApplicationId,
  applicationId: application.id,
  applicationName: application.name,
  guildId: ENV.discordGuildId,
  guildName: guild.name,
  commands: commands.map(command => ({ id: command.id, name: command.name, description: command.description, version: command.version })),
}));
process.exit(0);
