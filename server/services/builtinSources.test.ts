import { describe, expect, it } from "vitest";
import {
  BUILTIN_SOURCES,
  planBuiltinSources,
} from "./builtinSources";

describe("planBuiltinSources", () => {
  it("creates missing builtin sources", () => {
    const plan = planBuiltinSources(["webtoons.com", "mangaswat.com"]);
    expect(plan).toHaveLength(BUILTIN_SOURCES.length);
    for (const action of plan) {
      expect(action.kind).toBe("create");
    }
    const kakao = plan.find(action => action.spec.hostname === "page.kakao.com");
    expect(kakao?.kind).toBe("create");
  });

  it("keeps already-registered hostnames untouched (any status)", () => {
    const plan = planBuiltinSources(["page.kakao.com"]);
    expect(plan).toEqual([
      {
        kind: "keep",
        reason: "registered",
        spec: expect.objectContaining({ hostname: "page.kakao.com" }),
      },
    ]);
  });

  it("respects the owner block list — a deleted site is never re-registered", () => {
    const plan = planBuiltinSources([], ["page.kakao.com"]);
    expect(plan).toEqual([
      {
        kind: "keep",
        reason: "blocked",
        spec: expect.objectContaining({ hostname: "page.kakao.com" }),
      },
    ]);
  });

  it("normalizes www and letter case before comparing hostnames", () => {
    const plan = planBuiltinSources(["WWW.Page.Kakao.COM"]);
    expect(plan.every(action => action.kind === "keep")).toBe(true);
  });
});
