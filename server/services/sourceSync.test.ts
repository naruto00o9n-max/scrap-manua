import { describe, expect, it } from "vitest";
import type { SuwayomiSource } from "./suwayomi";
import {
  hostnameFromHomeUrl,
  isPlaceholderHostname,
  planHostnameHeals,
  planSourceChanges,
  sourceLangBackfills,
  type SyncPlan,
} from "./sourceSync";

function installed(id: string, name: string, homeUrl: string | null = null, lang = "en"): SuwayomiSource {
  return {
    id,
    name,
    displayName: name,
    homeUrl,
    lang,
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

describe("sourceLangBackfills", () => {
  it("proposes language backfill only for auto-synced rows missing lang", () => {
    const existing = [
      { id: 1, suwayomiSourceId: "src-ar", status: "active", origin: "suwayomi", hostname: "a.com" },
      { id: 2, suwayomiSourceId: "src-en", status: "active", origin: "suwayomi", hostname: "b.com", lang: "en" },
      { id: 3, suwayomiSourceId: "src-manual", status: "active", origin: "manual", hostname: "c.com" },
      { id: 4, suwayomiSourceId: "src-gone", status: "active", origin: "suwayomi", hostname: "d.com" },
    ];
    const backfills = sourceLangBackfills(existing, [
      installed("src-ar", "ArabicSite", "https://a.com", "ar"),
      installed("src-en", "EnglishSite", "https://b.com", "en"),
    ]);
    expect(backfills).toEqual([{ row: existing[0], lang: "ar" }]);
  });

  it("passes the full row through untouched so saveSource keeps its fields", () => {
    const fullRow = {
      id: 9,
      suwayomiSourceId: "src-x",
      status: "active",
      origin: "suwayomi" as const,
      hostname: "x.com",
      name: "XSite",
      baseUrl: "https://x.com",
      extensionPackage: null,
      extensionName: null,
      allowDirectChapterLookup: true,
      notes: null,
    };
    const backfills = sourceLangBackfills([fullRow], [installed("src-x", "XSite", "https://x.com", "ja")]);
    expect(backfills).toHaveLength(1);
    expect(backfills[0]!.row).toBe(fullRow);
    expect(backfills[0]!.row.name).toBe("XSite");
    expect(backfills[0]!.lang).toBe("ja");
  });
});

describe("owner source control", () => {
  it("never touches owner-locked rows in activate or disable paths", () => {
    // المالك عطّل الموقع من إدارة المواقع: المزامنة لا تعيد تفعيله
    const lockedDisabled = planSourceChanges(
      [installed("locked-source", "LockedSite", "https://locked.example")],
      [
        {
          id: 7,
          suwayomiSourceId: "locked-source",
          status: "disabled",
          origin: "suwayomi",
          hostname: "locked.example",
          ownerLocked: true,
        },
      ]
    );
    expect(lockedDisabled.activate).toHaveLength(0);
    expect(lockedDisabled.keep).toBe(1);
    // والمزامنة لا تعطّل موقعًا قفله المالك حتى لو أُزيلت إضافته
    const lockedActiveGone = planSourceChanges(
      [],
      [
        {
          id: 8,
          suwayomiSourceId: "gone-source",
          status: "active",
          origin: "suwayomi",
          hostname: "gone.example",
          ownerLocked: true,
        },
      ]
    );
    expect(lockedActiveGone.disable).toHaveLength(0);
  });

  it("never re-creates sources on the owner's blocked list (deleted sites)", () => {
    const bySourceId = planSourceChanges(
      [installed("blocked-source", "BlockedSite", "https://blocked.example")],
      [],
      { suwayomiSourceIds: ["blocked-source"], hostnames: [] }
    );
    expect(bySourceId.create).toHaveLength(0);
    expect(bySourceId.blockedSkipped).toBe(1);
    const byHostname = planSourceChanges(
      [installed("other-source", "OtherSite", "https://blocked.example")],
      [],
      { suwayomiSourceIds: [], hostnames: ["blocked.example"] }
    );
    expect(byHostname.create).toHaveLength(0);
    expect(byHostname.blockedSkipped).toBe(1);
    // بلا قائمة حجب يُعاد إنشاؤه كالعادة
    const unblocked = planSourceChanges(
      [installed("blocked-source", "BlockedSite", "https://blocked.example")],
      []
    );
    expect(unblocked.create).toHaveLength(1);
    expect(unblocked.blockedSkipped).toBe(0);
  });
});

describe("isPlaceholderHostname", () => {
  it("matches only the auto-sync placeholder format", () => {
    expect(isPlaceholderHostname("suwayomi-1911019612901009263.sync.internal")).toBe(true);
    expect(isPlaceholderHostname("evascans.net")).toBe(false);
    expect(isPlaceholderHostname("suwayomi-x.sync.internal")).toBe(false);
    expect(isPlaceholderHostname("example.com/suwayomi-1.sync.internal")).toBe(false);
  });
});

describe("planHostnameHeals", () => {
  it("heals a placeholder row once the server reports the real homeUrl", () => {
    // صف سُجّل بنطاق مؤقت حين كان homeUrl فارغًا — ثم أعلن الخادم النطاق الحقيقي
    const heals = planHostnameHeals(
      [installed("eva", "Eva Scans", "https://evascans.net")],
      [{ id: 3, suwayomiSourceId: "eva", status: "active", origin: "suwayomi", hostname: "suwayomi-1911019612901009263.sync.internal" }]
    );
    expect(heals).toEqual([{ source: expect.objectContaining({ id: "eva" }), hostname: "evascans.net" }]);
  });

  it("does not heal rows with real hostnames, manual rows, or unknown sources", () => {
    const installedSources = [installed("eva", "Eva Scans", "https://evascans.net")];
    const heals = planHostnameHeals(installedSources, [
      { id: 1, suwayomiSourceId: "eva", status: "active", origin: "suwayomi", hostname: "evascans.net" },
      { id: 2, suwayomiSourceId: "gone", status: "active", origin: "suwayomi", hostname: "suwayomi-42.sync.internal" },
      { id: 3, suwayomiSourceId: "eva", status: "active", origin: "manual", hostname: "suwayomi-43.sync.internal" },
      { id: 4, suwayomiSourceId: null, status: "active", origin: "suwayomi", hostname: "suwayomi-44.sync.internal" },
    ]);
    expect(heals).toHaveLength(0);
  });

  it("does not heal when the homeUrl is still missing", () => {
    const heals = planHostnameHeals(
      [installed("mystery", "Mystery", null)],
      [{ id: 5, suwayomiSourceId: "mystery", status: "active", origin: "suwayomi", hostname: "suwayomi-77.sync.internal" }]
    );
    expect(heals).toHaveLength(0);
  });

  it("does not heal onto a hostname held by another row", () => {
    const heals = planHostnameHeals(
      [installed("md-cs", "MangaDex (CS)", "https://mangadex.org")],
      [
        { id: 1, suwayomiSourceId: "md-en", status: "active", origin: "suwayomi", hostname: "mangadex.org" },
        { id: 2, suwayomiSourceId: "md-cs", status: "active", origin: "suwayomi", hostname: "suwayomi-91.sync.internal" },
      ]
    );
    expect(heals).toHaveLength(0);
  });

  it("respects the owner's block list (deleted sites)", () => {
    const existing = [{ id: 6, suwayomiSourceId: "eva", status: "active", origin: "suwayomi", hostname: "suwayomi-1911019612901009263.sync.internal" }];
    const byHostname = planHostnameHeals(
      [installed("eva", "Eva Scans", "https://evascans.net")],
      existing,
      { suwayomiSourceIds: [], hostnames: ["evascans.net"] }
    );
    expect(byHostname).toHaveLength(0);
    const bySourceId = planHostnameHeals(
      [installed("eva", "Eva Scans", "https://evascans.net")],
      existing,
      { suwayomiSourceIds: ["eva"], hostnames: [] }
    );
    expect(bySourceId).toHaveLength(0);
  });

  it("heals each placeholder row once and keeps the first claim when two rows want one hostname", () => {
    const heals = planHostnameHeals(
      [
        installed("eva", "Eva Scans", "https://evascans.net"),
        installed("eva2", "Eva Scans Mirror", "https://evascans.net"),
      ],
      [
        { id: 1, suwayomiSourceId: "eva", status: "active", origin: "suwayomi", hostname: "suwayomi-1.sync.internal" },
        { id: 2, suwayomiSourceId: "eva2", status: "active", origin: "suwayomi", hostname: "suwayomi-2.sync.internal" },
      ]
    );
    expect(heals).toHaveLength(1);
    expect(heals[0]!.hostname).toBe("evascans.net");
  });
});
