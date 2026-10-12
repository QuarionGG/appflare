import { reset } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { beforeEach, describe, expect, it } from "vitest";
import { replaceGrantStatements } from "../cloudflare/grant-store.server";
import { createDb } from "../db/client";
import { createMigrator } from "../db/migrate";
import { migrations } from "../db/migrations/index";
import { readSettings, SETTING, writeSettings } from "../db/settings";
import { loopingNow } from "./overview";
import {
  computeSpendOverview,
  readAccountUsage,
  readSpendOverview,
  SNAPSHOT_MAX_AGE_MS,
  spendSnapshotSchema,
  writeSpendOverviewSnapshot,
} from "./overview.server";
import { writeAppSpendSettings } from "./store/app-settings.server";
import { writeSpendDefaults } from "./store/defaults.server";
import { openPause } from "./store/pauses.server";
import { type HourlyUsage, recordHourlyUsage } from "./store/series.server";

/**
 * The account's spend protection overview, read from what the store holds:
 * usage hours (and the daily rollups of the month's older days) turned into
 * stored numbers, the apps' own settings, open pauses, the plan and the
 * Cloudflare grant.
 */

const NOW = Date.UTC(2026, 9, 12, 15, 30);
const HOUR = 3_600_000;
const db = () => createDb(env.DB);
const M = 1_000_000;

async function install(id: string, name: string, status = "installed", installedAt = 1) {
  await env.DB.prepare(
    `INSERT INTO installs (id, app_slug, worker_name, instance_name, catalog_version, artifact_url,
       artifact_digest, pin_sha, status, current_version_id, config_json, manifest_json,
       installed_at, updated_at)
     VALUES (?1, ?1, ?1, ?1, '1.0.0', 'https://artifacts.test/a.zip', ?2, 'sha', ?3, 'v1', '{}', ?4, ?5, 1)`,
  )
    .bind(id, "0".repeat(64), status, JSON.stringify({ catalog: { name } }), installedAt)
    .run();
}

/** One product's use in the hour starting at `at` (ms). */
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

/** A steady 1,000 requests an hour over the week the normal hour is taken from, then a loop. */
function loopRows(installId: string): HourlyUsage[] {
  const rows: HourlyUsage[] = [];
  for (let t = Date.UTC(2026, 9, 4); t < Date.UTC(2026, 9, 11, 15); t += HOUR) {
    rows.push(hour(installId, t, 1000));
  }
  // 10M requests over the last 60 minutes: $3 an hour at $0.30 a million.
  rows.push(hour(installId, Date.UTC(2026, 9, 12, 14), 10 * M));
  rows.push(hour(installId, Date.UTC(2026, 9, 12, 15), 5 * M));
  return rows;
}

beforeEach(async () => {
  await reset();
  await createMigrator(migrations).ensure(env.DB);
  await writeSettings(db(), { [SETTING.accountPlan]: "paid" });
});

describe("readAccountUsage", () => {
  it("takes the month's older days from their rollups and the last days hour by hour", async () => {
    await install("a", "Bookmarks");
    await record([
      hour("a", Date.UTC(2026, 9, 2, 10), 20 * M),
      hour("a", Date.UTC(2026, 9, 2, 11), 1 * M),
      hour("a", Date.UTC(2026, 9, 11, 12), 3 * M),
      hour("a", Date.UTC(2026, 9, 2, 10), 4, "r2_storage"),
      // Last month: left out.
      hour("a", Date.UTC(2026, 8, 20, 10), 99 * M),
    ]);
    const usage = (await readAccountUsage(db(), NOW)).get("a") ?? {};
    // Oct 2 is one daily point (its two hours summed); Oct 11 an hour.
    expect(usage.workers_requests).toEqual([
      { hour: Date.UTC(2026, 9, 2), value: 21 * M },
      { hour: Date.UTC(2026, 9, 11, 12), value: 3 * M },
    ]);
    // A level read from a day is held for each of its hours.
    expect(usage.r2_storage).toHaveLength(24);
    expect(usage.r2_storage?.every((p) => p.value === 4)).toBe(true);
  });
});

