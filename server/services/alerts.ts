import { createHash } from "node:crypto";
import { createIntegrationAlert, markIntegrationAlertDelivered } from "../db";
import { ENV } from "../_core/env";
import { sendOwnerAlert } from "./discordBot";

export async function recordOwnerAlert(
  service: string,
  severity: "warning" | "critical",
  message: string,
): Promise<void> {
  const fingerprint = createHash("sha256").update(`${service}:${message}`).digest("hex").slice(0, 120);
  const alert = await createIntegrationAlert({ service, severity, fingerprint, message, recipientDiscordUserId: ENV.ownerDiscordUserId || undefined });
  if (alert.reused) return;
  try {
    await sendOwnerAlert(message);
    await markIntegrationAlertDelivered(alert.id, "sent");
  } catch {
    await markIntegrationAlertDelivered(alert.id, "failed");
  }
}
