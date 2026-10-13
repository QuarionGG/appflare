import { describe, expect, it } from "vitest";
import type { CapabilityProbe } from "./capabilities";
import {
  MANAGER_OAUTH_API_SCOPES,
  MANAGER_OAUTH_SCOPE_BY_GROUP,
  MANAGER_OAUTH_SCOPES_BY_PROBE,
  missingManagerScopes,
  missingSpendProtectionScopes,
  SPEND_PROTECTION_OAUTH_SCOPES,
  signInCanProbe,
} from "./oauth-scopes";

describe("OAuth scopes of usage and spend protection", () => {
  it("asks every sign-in for analytics", () => {
    expect(MANAGER_OAUTH_API_SCOPES).toContain("account-analytics.read");
  });

  it("counts for usage only the scope it reads with", () => {
    expect([...SPEND_PROTECTION_OAUTH_SCOPES]).toEqual(["account-analytics.read"]);
  });

  it("names analytics alone as missing from a grant made before it was asked for", () => {
    const older = MANAGER_OAUTH_API_SCOPES.filter((s) => s !== "account-analytics.read");
    expect(missingSpendProtectionScopes(older)).toEqual(["account-analytics.read"]);
    expect(missingManagerScopes(older)).toEqual(["account-analytics.read"]);
    expect(missingSpendProtectionScopes(MANAGER_OAUTH_API_SCOPES)).toEqual([]);
    expect(missingManagerScopes(MANAGER_OAUTH_API_SCOPES)).toEqual([]);
  });
});

/**
 * Every capability probe a manager connected with Cloudflare sign-in runs
 * must be covered by the scopes it asks for: a probe needing one that is
 * never requested would read "Could not check" on every sign-in, however
 * often it reconnects.
 */

// Fails to typecheck when a probe has no scope decision, before any test runs.
const decisions: Record<CapabilityProbe, readonly string[] | null> = MANAGER_OAUTH_SCOPES_BY_PROBE;

/** Probes no OAuth scope covers, decided one by one. */
const NO_SCOPE: readonly CapabilityProbe[] = ["workersPlan"];

describe("OAuth scopes of the capability probes", () => {
  it.each(Object.entries(decisions))("%s needs only scopes Appflare requests", (probe, scopes) => {
    if (scopes === null) {
      expect(NO_SCOPE).toContain(probe);
      return;
    }
    for (const scope of scopes) expect(MANAGER_OAUTH_API_SCOPES, probe).toContain(scope);
  });

  it("has no scope for the plan because Billing has none", () => {
    expect(MANAGER_OAUTH_SCOPE_BY_GROUP.billing).toBeNull();
    expect(decisions.workersPlan).toBeNull();
  });

  it("lets a sign-in with every manager scope make every probe but the plan's", () => {
    const can = Object.keys(decisions).filter((probe) =>
      signInCanProbe(probe as CapabilityProbe, MANAGER_OAUTH_API_SCOPES),
    );
    expect(can.sort()).toEqual(
      Object.keys(decisions)
        .filter((p) => !NO_SCOPE.includes(p as CapabilityProbe))
        .sort(),
    );
  });

  it("refuses a probe whose scope was not granted, and allows one that needs none", () => {
    const without = MANAGER_OAUTH_API_SCOPES.filter((s) => s !== "access-acct.read");
    expect(signInCanProbe("zeroTrust", without)).toBe(false);
    expect(signInCanProbe("zeroTrust", MANAGER_OAUTH_API_SCOPES)).toBe(true);
    expect(signInCanProbe("analyticsEngine", [])).toBe(true);
    expect(signInCanProbe("workersPlan", MANAGER_OAUTH_API_SCOPES)).toBe(false);
  });
});
