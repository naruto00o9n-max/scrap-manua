import { timingSafeEqual } from "node:crypto";
import { saveIntegrationHealth } from "../db";
import { ENV } from "../_core/env";
import { recordOwnerAlert } from "./alerts";
import { isDiscordBotReady } from "./discordBot";
import { GoogleDriveClient } from "./googleDrive";
import { getIntegrationConfiguration, getUsableSuwayomiToken } from "./settings";
import { SuwayomiClient } from "./suwayomi";

type MonitorResult = { service: string; healthy: boolean; message: string };

export function isMonitorRequestAuthorized(rawToken: string | undefined): boolean {
  const expected = ENV.integrationMonitorToken;
  if (!rawToken || !expected || rawToken.length !== expected.length) return false;
  return timingSafeEqual(Buffer.from(rawToken), Buffer.from(expected));
}

async function checkService(service: string, isConfigured: boolean, check: () => Promise<void>): Promise<MonitorResult> {
  if (!isConfigured) {
    const message = `إعدادات ${service} غير مكتملة في أسرار الخادم.`;
    await saveIntegrationHealth(service, "offline", message);
    await recordOwnerAlert(service, "critical", message);
    return { service, healthy: false, message };
  }
  try {
    await check();
    await saveIntegrationHealth(service, "healthy", "فحص خارجي ناجح.");
    return { service, healthy: true, message: "اتصال سليم" };
  } catch (error) {
    const message = error instanceof Error ? error.message : `تعذر فحص ${service}.`;
    await saveIntegrationHealth(service, "offline", message);
    await recordOwnerAlert(service, "critical", `${service}: ${message}`);
    return { service, healthy: false, message };
  }
}

export async function runIntegrationMonitor(): Promise<MonitorResult[]> {
  const configuration = getIntegrationConfiguration();
  return Promise.all([
    checkService("discord", configuration.discord, async () => {
      if (!isDiscordBotReady()) throw new Error("بوت Discord غير متصل حاليًا.");
    }),
    checkService("google-drive", configuration.googleDrive, async () => {
      await new GoogleDriveClient().healthcheck();
    }),
    checkService("suwayomi", configuration.suwayomi, async () => {
      await new SuwayomiClient(ENV.suwayomiBaseUrl, getUsableSuwayomiToken()).healthcheck();
    }),
  ]);
}
