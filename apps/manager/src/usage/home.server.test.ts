import { reset } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { beforeEach, describe, expect, it } from "vitest";
import { createDb } from "../db/client";
import { createMigrator } from "../db/migrate";
import { migrations } from "../db/migrations/index";
import { SETTING, writeSettings } from "../db/settings";
import { homeSeriesStatements, readHomeUsage } from "./home.server";
import { writeSpendOverviewSnapshot } from "./overview.server";
import { openPause } from "./store/pauses.server";
import { type HourlyUsage, recordHourlyUsage } from "./store/series.server";
import { ALL_HISTORY, loadHistory, partHistory } from "./watcher-history.server";
import { writeSpendWatchStatus } from "./watcher-status";

/**
 * Home's usage read from the store: the stored spend overview, the
 * watcher's status, the apps' last 6 days hour by hour from the watcher's
 * history in KV (or as daily totals without one), and the account's use
 * today and this month, by the time indexes.
 */

const NOW = Date.UTC(2026, 9, 12, 15, 30);
const HOUR = 3_600_000;
const db = () => createDb(env.DB);

async function install(id: string, status = "installed", installedAt = 1) {
  await env.DB.prepare(
    `INSERT INTO installs (id, app_slug, worker_name, instance_name, catalog_version, artifact_url,
       artifact_digest, pin_sha, status, current_version_id, config_json, manifest_json,
       installed_at, updated_at)
     VALUES (?1, ?1, ?1, ?1, '1.0.0', 'https://artifacts.test/a.zip', ?2, 'sha', ?3, 'v1', '{}', ?4, ?5, 1)`,
  )
    .bind(id, "0".repeat(64), status, JSON.stringify({ catalog: { name: id } }), installedAt)
    .run();
}

function hour(
  installId: string,
  at: number,
  value: number,
  product = "workers_requests",
): HourlyUsage {
  return { installId, product, hour: at / 1000, value };
}

async function record(rows: HourlyUsage[]) {
  await recordHourlyUsage(db(), rows, { levels: ["r2_storage"], now: new Date(NOW) });
}

/** 1,000 requests every hour of the last 9 days, then a loop over the last two hours. */
function steadyThenLoop(installId: string): HourlyUsage[] {
  const rows: HourlyUsage[] = [];
  for (let t = Date.UTC(2026, 9, 3); t < Date.UTC(2026, 9, 12, 14); t += HOUR) {
    rows.push(hour(installId, t, 1000));
  }
  rows.push(hour(installId, Date.UTC(2026, 9, 12, 14), 200_000));
  rows.push(hour(installId, Date.UTC(2026, 9, 12, 15), 100_000));
  return rows;
}

beforeEach(async () => {
  await reset();
  await createMigrator(migrations).ensure(env.DB);
  await writeSettings(db(), { [SETTING.accountPlan]: "paid" });
  await Promise.all([ALL_HISTORY.key, partHistory(0, []).key].map((key) => env.KV.delete(key)));
});

