import { describe, expect, it } from "vitest";
import type { SuwayomiSource } from "./suwayomi";
import {
  hostnameFromHomeUrl,
  planSourceChanges,
  type SyncPlan,
} from "./sourceSync";

function installed(id: string, name: string, homeUrl: string | null = null): SuwayomiSource {
  return {
    id,
    name,
    displayName: name,
    homeUrl,
    lang: "en",
    extension: { name: name, pkgName: id, isInstalled: true },
  };
}

function row(id: number, suwayomiSourceId: string | null, status = "active", origin: string | null = null, hostname = "example.com") {
  return { id, suwayomiSourceId, status, origin, hostname };
}

describe("hostnameFromHomeUrl", () => {
  it("extracts and normalizes the host", () => {
    expect(hostnameFromHomeUrl("https://www.RokariComics.com/manga/")).toBe("rokaricomics.com");
    expect(hostnameFromHomeUrl("http://sub.example.com")).toBe("sub.example.com");
  });

  it("returns null for missing or invalid values", () => {
    expect(hostnameFromHomeUrl(null)).toBeNull();
    expect(hostnameFromHomeUrl("")).toBeNull();
    expect(hostnameFromHomeUrl("not-a-url")).toBeNull();
    expect(hostnameFromHomeUrl("ftp://files.example.com")).toBeNull();
  });
});

describe("planSourceChanges", () => {
  it("creates rows for newly installed sources and derives hostnames", () => {
    const plan: SyncPlan = planSourceChanges(
      [installed("rokaricomics", "RokariComics", "https://rokaricomics.com")],
      []
    );
    expect(plan.create).toHaveLength(1);
    expect(plan.create[0]!.hostname).toBe("rokaricomics.com");
    expect(plan.disable).toHaveLength(0);
  });

  it("keeps manual rows untouched even when not installed", () => {
    const plan = planSourceChanges([], [row(1, "gone-source", "active", null)]);
    expect(plan.disable).toHaveLength(0);
    expect(plan.keep).toBe(0);
  });

  it("disables auto-synced rows whose source was removed from Suwayomi", () => {
    const plan = planSourceChanges([], [row(1, "gone-source", "active", "suwayomi")]);
    expect(plan.disable).toEqual([1]);
  });

  it("re-activates auto-synced rows that came back and keeps active ones", () => {
    const plan = planSourceChanges(
      [installed("src-a", "A"), installed("src-b", "B")],
      [row(1, "src-a", "disabled", "suwayomi"), row(2, "src-b", "active", "suwayomi")]
    );
    expect(plan.activate).toEqual([1]);
    expect(plan.keep).toBe(1);
    expect(plan.disable).toHaveLength(0);
  });

  it("ignores manual rows even if uninstalled and disables only matching auto origin", () => {
    const plan = planSourceChanges(
      [installed("live", "Live")],
      [row(1, "dead", "active", "suwayomi"), row(2, "dead2", "active", null)]
    );
    expect(plan.disable).toEqual([1]);
  });

  it("skips sources whose hostname is already held by an existing row (E11000)", () => {
    // عشرات لغات MangaDex كلها على mangadex.org، وهناك صف يدوي يحجز النطاق.
    const plan = planSourceChanges(
      [
        installed("md-en", "MangaDex (EN)", "https://mangadex.org"),
        installed("md-cs", "MangaDex (CS)", "https://mangadex.org"),
      ],
      [row(7, null, "active", null, "mangadex.org")]
    );
    expect(plan.create).toHaveLength(0);
    expect(plan.skippedHostname).toBe(2);
  });

  it("skips later sources sharing a hostname within the same batch", () => {
    const plan = planSourceChanges(
      [
        installed("md-en", "MangaDex (EN)", "https://mangadex.org"),
        installed("md-fr", "MangaDex (FR)", "https://mangadex.org"),
        installed("wt-en", "Webtoons (EN)", "https://www.webtoons.com"),
        installed("wt-fr", "Webtoons (FR)", "https://www.webtoons.com"),
      ],
      []
    );
    expect(plan.create.map(action => action.source.id)).toEqual(["md-en", "wt-en"]);
    expect(plan.skippedHostname).toBe(2);
  });

  it("still creates sources without a resolvable hostname (placeholder path)", () => {
    const plan = planSourceChanges(
      [installed("mystery", "Mystery", null), installed("mystery2", "Mystery 2", null)],
      []
    );
    expect(plan.create).toHaveLength(2);
    expect(plan.skippedHostname).toBe(0);
    expect(plan.create.every(action => action.hostname === null)).toBe(true);
  });
});
