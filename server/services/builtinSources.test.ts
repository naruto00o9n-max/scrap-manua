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
    const plan = planBuiltinSources(["page.kakao.com", "comix.to", "m.ac.qq.com", "kuaikanmanhua.com"]);
    expect(plan.every(action => action.kind === "keep" && action.reason === "registered")).toBe(true);
    expect(plan.map(action => action.spec.hostname)).toEqual([
      "page.kakao.com",
      "comix.to",
      "m.ac.qq.com",
      "kuaikanmanhua.com",
    ]);
  });

  it("respects the owner block list — a deleted site is never re-registered", () => {
    const plan = planBuiltinSources([], ["comix.to"]);
    const comix = plan.find(action => action.spec.hostname === "comix.to");
    expect(comix).toEqual({
      kind: "keep",
      reason: "blocked",
      spec: expect.objectContaining({ hostname: "comix.to" }),
    });
    // ما لم يُحجب يبقى في خطة التسجيل كالمعتاد
    expect(plan.find(action => action.spec.hostname === "page.kakao.com")?.kind).toBe("create");
  });

  it("normalizes www and letter case before comparing hostnames", () => {
    const plan = planBuiltinSources([
      "WWW.Page.Kakao.COM",
      "WWW.Comix.TO",
      "M.AC.QQ.COM",
      "WWW.KuaikanManhua.COM",
    ]);
    expect(plan.every(action => action.kind === "keep")).toBe(true);
  });
});
