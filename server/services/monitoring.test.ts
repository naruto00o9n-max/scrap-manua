import { describe, expect, it, vi } from "vitest";

vi.mock("../_core/env", () => ({ ENV: { integrationMonitorToken: "test-monitor-token" } }));

describe("monitor endpoint authorization", () => {
  it("accepts only the configured monitoring token", async () => {
    const { isMonitorRequestAuthorized } = await import("./monitoring");
    expect(isMonitorRequestAuthorized("test-monitor-token")).toBe(true);
    expect(isMonitorRequestAuthorized("other-token")).toBe(false);
    expect(isMonitorRequestAuthorized(undefined)).toBe(false);
  });
});