describe("readHomeUsage", () => {
  it("without the watcher's history, gives the 6 days as daily totals and today hour by hour", async () => {
    await install("a", "installed", NOW - 3 * HOUR);
    await record([
      hour("a", Date.UTC(2026, 9, 1, 3), 100),
      hour("a", Date.UTC(2026, 9, 6, 4), 50),
      hour("a", Date.UTC(2026, 9, 11, 23), 7),
      hour("a", Date.UTC(2026, 9, 12, 0), 10),
      hour("a", Date.UTC(2026, 9, 12, 15), 5),
      hour("a", Date.UTC(2026, 9, 12, 15), 2.5, "r2_storage"),
      hour("a", Date.UTC(2026, 9, 12, 9), 3, "do_requests"),
    ]);
    const usage = await readHomeUsage(env.DB, env.KV, NOW);
    expect(usage.grain).toBe("day");
    expect(usage.windowStart).toBe(Date.UTC(2026, 9, 6));
    expect(usage.apps.map((a) => [a.installId, a.installedAt])).toEqual([["a", NOW - 3 * HOUR]]);
    const requests = usage.series.find((s) => s.product === "workers_requests");
    expect(requests?.past).toEqual([50, 0, 0, 0, 0, 7]);
    expect(requests?.hours).toHaveLength(16);
    expect(requests?.hours[0]).toBe(10);
    expect(requests?.hours[15]).toBe(5);
    expect(requests?.ratio).toBeNull();
    // Storage is not charted.
    expect(usage.series.map((s) => s.product).sort()).toEqual(["do_requests", "workers_requests"]);
    expect(usage.account.workers_requests).toEqual({ today: 15, month: 172 });
    expect(usage.account.do_requests).toEqual({ today: 3, month: 3 });
  });

  it("with the watcher's history, gives the 6 days hour by hour and each product's ratio to its normal", async () => {
    await install("a");
    await record(steadyThenLoop("a"));
    // The watcher keeps the history in KV as of a check an hour ago.
    await loadHistory(db(), env.KV, NOW - HOUR, ALL_HISTORY);
    const usage = await readHomeUsage(env.DB, env.KV, NOW);
    expect(usage.grain).toBe("hour");
    const requests = usage.series.find((s) => s.installId === "a");
    expect(requests?.past).toHaveLength(144);
    expect(requests?.past.every((v) => v === 1000)).toBe(true);
    // The hours the history does not hold come from D1.
    expect(requests?.hours.slice(12)).toEqual([1000, 1000, 200_000, 100_000]);
    // The last 60 minutes: half of 14:00 and all of 15:00 so far, against a normal of 1,000.
    expect(requests?.ratio).toBeCloseTo(200, 0);
  });

  it("on Workers Free, reads the history the watcher keeps in parts, when they hold every app", async () => {
    await writeSettings(db(), { [SETTING.accountPlan]: "free" });
    await install("a");
    await install("b");
    await record([...steadyThenLoop("a"), ...steadyThenLoop("b")]);
    await loadHistory(db(), env.KV, NOW - HOUR, partHistory(0, ["a", "b"]));
    expect((await readHomeUsage(env.DB, env.KV, NOW)).grain).toBe("hour");
    // A part without every app: daily totals instead.
    await env.KV.delete(partHistory(0, []).key);
    await loadHistory(db(), env.KV, NOW - HOUR, partHistory(0, ["a"]));
    expect((await readHomeUsage(env.DB, env.KV, NOW)).grain).toBe("day");
  });

  it("gives every app's numbers from the stored overview, and counts removed apps toward the account", async () => {
    await install("a", "installed", NOW - 10 * 60_000);
    await install("b");
    await install("gone", "uninstalled");
    await record([
      hour("a", Date.UTC(2026, 9, 12, 14), 1000),
      hour("gone", Date.UTC(2026, 9, 12, 14), 9),
    ]);
    await openPause(db(), { installId: "b", pausedBy: "appflare", reason: "loop" });
    await writeSpendOverviewSnapshot(env.DB, NOW);
    const usage = await readHomeUsage(env.DB, env.KV, NOW);
    expect(usage.plan).toBe("paid");
    expect(usage.needsAccess).toBeNull();
    expect(usage.bill.now).toBeCloseTo(5, 2);
    expect(usage.apps.map((a) => [a.installId, a.installedAt, a.paused])).toEqual([
      ["a", NOW - 10 * 60_000, false],
      ["b", 1, true],
    ]);
    // A removed app is not charted, but its use counts toward the account's limits.
    expect(usage.series.map((s) => s.installId)).toEqual(["a"]);
    expect(usage.account.workers_requests?.today).toBe(1009);
  });

  it("on Workers Free, adds the account's totals today as other usage", async () => {
    await writeSettings(db(), { [SETTING.accountPlan]: "free" });
    await install("a");
    await record([
      hour("a", Date.UTC(2026, 9, 12, 14), 1000),
      hour("a", Date.UTC(2026, 9, 12, 14), 900, "d1_rows_written"),
    ]);
    const used = { workers_requests: 1000, d1_rows_written: 90_000, kv_writes: 0 };
    await writeSpendWatchStatus(db(), {
      state: "watching",
      at: NOW - 5 * 60_000,
      account: { at: NOW - 5 * 60_000, used },
    });
    const usage = await readHomeUsage(env.DB, env.KV, NOW);
    // Today's limit counts the outside usage; the month stays Appflare's.
    expect(usage.account.d1_rows_written).toEqual({ today: 90_000, month: 900, other: 89_100 });
    // All of it Appflare's: nothing else to add.
    expect(usage.account.workers_requests).toEqual({ today: 1000, month: 1000 });
    expect(usage.account.kv_writes).toBeUndefined();

    // Yesterday's reading says nothing about today.
    await writeSpendWatchStatus(db(), {
      state: "watching",
      at: NOW,
      account: { at: Date.UTC(2026, 9, 11, 23, 55), used },
    });
    expect((await readHomeUsage(env.DB, env.KV, NOW)).account.d1_rows_written).toEqual({
      today: 900,
      month: 900,
    });
  });

  it("on Workers Paid, leaves any account reading out", async () => {
    await install("a");
    await record([hour("a", Date.UTC(2026, 9, 12, 14), 900, "d1_rows_written")]);
    await writeSpendWatchStatus(db(), {
      state: "watching",
      at: NOW,
      account: { at: NOW, used: { d1_rows_written: 90_000 } },
    });
    expect((await readHomeUsage(env.DB, env.KV, NOW)).account.d1_rows_written).toEqual({
      today: 900,
      month: 900,
    });
  });

  it("needs other permissions when the watcher found it could not read usage", async () => {
    await install("a");
    await writeSpendWatchStatus(db(), {
      state: "needs_access",
      at: NOW,
      via: "token",
      missing: ["Account Analytics"],
    });
    expect((await readHomeUsage(env.DB, env.KV, NOW)).needsAccess).toEqual({ via: "token" });
    await writeSpendWatchStatus(db(), { state: "watching", at: NOW });
    expect((await readHomeUsage(env.DB, env.KV, NOW)).needsAccess).toBeNull();
  });

  it("reads the usage tables by their time indexes, not whole tables", async () => {
    const plans = await env.DB.batch(
      homeSeriesStatements(NOW).map(({ sql, params }) =>
        env.DB.prepare(`EXPLAIN QUERY PLAN ${sql}`).bind(...params),
      ),
    );
    const details = plans.map((p) =>
      (p.results as { detail: string }[]).map((r) => r.detail).join("; "),
    );
    expect(details[0]).toContain("USING INDEX usage_daily_day_idx");
    expect(details[1]).toContain("USING INDEX usage_hourly_hour_idx");
    expect(details.slice(0, 2).join(" ")).not.toMatch(/SCAN usage_/);
  });
});
