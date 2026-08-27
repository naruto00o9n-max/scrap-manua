import { describe, expect, it } from "vitest";
import { assertJobTransition, canTransitionJob } from "./jobState";
import { buildPageFilename } from "./googleDrive";

describe("job state transitions", () => {
  it("allows the expected lifecycle from queue to uploaded chapter", () => {
    expect(canTransitionJob("pending", "downloading")).toBe(true);
    expect(canTransitionJob("downloading", "uploading")).toBe(true);
    expect(canTransitionJob("uploading", "completed")).toBe(true);
  });

  it("prevents reopening a completed or cancelled task", () => {
    expect(canTransitionJob("completed", "downloading")).toBe(false);
    expect(() => assertJobTransition("cancelled", "uploading")).toThrow(/غير مسموح/);
  });
});

describe("Google Drive page filenames", () => {
  it("uses stable zero-padded order with the returned media type", () => {
    expect(buildPageFilename(1, "image/webp; charset=binary")).toBe("001.webp");
    expect(buildPageFilename(12, "image/png")).toBe("012.png");
    expect(buildPageFilename(123, null)).toBe("123.jpg");
  });
});
