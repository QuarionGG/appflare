import { MANAGER_OAUTH_SCOPES } from "@appflare/cf-api/oauth";
import { describe, expect, it } from "vitest";
import { scopeReasons } from "./scope-reasons";

describe("why Appflare holds each sign-in permission", () => {
  it("has a reason, under its permission's name, for every scope Appflare asks for", () => {
    const reasons = scopeReasons(MANAGER_OAUTH_SCOPES);
    expect(reasons.map((r) => r.scope)).toEqual([...MANAGER_OAUTH_SCOPES]);
    for (const reason of reasons) {
      expect(reason.label).not.toBe(reason.scope);
      expect(reason.text.startsWith(reason.label)).toBe(true);
    }
    expect(scopeReasons(["workers-scripts.write"])[0]?.label).toBe("Workers Scripts");
    expect(scopeReasons(["offline_access"])[0]?.label).toBe("Offline access");
  });

  it("says what Workers Tail is, for a sign-in an earlier version made with it", () => {
    expect(MANAGER_OAUTH_SCOPES).not.toContain("workers-tail.read");
    const [tail] = scopeReasons(["workers-tail.read"]);
    expect(tail?.label).toBe("Workers Tail");
    expect(tail?.text).toContain("does not use it");
  });

  it("names a scope it has no reason for by its id", () => {
    expect(scopeReasons(["something.read"])).toEqual([
      { scope: "something.read", label: "something.read", text: "something.read" },
    ]);
  });
});
