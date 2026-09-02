import { describe, expect, it } from "vitest";
import {
  linkPermissionBody,
  sharingPolicyFromMode,
} from "./googleDrive";

describe("Google Drive sharing policy", () => {
  it("defaults to link editor when no setting is stored (owner request)", () => {
    expect(sharingPolicyFromMode(null, null)).toEqual({ mode: "link_editor" });
    expect(sharingPolicyFromMode(undefined, undefined)).toEqual({
      mode: "link_editor",
    });
    expect(sharingPolicyFromMode("", "")).toEqual({ mode: "link_editor" });
  });

  it("honors explicitly stored modes", () => {
    expect(sharingPolicyFromMode("link_editor", null)).toEqual({
      mode: "link_editor",
    });
    expect(sharingPolicyFromMode("link_reader", null)).toEqual({
      mode: "link_reader",
    });
    expect(sharingPolicyFromMode("private", null)).toEqual({ mode: "private" });
    expect(sharingPolicyFromMode("domain_reader", "example.com")).toEqual({
      mode: "domain_reader",
      domain: "example.com",
    });
  });

  it("falls back to link editor when domain_reader lacks a domain", () => {
    expect(sharingPolicyFromMode("domain_reader", null)).toEqual({
      mode: "link_editor",
    });
    expect(sharingPolicyFromMode("domain_reader", "")).toEqual({
      mode: "link_editor",
    });
  });

  it("maps the link editor policy to an editor permission for anyone", () => {
    expect(linkPermissionBody({ mode: "link_editor" })).toEqual({
      type: "anyone",
      role: "editor",
    });
    expect(linkPermissionBody({ mode: "link_reader" })).toEqual({
      type: "anyone",
      role: "reader",
    });
    expect(
      linkPermissionBody({ mode: "domain_reader", domain: "example.com" })
    ).toEqual({
      type: "domain",
      role: "reader",
      domain: "example.com",
    });
  });
});