describe("readSpendOverview", () => {
  it("is the $5 plan and nothing else for a quiet account, with every app listed by label", async () => {
    await install("b", "Journal");
    await install("a", "Bookmarks");
    const { defaults, overview } = await readSpendOverview(env.DB, NOW);
    expect(defaults.autoPause).toBe(false);
    expect(overview.plan).toBe("paid");
    expect(overview.bill).toEqual({ now: 5, projected: 5 });
    expect(overview.budgetPick).toBeNull();
    expect(overview.missingScopes).toEqual([]);
    expect(overview.apps.map((a) => a.label)).toEqual(["Bookmarks", "Journal"]);
    expect(overview.apps[0]).toMatchObject({
      installId: "a",
      paused: false,
      autoPause: false,
      followsAccountTriggers: true,
      budgetExempt: false,
      burnPerHour: 0,
      ratio: null,
      overageUsd: 0,
    });
    expect(overview.apps[0]?.spend.month).toEqual({
      spent: 0,
      projected: 0,
      resetsAt: Date.UTC(2026, 10, 1),
    });
  });

  it("adds usage past included to the bill, removed apps too, and picks the biggest share of it for the budget", async () => {
    await install("a", "Bookmarks");
    await install("b", "Journal");
    await install("gone", "Old app", "uninstalled");
    await record([
      hour("a", Date.UTC(2026, 9, 2, 10), 20 * M),
      hour("b", Date.UTC(2026, 9, 11, 12), 10 * M),
      hour("gone", Date.UTC(2026, 9, 5, 9), 10 * M),
    ]);
    const { overview } = await readSpendOverview(env.DB, NOW);
    // 40M requests, 10M included: 30M at $0.30 a million is $9, plus the plan.
    // Nothing in the last day, so the pace adds nothing.
    expect(overview.bill.now).toBeCloseTo(14, 6);
    expect(overview.bill.projected).toBeCloseTo(14, 6);
    expect(overview.apps.map((a) => a.installId)).toEqual(["a", "b"]);
    const [a, b] = overview.apps;
    expect(a?.overageUsd).toBeCloseTo(4.5, 6);
    expect(b?.overageUsd).toBeCloseTo(2.25, 6);
    expect(a?.spend.month.spent).toBeCloseTo(6, 6);
    expect(overview.budgetPick).toBe("a");
  });

  it("never picks an exempt or paused app for the budget", async () => {
    await install("a", "Bookmarks");
    await install("b", "Journal");
    await install("c", "Files");
    await record([
      hour("a", Date.UTC(2026, 9, 2, 10), 30 * M),
      hour("b", Date.UTC(2026, 9, 3, 10), 20 * M),
      hour("c", Date.UTC(2026, 9, 3, 11), 10 * M),
    ]);
    await writeAppSpendSettings(db(), "a", { budgetExempt: true }, { userId: "u1" });
    await openPause(db(), { installId: "b", pausedBy: "u1", reason: "manual" });
    const { overview } = await readSpendOverview(env.DB, NOW);
    const byId = new Map(overview.apps.map((app) => [app.installId, app]));
    expect(byId.get("a")?.budgetExempt).toBe(true);
    expect(byId.get("b")?.paused).toBe(true);
    // Exempt and paused apps still count toward the bill.
    expect(overview.bill.now).toBeCloseTo(5 + 50 * M * 0.3e-6, 6);
    expect(overview.budgetPick).toBe("c");
  });

  it("sees an app loop at the levels whose money and factor it passes, and none of them once paused", async () => {
    await install("loop", "Service status");
    await install("calm", "Short links");
    await record([...loopRows("loop"), hour("calm", Date.UTC(2026, 9, 12, 14), 1000)]);
    const first = await readSpendOverview(env.DB, NOW);
    const looping = first.overview.apps.find((a) => a.installId === "loop");
    expect(looping?.burnPerHour).toBeCloseTo(3, 6);
    expect(looping?.ratio).toBeCloseTo(3 / (1000 * 0.3e-6), 0);
    // $3 an hour: under Relaxed's $5, over Standard's $1 and Strict's $0.25.
    expect(looping?.loop.relaxed).toEqual({ money: false, abnormal: true, trips: false });
    expect(looping?.loop.standard.trips).toBe(true);
    expect(looping?.loop.strict.trips).toBe(true);
    expect(loopingNow(first.overview.apps, "standard").map((a) => a.installId)).toEqual(["loop"]);
    expect(loopingNow(first.overview.apps, "relaxed")).toEqual([]);
    // Today: 15M requests, $4.50; the last 3 hours' pace carries on to midnight.
    expect(looping?.spend.day.spent).toBeCloseTo(4.5, 6);
    expect(looping?.spend.day.projected).toBeGreaterThan(4.5);

    await openPause(db(), { installId: "loop", pausedBy: "auto", reason: "loop" });
    const after = await readSpendOverview(env.DB, NOW);
    expect(loopingNow(after.overview.apps, "standard")).toEqual([]);
  });

  it("tells apps on the account's triggers from apps with their own", async () => {
    await install("a", "Bookmarks");
    await install("b", "Journal");
    await writeSpendDefaults(db(), { autoPause: true });
    await writeAppSpendSettings(
      db(),
      "b",
      { customTriggers: true, autoPause: "off" },
      { userId: "u1" },
    );
    const { defaults, overview } = await readSpendOverview(env.DB, NOW);
    expect(defaults.autoPause).toBe(true);
    expect(overview.apps.map((a) => [a.installId, a.followsAccountTriggers, a.autoPause])).toEqual([
      ["a", true, true],
      ["b", false, false],
    ]);
  });

  it("has no bill past R2 and no budget on the Free plan", async () => {
    await writeSettings(db(), { [SETTING.accountPlan]: "free" });
    await install("a", "Bookmarks");
    await record([hour("a", Date.UTC(2026, 9, 12, 10), 90_000)]);
    const { overview } = await readSpendOverview(env.DB, NOW);
    expect(overview.plan).toBe("free");
    expect(overview.bill).toEqual({ now: 0, projected: 0 });
    expect(overview.budgetPick).toBeNull();
    // Today's spend still shows what the activity would cost at list price.
    expect(overview.apps[0]?.spend.day.spent).toBeCloseTo(90_000 * 0.3e-6, 9);
  });

  it("names the usage permissions a Cloudflare sign-in lacks", async () => {
    await env.DB.batch(
      replaceGrantStatements(env.DB, {
        id: "g1",
        clientId: "client",
        scopes: ["workers-scripts.write", "account-analytics.read"],
        refreshToken: "sealed",
        accessToken: "sealed",
        accessExpiresAt: NOW + HOUR,
        keyId: "k1",
        status: "connected",
        problem: null,
        problemAt: null,
        connectedAt: NOW - HOUR,
        refreshedAt: NOW - HOUR,
      }),
    );
    const { overview } = await readSpendOverview(env.DB, NOW);
    expect(overview.missingScopes).toEqual(["workers-observability.read"]);
  });
});

