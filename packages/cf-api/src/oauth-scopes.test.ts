import { describe, expect, it } from "vitest";
import type { CapabilityProbe } from "./capabilities";
import {
  MANAGER_OAUTH_API_SCOPES,
  MANAGER_OAUTH_ONLY_GROUPS,
  MANAGER_OAUTH_SCOPE_BY_GROUP,
  MANAGER_OAUTH_SCOPES_BY_PROBE,
  missingManagerScopes,
  missingSpendProtectionScopes,
  SPEND_PROTECTION_OAUTH_SCOPES,
  signInCanProbe,
} from "./oauth-scopes";

describe("OAuth scopes of usage and spend protection", () => {
  const NEW_SCOPES = [
    "account-analytics.read",
    "notifications.write",
    "notifications.read",
    "workers-observability.read",
  ];

  it("asks every sign-in for analytics, Cloudflare's alerts and Workers Logs", () => {
    for (const scope of NEW_SCOPES) expect(MANAGER_OAUTH_API_SCOPES).toContain(scope);
  });

  it("counts for usage only the scope it reads with, which a token can carry too", () => {
    expect([...SPEND_PROTECTION_OAUTH_SCOPES]).toEqual(["account-analytics.read"]);
    const tokenless = MANAGER_OAUTH_ONLY_GROUPS.map((g) => MANAGER_OAUTH_SCOPE_BY_GROUP[g]);
    expect(tokenless.sort()).toEqual(["notifications.read", "notifications.write"]);
    for (const scope of SPEND_PROTECTION_OAUTH_SCOPES) expect(tokenless).not.toContain(scope);
  });

  it("names the ones a grant made before they were asked for lacks", () => {
    const older = MANAGER_OAUTH_API_SCOPES.filter((s) => !NEW_SCOPES.includes(s));
    expect(missingSpendProtectionScopes(older)).toEqual(["account-analytics.read"]);
    // The manager's own check lists all four, so its reconnect prompt names them.
    expect(missingManagerScopes(older)).toEqual(NEW_SCOPES);
    // Without Workers Observability and the notification scopes, which nothing
    // reads with yet, usage still works; Reconnect still asks for them.
    expect(missingSpendProtectionScopes([...older, "account-analytics.read"])).toEqual([]);
    expect(missingManagerScopes([...older, "account-analytics.read"])).toContain(
      "workers-observability.read",
    );
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
