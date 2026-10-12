import { reset } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { beforeEach, describe, expect, it } from "vitest";
import { createDb } from "../../db/client";
import { createMigrator } from "../../db/migrate";
import { migrations } from "../../db/migrations/index";
import { countActivity, recordActivity } from "./activity.server";
import { createAlertRule, listAlertRules, recordAlertFiring } from "./alert-rules.server";
import { readAppSpendSettings, writeAppSpendSettings } from "./app-settings.server";
import { forgetInstallSpend } from "./forget.server";
import { findOpenPause, listPauses, openPause } from "./pauses.server";
import { recordHourlyUsage } from "./series.server";
import { defaultAppSpendSettings } from "./spend-settings";
import { initialUsageState, readUsageState, writeUsageStates } from "./usage-state.server";

const db = () => createDb(env.DB);
const NOW = new Date("2026-10-12T10:00:00Z");
const HOUR = Date.UTC(2026, 9, 12, 9) / 1000;

beforeEach(async () => {
  await reset();
  await createMigrator(migrations).ensure(env.DB);
});

/** Everything spend protection keeps about an install. */
async function seed(installId: string) {
  await writeAppSpendSettings(db(), installId, { autoPause: "on" }, { userId: "u1" });
  const rule = await createAlertRule(
    db(),
    installId,
    { kind: "spent", unit: "usd", amount: 5, period: "day" },
    { userId: "u1" },
  );
  await recordAlertFiring(db(), { ruleId: rule.id, periodStart: HOUR, value: 6 });
  await writeUsageStates(db(), [{ ...initialUsageState(installId), loopChecks: 1 }], NOW);
  await openPause(db(), { installId, pausedBy: "auto", reason: "cap" });
  await recordHourlyUsage(db(), [{ installId, product: "requests", hour: HOUR, value: 3 }], {
    now: NOW,
  });
  await recordActivity(db(), {
    installId,
    kind: "observability_changed",
    facts: { enabled: true },
  });
}

async function rows(table: string, installId: string): Promise<number> {
  const row = await env.DB.prepare(`SELECT COUNT(*) AS n FROM ${table} WHERE install_id = ?1`)
    .bind(installId)
    .first<{ n: number }>();
  return row?.n ?? 0;
}

describe("forgetInstallSpend", () => {
  it("removes the app's spend protection and closes its pause, keeping usage and activity", async () => {
    await seed("a");
    await seed("b");

    await forgetInstallSpend(db(), "a", NOW);

    expect(await readAppSpendSettings(db(), "a")).toEqual(defaultAppSpendSettings("a"));
    expect(await listAlertRules(db(), "a")).toEqual([]);
    expect(await readUsageState(db(), "a")).toEqual(initialUsageState("a"));
    expect(await findOpenPause(db(), "a")).toBeNull();
    const [pause] = await listPauses(db(), "a");
    expect(pause).toMatchObject({ resumedAt: NOW.getTime(), resumedBy: null });
    const firings = await env.DB.prepare("SELECT COUNT(*) AS n FROM usage_alert_firings").first();
    expect(firings).toEqual({ n: 1 });

    expect(await rows("usage_hourly", "a")).toBe(1);
    expect(await rows("usage_daily", "a")).toBe(1);
    expect(await countActivity(db(), { installId: "a" })).toBe(1);

    // The other app keeps everything.
    expect((await readAppSpendSettings(db(), "b")).autoPause).toBe("on");
    expect((await listAlertRules(db(), "b"))[0]?.lastFiring).not.toBeNull();
    expect((await readUsageState(db(), "b")).loopChecks).toBe(1);
    expect(await findOpenPause(db(), "b")).not.toBeNull();

    // Forgetting again is harmless.
    await forgetInstallSpend(db(), "a", NOW);
  });
});
