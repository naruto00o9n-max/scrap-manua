import { ENV } from "../_core/env";

export type IntegrationConfiguration = {
  discord: boolean;
  googleDrive: boolean;
  suwayomi: boolean;
};

export function getIntegrationConfiguration(): IntegrationConfiguration {
  return {
    discord: Boolean(ENV.discordBotToken && ENV.discordApplicationId),
    googleDrive: Boolean(
      ENV.googleDriveClientId && ENV.googleDriveClientSecret && ENV.googleDriveRefreshToken,
    ),
    suwayomi: Boolean(ENV.suwayomiBaseUrl),
  };
}

export function getUsableSuwayomiToken(): string {
  const candidate = ENV.suwayomiApiToken.trim();
  return /^[\x21-\x7E]+$/.test(candidate) ? candidate : "";
}
