import { describe, expect, it } from "vitest";
import { ENV } from "../_core/env";
import { getUsableSuwayomiToken } from "./settings";
import { SuwayomiClient } from "./suwayomi";

describe("Suwayomi connection", () => {
  it("responds to a read-only health query using the configured server settings", async () => {
    expect(ENV.suwayomiBaseUrl).toMatch(/^https:\/\//);

    const client = new SuwayomiClient(ENV.suwayomiBaseUrl, getUsableSuwayomiToken());
    await expect(client.healthcheck()).resolves.toBeUndefined();
  }, 15_000);
});
