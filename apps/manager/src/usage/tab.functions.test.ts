import { reset } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { writeAccountPlan } from "../account/plan.server";
import { createDb } from "../db/client";
import { createMigrator } from "../db/migrate";
import { migrations } from "../db/migrations/index";
import { probeRoundTrips, type RoundTrips } from "../test/round-trips";
import { INSTALL_ID, seedInstall } from "../test/seed-install";
import { createAlertRuleInput, updateAlertRuleInput } from "./alert-rules";
import {
  ALERT_RULE_MESSAGES,
  addAlertRule,
  changeAlertRule,
  removeAlertRule,
} from "./alert-rules.server";
import { setAppSpendInput } from "./app-spend";
import { changeAppSpendSettings } from "./app-spend.server";
import { HOUR_MS, hourStart } from "./math";
import { listActivity } from "./store/activity.server";
import { listAlertRules, recordAlertFiring } from "./store/alert-rules.server";
import { readAppSpendSettings } from "./store/app-settings.server";
import { recordHourlyUsage } from "./store/series.server";
import { defaultAppSpendSettings } from "./store/spend-settings";
import type { UsageTabData } from "./tab";

/**
 * The server functions behind an app's Usage tab: everyone signed in reads
 * it, only an admin changes its spend protection or its usage alerts, and
 * every change is recorded in the app's activity in the same D1 batch as
 * the change. `createServerFn` is replaced by a chain that returns the
 * handler; the rest runs for real on the local D1. The input schemas are
 * tested on their own, since the chain skips the validator.
 */

const { requireRole, requireSession } = vi.hoisted(() => ({
  requireRole: vi.fn(),
  requireSession: vi.fn(),
}));

vi.mock("@tanstack/react-start", () => {
  const chain = {
    validator: () => chain,
    inputValidator: () => chain,
    handler: (fn: unknown) => fn,
  };
  return { createServerFn: () => chain };
});
vi.mock("../server/auth.server", () => ({ requireRole, requireSession }));

const tabFns = await import("./tab.functions");
const ruleFns = await import("./alert-rules.functions");
type Fn<I> = (args: { data: I }) => Promise<UsageTabData | null>;
const getTab = tabFns.getUsageTab as unknown as Fn<{ installId: string }>;
const setSpend = tabFns.setAppSpend as unknown as Fn<{ installId: string; patch: object }>;
const createRule = ruleFns.createAlertRuleFn as unknown as Fn<{ installId: string; rule: object }>;
const updateRule = ruleFns.updateAlertRuleFn as unknown as Fn<{
  installId: string;
  ruleId: string;
  rule: object;
}>;
const deleteRule = ruleFns.deleteAlertRuleFn as unknown as Fn<{
  installId: string;
  ruleId: string;
}>;

const ADMIN = { user: { id: "u-ada", role: "admin" }, session: { id: "s" } };
const MEMBER = { user: { id: "u-alan", role: "member" }, session: { id: "s" } };
const NOT_ALLOWED = "You do not have permission to do that.";
const db = () => createDb(env.DB);
const SIX = { kind: "spent", unit: "usd", amount: 6, period: "month" } as const;

let probe: RoundTrips | null = null;

beforeEach(async () => {
  await reset();
  await createMigrator(migrations).ensure(env.DB);
  await seedInstall();
  await env.DB.prepare(
    "INSERT INTO user (id, name, email, email_verified, role, created_at, updated_at) VALUES ('u-ada', 'Ada Lovelace', 'ada@example.com', 1, 'admin', 0, 0)",
  ).run();
  requireRole.mockReset();
  requireSession.mockReset();
});

afterEach(() => {
  probe?.restore();
  probe = null;
});

/** The D1 operations of `write`: a batch is one, with its statements counted. */
async function writes(write: () => Promise<unknown>) {
  probe = probeRoundTrips();
  await write();
  const ops = probe.ops.filter(
    (o) => o.kind === "d1-batch" || /^(insert|update|delete)/i.test(o.label),
  );
  probe.restore();
  probe = null;
  return ops;
}