describe("the stored numbers", () => {
  async function stored() {
    const row = await readSettings(db(), [SETTING.spendOverview]);
    return spendSnapshotSchema.parse(JSON.parse(row.spend_overview ?? "null"));
  }

  it("are stored by the first page that finds none, and read as stored while fresh", async () => {
    await install("a", "Bookmarks");
    await record([hour("a", Date.UTC(2026, 9, 2, 10), 20 * M)]);
    const first = await readSpendOverview(env.DB, NOW);
    expect((await stored()).computedAt).toBe(NOW);
    expect(first.overview.computedAt).toBe(NOW);
    // New usage does not show until the numbers are computed again.
    await record([hour("a", Date.UTC(2026, 9, 3, 10), 10 * M)]);
    const later = await readSpendOverview(env.DB, NOW + SNAPSHOT_MAX_AGE_MS);
    expect(later.overview.bill.now).toBeCloseTo(first.overview.bill.now, 6);
    expect(later.overview.computedAt).toBe(NOW);
    // Past 15 minutes they are computed again, and stored.
    const stale = await readSpendOverview(env.DB, NOW + SNAPSHOT_MAX_AGE_MS + 1);
    expect(stale.overview.computedAt).toBe(NOW + SNAPSHOT_MAX_AGE_MS + 1);
    expect(stale.overview.bill.now).toBeCloseTo(first.overview.bill.now + 10 * M * 0.3e-6, 6);
    expect((await stored()).computedAt).toBe(NOW + SNAPSHOT_MAX_AGE_MS + 1);
  });

  it("are computed again when the plan changed since", async () => {
    await install("a", "Bookmarks");
    await writeSpendOverviewSnapshot(env.DB, NOW);
    await writeSettings(db(), { [SETTING.accountPlan]: "free" });
    const { overview } = await readSpendOverview(env.DB, NOW + 60_000);
    expect(overview.plan).toBe("free");
    expect(overview.bill).toEqual({ now: 0, projected: 0 });
    expect((await stored()).plan).toBe("free");
  });

  it("take the settings live: a pause, an exemption and an app installed since", async () => {
    await install("a", "Bookmarks");
    await install("b", "Journal");
    await record([
      hour("a", Date.UTC(2026, 9, 2, 10), 30 * M),
      hour("b", Date.UTC(2026, 9, 3, 10), 20 * M),
    ]);
    await writeSpendOverviewSnapshot(env.DB, NOW);
    expect((await readSpendOverview(env.DB, NOW)).overview.budgetPick).toBe("a");
    await openPause(db(), { installId: "a", pausedBy: "u1", reason: "manual" });
    await install("c", "Files");
    const { overview } = await readSpendOverview(env.DB, NOW + 60_000);
    expect(overview.computedAt).toBe(NOW);
    expect(overview.budgetPick).toBe("b");
    const files = overview.apps.find((app) => app.installId === "c");
    expect(files).toMatchObject({ label: "Files", burnPerHour: 0, overageUsd: 0, paused: false });
    expect(files?.spend.month).toEqual({ spent: 0, projected: 0, resetsAt: Date.UTC(2026, 10, 1) });
  });

  it("project a new app from its install, not from the idle hours before it", async () => {
    // Installed at 13:30, used 1M requests in the 14:00 hour and 0.5M since 15:00.
    await install("new", "Service status", "installed", Date.UTC(2026, 9, 12, 13, 30));
    await record([
      hour("new", Date.UTC(2026, 9, 12, 14), M),
      hour("new", Date.UTC(2026, 9, 12, 15), 0.5 * M),
    ]);
    const snapshot = await computeSpendOverview(env.DB, NOW);
    const day = snapshot.apps.find((a) => a.installId === "new")?.spend.day;
    // 1.5M in 2 hours is 0.75M an hour, not 0.5M (over 3 hours), for the 8.5 hours left.
    expect(day?.spent).toBeCloseTo(1.5 * M * 0.3e-6, 9);
    expect(day?.projected).toBeCloseTo((1.5 * M + 0.75 * M * 8.5) * 0.3e-6, 9);
  });
});
