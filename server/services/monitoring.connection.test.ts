import { describe, expect, it } from "vitest";

describe("integration monitor endpoint", () => {
  it("accepts the configured monitor token for a lightweight integration check", async () => {
    const token = process.env.INTEGRATION_MONITOR_TOKEN;
    expect(token).toBeTruthy();

    const response = await fetch("http://localhost:3000/api/internal/run-monitor", {
      method: "POST",
      headers: { "x-monitor-token": token! },
      signal: AbortSignal.timeout(20_000),
    });
    expect([200, 503]).toContain(response.status);
    const body = await response.json() as { results?: Array<{ service: string; healthy: boolean }> };
    expect(body.results).toHaveLength(3);
  }, 25_000);
});