describe("getUsageTab", () => {
  it("lets a member read the app's usage, without the channels alerts go to", async () => {
    requireSession.mockResolvedValue(MEMBER);
    const now = Date.now();
    await recordHourlyUsage(db(), [
      {
        installId: INSTALL_ID,
        product: "workers_requests",
        hour: hourStart(now - HOUR_MS) / 1000,
        value: 1200,
      },
    ]);
    const tab = await getTab({ data: { installId: INSTALL_ID } });
    expect(requireRole).not.toHaveBeenCalled();
    expect(tab?.products.map((p) => p.key)).toEqual(["workers_requests"]);
    expect(tab?.status.kind).toBe("normal");
    expect(tab?.spend.channels).toBeNull();
    expect(tab?.spend.own).toMatchObject({ autoPause: "default", customTriggers: false });
  });

  it("answers null for an app that does not exist, and refuses anyone not signed in", async () => {
    requireSession.mockResolvedValue(ADMIN);
    expect(await getTab({ data: { installId: "nope" } })).toBeNull();
    requireSession.mockRejectedValue(new Error("Sign in first."));
    await expect(getTab({ data: { installId: INSTALL_ID } })).rejects.toThrow("Sign in first.");
  });
});

describe("setAppSpend", () => {
  it("refuses a member and changes nothing", async () => {
    requireRole.mockRejectedValue(new Error(NOT_ALLOWED));
    await expect(
      setSpend({ data: { installId: INSTALL_ID, patch: { autoPause: "on" } } }),
    ).rejects.toThrow(NOT_ALLOWED);
    expect(requireRole).toHaveBeenCalledWith("admin");
    expect(await readAppSpendSettings(db(), INSTALL_ID)).toEqual(
      defaultAppSpendSettings(INSTALL_ID),
    );
    expect(await listActivity(db())).toEqual([]);
  });

  it("saves an admin's change, records which settings changed for the app, and answers with the tab", async () => {
    requireRole.mockResolvedValue(ADMIN);
    await writeAccountPlan(db(), "paid");
    const tab = await setSpend({
      data: {
        installId: INSTALL_ID,
        patch: {
          autoPause: "on",
          customTriggers: true,
          cap: { on: true, amount: 2, period: "day" },
          // As it was: not a change.
          budgetExempt: false,
        },
      },
    });
    expect(tab?.spend.own).toMatchObject({
      autoPause: "on",
      customTriggers: true,
      capOn: true,
      capAmount: 2,
      capPeriod: "day",
    });
    expect(tab?.spend.effective.autoPause.on).toBe(true);
    const [entry, ...rest] = await listActivity(db());
    expect(rest).toEqual([]);
    expect(entry).toMatchObject({
      installId: INSTALL_ID,
      kind: "settings_changed",
      by: "u-ada",
      facts: { changed: ["autoPause", "customTriggers", "cap"] },
    });
    expect(tab?.events[0]).toMatchObject({ kind: "settings_changed", by: "Ada Lovelace" });
  });

  it("writes the change and its record in one batch, and nothing when nothing changes", async () => {
    const ops = await writes(() =>
      changeAppSpendSettings(db(), INSTALL_ID, { unusualFactor: 100 }, { userId: "u-ada" }),
    );
    expect(ops).toEqual([expect.objectContaining({ kind: "d1-batch", statements: 2 })]);
    expect(
      await writes(() =>
        changeAppSpendSettings(db(), INSTALL_ID, { unusualFactor: 100 }, { userId: "u-ada" }),
      ),
    ).toEqual([]);
    expect(await listActivity(db())).toHaveLength(1);
  });

  it("refuses a dollar cap on Workers Free, but takes own triggers without one", async () => {
    requireRole.mockResolvedValue(ADMIN);
    await expect(
      setSpend({
        data: { installId: INSTALL_ID, patch: { cap: { on: true, amount: 2, period: "day" } } },
      }),
    ).rejects.toThrow("Workers Free can't bill you for Workers, so there's no dollar cap.");
    expect(await listActivity(db())).toEqual([]);
    const tab = await setSpend({
      data: {
        installId: INSTALL_ID,
        patch: { customTriggers: true, cap: { on: false, amount: 10, period: "month" } },
      },
    });
    expect(tab?.spend.own).toMatchObject({ customTriggers: true, capOn: false });
  });

  it("refuses an app that does not exist", async () => {
    requireRole.mockResolvedValue(ADMIN);
    await expect(
      setSpend({ data: { installId: "nope", patch: { budgetExempt: true } } }),
    ).rejects.toThrow("There is no such app.");
  });
});

