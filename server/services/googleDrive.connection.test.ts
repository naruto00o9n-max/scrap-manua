import { describe, expect, it } from "vitest";
import { GoogleDriveClient } from "./googleDrive";

describe("Google Drive connection", () => {
  it("authenticates with the configured OAuth refresh token using a read-only listing", async () => {
    const drive = new GoogleDriveClient();
    await expect(drive.healthcheck()).resolves.toBeUndefined();
  }, 20_000);
});
