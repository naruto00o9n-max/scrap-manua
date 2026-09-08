import { describe, expect, it, vi } from "vitest";

import { isTransientSuwayomiFailure, withTransientRetry } from "./suwayomi";

describe("transient failure detection", () => {
  it("treats cold-start timeouts and 5xx as transient", () => {
    expect(isTransientSuwayomiFailure(new Error("تعذر الوصول إلى خادم السحب (500)."))).toBe(true);
    expect(isTransientSuwayomiFailure(new Error("The operation was aborted due to timeout"))).toBe(true);
    expect(isTransientSuwayomiFailure(new Error("fetch failed"))).toBe(true);
    expect(isTransientSuwayomiFailure(new Error("socket hang up"))).toBe(true);
  });

  it("treats policy and deterministic errors as non-transient", () => {
    expect(isTransientSuwayomiFailure(new Error("هذا النطاق غير مدرج ضمن المصادر المسموح بها."))).toBe(false);
    // 404 يعني عنوانًا خاطئًا — إعادة المحاولة لن تغيّره
    expect(isTransientSuwayomiFailure(new Error("تعذر الوصول إلى خادم السحب (404)."))).toBe(false);
    expect(isTransientSuwayomiFailure(new Error("Unsupported url"))).toBe(false);
  });
});

describe("withTransientRetry", () => {
  it("retries transient failures until success", async () => {
    vi.useFakeTimers();
    let calls = 0;
    const operation = vi.fn(async () => {
      calls += 1;
      if (calls < 3) throw new Error("fetch failed");
      return "ok";
    });
    const pending = withTransientRetry(operation, { attempts: 3, backoffMs: [10, 10] });
    await vi.runAllTimersAsync();
    await expect(pending).resolves.toBe("ok");
    expect(calls).toBe(3);
    vi.useRealTimers();
  });

  it("rethrows non-transient failures immediately without retrying", async () => {
    const operation = vi.fn(async () => {
      throw new Error("هذا المصدر غير مربوط بمصدر معتمد بعد.");
    });
    await expect(withTransientRetry(operation, { attempts: 3 })).rejects.toThrow(
      "هذا المصدر غير مربوط بمصدر معتمد بعد."
    );
    expect(operation).toHaveBeenCalledTimes(1);
  });

  it("throws the last error after exhausting attempts", async () => {
    vi.useFakeTimers();
    let calls = 0;
    const operation = vi.fn(async () => {
      calls += 1;
      throw new Error("تعذر الوصول إلى خادم السحب (503).");
    });
    const expected = expect(
      withTransientRetry(operation, { attempts: 3, backoffMs: [10, 10] })
    ).rejects.toThrow("(503)");
    await vi.runAllTimersAsync();
    await expected;
    expect(calls).toBe(3);
    vi.useRealTimers();
  });

  it("honors a custom transient predicate", async () => {
    const operation = vi.fn(async () => {
      throw new Error("custom transient");
    });
    await expect(
      withTransientRetry(operation, {
        attempts: 2,
        backoffMs: [1],
        isTransient: error => (error as Error).message === "custom transient",
      })
    ).rejects.toThrow("custom transient");
    expect(operation).toHaveBeenCalledTimes(2);
  });
});
