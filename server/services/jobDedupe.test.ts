import { describe, expect, it } from "vitest";
import { isChapterRequestDuplicate } from "./jobDedupe";

describe("chapter request deduplication", () => {
  it("identifies an identical canonical URL hash as a duplicate request", () => {
    expect(isChapterRequestDuplicate("a".repeat(64), "a".repeat(64))).toBe(true);
  });

  it("does not block a different chapter URL hash", () => {
    expect(isChapterRequestDuplicate("a".repeat(64), "b".repeat(64))).toBe(false);
    expect(isChapterRequestDuplicate("", "b".repeat(64))).toBe(false);
  });
});