describe("setAppSpendInput", () => {
  const ok = (patch: unknown) => setAppSpendInput.safeParse({ installId: "i1", patch }).success;
  it("takes any one part, null to follow the account's unusual-usage setting", () => {
    expect(ok({ unusualFactor: null })).toBe(true);
    expect(ok({ unusualFactor: 0 })).toBe(true);
    expect(ok({ autoPause: "default" })).toBe(true);
    expect(ok({ loop: { on: true, level: "strict" } })).toBe(true);
    expect(ok({ cap: { on: false, amount: null, period: "week" } })).toBe(true);
  });
  it("refuses nothing to change, unknown settings and values out of range", () => {
    expect(ok({})).toBe(false);
    expect(ok({ unusualFactor: 7 })).toBe(false);
    expect(ok({ autoPause: "maybe" })).toBe(false);
    expect(ok({ capSetAsideUntil: 1 })).toBe(false);
    expect(ok({ cap: { on: true, amount: 0, period: "day" } })).toBe(false);
    expect(ok({ cap: { on: true, amount: 100_001, period: "day" } })).toBe(false);
    expect(
      setAppSpendInput.safeParse({ installId: "", patch: { budgetExempt: true } }).success,
    ).toBe(false);
  });
});

describe("usage alerts", () => {
  it("refuses a member each change", async () => {
    requireRole.mockRejectedValue(new Error(NOT_ALLOWED));
    await expect(createRule({ data: { installId: INSTALL_ID, rule: SIX } })).rejects.toThrow(
      NOT_ALLOWED,
    );
    await expect(
      updateRule({ data: { installId: INSTALL_ID, ruleId: "r", rule: SIX } }),
    ).rejects.toThrow(NOT_ALLOWED);
    await expect(deleteRule({ data: { installId: INSTALL_ID, ruleId: "r" } })).rejects.toThrow(
      NOT_ALLOWED,
    );
    expect(await listAlertRules(db(), INSTALL_ID)).toEqual([]);
  });

  it("adds, changes and removes a rule, each recorded with its sentence", async () => {
    requireRole.mockResolvedValue(ADMIN);
    await writeAccountPlan(db(), "paid");
    const added = await createRule({ data: { installId: INSTALL_ID, rule: SIX } });
    const [rule] = added?.rules ?? [];
    expect(rule).toMatchObject({
      kind: "spent",
      unit: "usd",
      amount: 6,
      period: "month",
      state: "watching",
    });
    const id = rule?.id ?? "";
    await updateRule({
      data: { installId: INSTALL_ID, ruleId: id, rule: { ...SIX, kind: "pace", amount: 20 } },
    });
    const removed = await deleteRule({ data: { installId: INSTALL_ID, ruleId: id } });
    expect(removed?.rules).toEqual([]);
    const entries = await listActivity(db());
    expect(
      entries.map((e) =>
        e.kind === "settings_changed" ? [e.facts.alert, e.facts.sentence, e.facts.changed] : null,
      ),
    ).toEqual([
      ["removed", "When it is on pace to spend $20.00 by the end of the month", ["usageAlerts"]],
      ["changed", "When it is on pace to spend $20.00 by the end of the month", ["usageAlerts"]],
      ["added", "When it has spent $6.00 this month", ["usageAlerts"]],
    ]);
  });

  it("writes each change with its record in one batch; a change of what it watches forgets its firings", async () => {
    await writeAccountPlan(db(), "paid");
    let id = "";
    const add = await writes(async () => {
      id = await addAlertRule(db(), INSTALL_ID, SIX, { userId: "u-ada" });
    });
    expect(add).toEqual([expect.objectContaining({ kind: "d1-batch", statements: 2 })]);
    await recordAlertFiring(db(), { ruleId: id, periodStart: 1_000, value: 7 });
    expect((await listAlertRules(db(), INSTALL_ID))[0]?.lastFiring).not.toBeNull();
    const change = await writes(() =>
      changeAlertRule(db(), INSTALL_ID, id, { ...SIX, amount: 8 }, { userId: "u-ada" }),
    );
    expect(change).toEqual([expect.objectContaining({ kind: "d1-batch", statements: 3 })]);
    expect((await listAlertRules(db(), INSTALL_ID))[0]).toMatchObject({
      amount: 8,
      lastFiring: null,
    });
    // The same rule again is no change.
    expect(
      await writes(() =>
        changeAlertRule(db(), INSTALL_ID, id, { ...SIX, amount: 8 }, { userId: "u-ada" }),
      ),
    ).toEqual([]);
  });

  it("records a change or removal only while the rule exists, so racing ones record nothing twice", async () => {
    await writeAccountPlan(db(), "paid");
    const id = await addAlertRule(db(), INSTALL_ID, SIX, { userId: "u-ada" });
    const results = await Promise.allSettled([
      removeAlertRule(db(), INSTALL_ID, id, { userId: "u-ada" }),
      removeAlertRule(db(), INSTALL_ID, id, { userId: "u-ada" }),
      changeAlertRule(db(), INSTALL_ID, id, { ...SIX, amount: 9 }, { userId: "u-ada" }),
    ]);
    expect(results.some((r) => r.status === "fulfilled")).toBe(true);
    expect(await listAlertRules(db(), INSTALL_ID)).toEqual([]);
    const entries = (await listActivity(db())).map((e) =>
      e.kind === "settings_changed" ? e.facts.alert : e.kind,
    );
    expect(entries.filter((a) => a === "added")).toHaveLength(1);
    expect(entries.filter((a) => a === "removed")).toHaveLength(1);
  });

  it("refuses a rule of another app, and dollars on the Free plan", async () => {
    requireRole.mockResolvedValue(ADMIN);
    await writeAccountPlan(db(), "paid");
    const id = await addAlertRule(db(), INSTALL_ID, SIX, { userId: "u-ada" });
    await expect(
      updateRule({ data: { installId: "other", ruleId: id, rule: SIX } }),
    ).rejects.toThrow("There is no such app.");
    await env.DB.prepare(
      `INSERT INTO installs (id, app_slug, worker_name, instance_name, catalog_version,
         artifact_url, artifact_digest, status, installed_at, updated_at)
       VALUES ('i2', 'cut', 'cut-two', 'cut-two', '1.0.0', 'https://artifacts.test/cut.zip', ?1, 'installed', 1, 1)`,
    )
      .bind("2".repeat(64))
      .run();
    await expect(deleteRule({ data: { installId: "i2", ruleId: id } })).rejects.toThrow(
      ALERT_RULE_MESSAGES.noRule,
    );
    await writeAccountPlan(db(), "free");
    await expect(createRule({ data: { installId: INSTALL_ID, rule: SIX } })).rejects.toThrow(
      "On the Free plan an alert watches a share of a free daily limit, today.",
    );
    const free = await createRule({
      data: {
        installId: INSTALL_ID,
        rule: { kind: "pace", unit: "pct", amount: 50, period: "day" },
      },
    });
    expect(free?.rules).toHaveLength(2);
  });
});

describe("alert rule inputs", () => {
  const ok = (rule: unknown) => createAlertRuleInput.safeParse({ installId: "i1", rule }).success;
  it("takes dollars or a percent within range, for a day, a week or a month", () => {
    expect(ok(SIX)).toBe(true);
    expect(ok({ kind: "pace", unit: "pct", amount: 10_000, period: "week" })).toBe(true);
  });
  it("refuses amounts out of range and unknown fields", () => {
    expect(ok({ ...SIX, amount: 0 })).toBe(false);
    expect(ok({ ...SIX, amount: 100_001 })).toBe(false);
    expect(ok({ ...SIX, unit: "pct", amount: 10_001 })).toBe(false);
    expect(ok({ ...SIX, period: "year" })).toBe(false);
    expect(ok({ ...SIX, extra: 1 })).toBe(false);
    expect(updateAlertRuleInput.safeParse({ installId: "i1", rule: SIX }).success).toBe(false);
  });
});
