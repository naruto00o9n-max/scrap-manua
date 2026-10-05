import { describe, expect, it } from "vitest";
import {
  SOURCES_PAGE_LIMIT,
  collectAllSourcePages,
  type SuwayomiSource,
  type SuwayomiSourcePage,
} from "./suwayomi";

function source(id: string, name = `S-${id}`): SuwayomiSource {
  return { id, name, displayName: name, homeUrl: `https://${id}.example`, lang: "en", extension: null };
}

describe("collectAllSourcePages", () => {
  it("returns the nodes of a single page without pageInfo", async () => {
    const calls: Array<string | null> = [];
    const nodes = await collectAllSourcePages(async after => {
      calls.push(after);
      return { nodes: [source("a"), source("b")] };
    });
    expect(nodes.map(item => item.id)).toEqual(["a", "b"]);
    expect(calls).toEqual([null]);
  });

  it("follows endCursor until hasNextPage is false", async () => {
    const pages: SuwayomiSourcePage[] = [
      { nodes: [source("a"), source("b")], pageInfo: { hasNextPage: true, endCursor: "cursor-2" } },
      { nodes: [source("c")], pageInfo: { hasNextPage: true, endCursor: "cursor-3" } },
      { nodes: [source("d")], pageInfo: { hasNextPage: false, endCursor: "cursor-4" } },
    ];
    const cursors: Array<string | null> = [];
    const nodes = await collectAllSourcePages(async after => {
      cursors.push(after);
      return pages[cursors.length - 1]!;
    });
    expect(nodes.map(item => item.id)).toEqual(["a", "b", "c", "d"]);
    expect(cursors).toEqual([null, "cursor-2", "cursor-3"]);
  });

  it("dedupes nodes repeated across pages", async () => {
    const pages: SuwayomiSourcePage[] = [
      { nodes: [source("a"), source("b")], pageInfo: { hasNextPage: true, endCursor: "c2" } },
      { nodes: [source("b"), source("c")], pageInfo: { hasNextPage: false } },
    ];
    const nodes = await collectAllSourcePages(async after => pages[after === null ? 0 : 1]!);
    expect(nodes.map(item => item.id)).toEqual(["a", "b", "c"]);
  });

  it("stops safely when hasNextPage is true but no endCursor comes back", async () => {
    let calls = 0;
    const nodes = await collectAllSourcePages(async () => {
      calls += 1;
      return { nodes: [source("only")], pageInfo: { hasNextPage: true, endCursor: null } };
    });
    expect(nodes.map(item => item.id)).toEqual(["only"]);
    expect(calls).toBe(1);
  });

  it("stops safely when the cursor does not advance", async () => {
    let calls = 0;
    const nodes = await collectAllSourcePages(async after => {
      calls += 1;
      return { nodes: [source(`p${calls}`)], pageInfo: { hasNextPage: true, endCursor: after ?? "same" } };
    });
    expect(nodes).toHaveLength(2);
    expect(calls).toBe(2);
  });

  it("caps the loop at the safety page limit", async () => {
    let calls = 0;
    const nodes = await collectAllSourcePages(async after => {
      calls += 1;
      return {
        nodes: [source(`page-${calls}-${after ?? "first"}`)],
        pageInfo: { hasNextPage: true, endCursor: `cursor-${calls}` },
      };
    });
    expect(calls).toBe(SOURCES_PAGE_LIMIT);
    expect(nodes).toHaveLength(SOURCES_PAGE_LIMIT);
  });
});
