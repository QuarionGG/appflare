import { reset } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { beforeEach, describe, expect, it } from "vitest";
import { ZodError } from "zod";
import { createDb } from "../../db/client";
import { createMigrator } from "../../db/migrate";
import { migrations } from "../../db/migrations/index";
import {
  createAlertRule,
  deleteAlertRule,
  listAlertRules,
  pruneAlertFirings,
  readAlertRule,
  recordAlertFiring,
  updateAlertRule,
} from "./alert-rules.server";
import { DAY_SECONDS } from "./limits";

const db = () => createDb(env.DB);
const NOW = new Date("2026-10-12T10:00:00Z");
// 2026-10-01 and 2026-09-01, 00:00 UTC
const OCTOBER = 1_790_812_800;
const SEPTEMBER = 1_788_220_800;

beforeEach(async () => {
  await reset();
  await createMigrator(migrations).ensure(env.DB);
});

describe("usage alert rules", () => {
  it("creates, lists, edits and removes an install's rules", async () => {
    const first = await createAlertRule(
      db(),
      "a",
      { kind: "spent", unit: "usd", amount: 6, period: "month" },
      { userId: "u1", now: NOW },
    );
    expect(first).toMatchObject({
      installId: "a",
      kind: "spent",
      unit: "usd",
      amount: 6,
      period: "month",
      createdAt: NOW.getTime(),
      createdBy: "u1",
      lastFiring: null,
    });
    const second = await createAlertRule(
      db(),
      "a",
      { kind: "pace", unit: "pct", amount: 50, period: "day" },
      { userId: "u1", now: new Date(NOW.getTime() + 1) },
    );
    await createAlertRule(
      db(),
      "b",
      { kind: "pace", unit: "usd", amount: 1, period: "week" },
      { userId: "u1", now: NOW },
    );

    expect((await listAlertRules(db(), "a")).map((r) => r.id)).toEqual([first.id, second.id]);
    expect(await listAlertRules(db())).toHaveLength(3);

    const edited = await updateAlertRule(db(), "a", first.id, { amount: 8, kind: "pace" });
    expect(edited).toMatchObject({ id: first.id, amount: 8, kind: "pace", unit: "usd" });
    expect(await updateAlertRule(db(), "b", first.id, { amount: 9 })).toBeNull();
    expect(await updateAlertRule(db(), "a", first.id, {})).toMatchObject({ amount: 8 });

    expect(await deleteAlertRule(db(), "b", first.id)).toBe(false);
    expect(await deleteAlertRule(db(), "a", first.id)).toBe(true);
    expect(await readAlertRule(db(), first.id)).toBeNull();
    expect((await listAlertRules(db(), "a")).map((r) => r.id)).toEqual([second.id]);
  });

  it("refuses bad rules", async () => {
    await expect(
      createAlertRule(
        db(),
        "a",
        { kind: "spent", unit: "usd", amount: 0, period: "month" },
        { userId: "u1" },
      ),
    ).rejects.toThrow(ZodError);
  });
});

describe("alert firings", () => {
  it("fires a rule once per period and shows its latest firing", async () => {
    const rule = await createAlertRule(
      db(),
      "a",
      { kind: "spent", unit: "usd", amount: 6, period: "month" },
      { userId: "u1" },
    );
    const fire = (periodStart: number, value: number) =>
      recordAlertFiring(db(), { ruleId: rule.id, periodStart, value, firedAt: NOW });

    expect(await fire(SEPTEMBER, 6.5)).toBe(true);
    expect(await fire(OCTOBER, 7)).toBe(true);
    expect(await fire(OCTOBER, 9)).toBe(false);

    expect((await readAlertRule(db(), rule.id))?.lastFiring).toEqual({
      periodStart: OCTOBER,
      firedAt: NOW.getTime(),
      value: 7,
    });
  });

  it("forgets a rule's firings when what it watches changes, so it can fire again", async () => {
    const rule = await createAlertRule(
      db(),
      "a",
      { kind: "spent", unit: "usd", amount: 6, period: "month" },
      { userId: "u1" },
    );
    const fire = () =>
      recordAlertFiring(db(), { ruleId: rule.id, periodStart: OCTOBER, value: 7, firedAt: NOW });
    expect(await fire()).toBe(true);

    // The same values again change nothing: the firing stays.
    expect(
      (await updateAlertRule(db(), "a", rule.id, { amount: 6, period: "month" }))?.lastFiring,
    ).not.toBeNull();
    expect(await fire()).toBe(false);

    const raised = await updateAlertRule(db(), "a", rule.id, { amount: 10 });
    expect(raised).toMatchObject({ amount: 10, lastFiring: null });
    expect(await fire()).toBe(true);

    for (const patch of [
      { kind: "pace" as const },
      { unit: "pct" as const },
      { period: "week" as const },
    ]) {
      const edited = await updateAlertRule(db(), "a", rule.id, patch);
      expect(edited?.lastFiring).toBeNull();
      expect(await fire()).toBe(true);
    }
  });

  it("removes a rule's firings with it, and prunes old ones", async () => {
    const rule = await createAlertRule(
      db(),
      "a",
      { kind: "spent", unit: "usd", amount: 6, period: "day" },
      { userId: "u1" },
    );
    const nowSeconds = Math.floor(NOW.getTime() / 1000);
    await recordAlertFiring(db(), {
      ruleId: rule.id,
      periodStart: nowSeconds - 401 * DAY_SECONDS,
      value: 1,
    });
    await recordAlertFiring(db(), {
      ruleId: rule.id,
      periodStart: nowSeconds - DAY_SECONDS,
      value: 1,
    });
    expect(await pruneAlertFirings(db(), NOW)).toBe(1);

    await deleteAlertRule(db(), "a", rule.id);
    const left = await env.DB.prepare("SELECT COUNT(*) AS n FROM usage_alert_firings").first();
    expect(left).toEqual({ n: 0 });
  });
});
