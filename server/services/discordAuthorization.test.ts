import { describe, expect, it } from "vitest";

function canRequestChapter(input: { userId: string; ownerId: string; memberRoles: string[]; allowedRoles: string[] }) {
  return input.userId === input.ownerId || input.allowedRoles.some(role => input.memberRoles.includes(role));
}

describe("Discord chapter authorization", () => {
  it("allows the owner to test the bot before any team role is configured", () => {
    expect(canRequestChapter({ userId: "owner", ownerId: "owner", memberRoles: [], allowedRoles: [] })).toBe(true);
  });

  it("continues to require an approved role from non-owner members", () => {
    expect(canRequestChapter({ userId: "member", ownerId: "owner", memberRoles: [], allowedRoles: [] })).toBe(false);
    expect(canRequestChapter({ userId: "member", ownerId: "owner", memberRoles: ["translator"], allowedRoles: ["translator"] })).toBe(true);
  });
});
