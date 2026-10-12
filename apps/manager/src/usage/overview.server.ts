import { missingSpendProtectionScopes } from "@appflare/cf-api";
import { z } from "zod";
import { type AccountPlan, accountPlanSchema } from "../account/plan";
import { readAccountPlan } from "../account/plan.server";
import { readGrant } from "../cloudflare/grant-store.server";
import { createDb, type Database } from "../db/client";
import { readSettings, SETTING, writeSettings } from "../db/settings";
import { distinctLabels, type NamedInstall } from "../installs/display-name";
import {
  type InstallNameRow,
  installJobAppNameSql,
  namedInstall,
} from "../installs/install-names.server";
import {
  accountOverage,
  DAY_MS,
  dayStart,
  HOUR_MS,
  hourStart,
  LOOP_LEVEL_NAMES,
  loopCheck,
  monthBill,
  nextToPauseForBudget,
  PERIODS,
  PRODUCTS,
  type ProductKey,
  periodEnd,
  periodStart,
  spendInPeriod,
  type Usage,
} from "./math";
import { NORMAL_DAYS } from "./math/projection";
import type { HourValue } from "./math/series";
import type { SpendApp, SpendOverview } from "./overview";
import { readCustomizedAppSpendSettings } from "./store/app-settings.server";
import { readSpendDefaults } from "./store/defaults.server";
import { listOpenPauses } from "./store/pauses.server";
import { readUsage, type UsageRow } from "./store/series.server";
import {
  defaultAppSpendSettings,
  resolveSpendSettings,
  type SpendDefaults,
} from "./store/spend-settings";

/**
 * Where the account's apps stand against spend protection (see
 * `SpendOverview`), in two parts:
 *
 * - The usage numbers, computed from the hourly series (thousands of rows):
 *   {@link computeSpendOverview}. The spend watcher stores them every tick
 *   with {@link writeSpendOverviewSnapshot}, as one settings row.
 * - The settings, read live (a few small rows): defaults, each app's own
 *   choices, open pauses, the plan and the Cloudflare grant.
 *
 * Pages call {@link readSpendOverview}, which reads the stored numbers with
 * the settings in one round and computes them itself only when they are
 * missing or older than {@link SNAPSHOT_MAX_AGE_MS}. Server only.
 */

/** Stored numbers older than this are computed again when a page needs them. */
export const SNAPSHOT_MAX_AGE_MS = 15 * 60_000;

/**
 * Days of hourly rows the numbers need: the normal hour looks at the 7 days
 * before the last day, the pace and the loop check at the last day, and a
 * weekly cap at most 7 days. Older days of the month come from the daily
 * rollups, which hold the same totals in one row a day.
 */
const HOURLY_DAYS = NORMAL_DAYS + 1;

const finite = z.number().refine(Number.isFinite);
const loopAtLevel = z.object({ money: z.boolean(), abnormal: z.boolean(), trips: z.boolean() });
const periodSpend = z.object({ spent: finite, projected: finite, resetsAt: finite });

/** One app's usage numbers in a snapshot. */
const snapshotAppSchema = z.object({
  installId: z.string().min(1),
  burnPerHour: finite,
  ratio: finite.nullable(),
  loop: z.object({ relaxed: loopAtLevel, standard: loopAtLevel, strict: loopAtLevel }),
  spend: z.object({ day: periodSpend, week: periodSpend, month: periodSpend }),
  overageUsd: finite,
});

/** The usage numbers spend protection shows, as `settings.spend_overview` holds them. */
export const spendSnapshotSchema = z.object({
  /** Epoch ms they were computed. */
  computedAt: finite,
  /** The plan they were computed for; a change of plan makes them stale. */
  plan: accountPlanSchema,
  /** This month's bill so far and projected, removed apps included. */
  bill: z.object({ now: finite, projected: finite }),
  /** Every app in the account (not removed) when they were computed. */
  apps: z.array(snapshotAppSchema),
});
export type SpendSnapshot = z.infer<typeof spendSnapshotSchema>;
export type SnapshotApp = z.infer<typeof snapshotAppSchema>;

function isProductKey(key: string): key is ProductKey {
  return Object.hasOwn(PRODUCTS, key);
}

function append(
  byInstall: Map<string, Usage>,
  installId: string,
  key: ProductKey,
  points: HourValue[],
) {
  const usage = byInstall.get(installId) ?? {};
  usage[key] = [...(usage[key] ?? []), ...points];
  byInstall.set(installId, usage);
}

/**
 * Every install's usage this month, removed apps included (their use still
 * counts toward the bill), as hourly series for the math. The last
 * {@link HOURLY_DAYS} days come hour by hour; a day before them comes as
 * its daily total in the day's first hour (a level is held each hour of
 * that day at the day's last level). Two reads.
 */
export async function readAccountUsage(db: Database, now: number): Promise<Map<string, Usage>> {
  const hourlyFrom = dayStart(now) - HOURLY_DAYS * DAY_MS;
  const monthFrom = periodStart("month", now);
  // Hour by hour from `hourlyFrom` (it covers the month when the month began after it).
  const to = hourStart(now) + HOUR_MS;
  const seconds = (ms: number) => Math.floor(ms / 1000);
  const [hourly, daily] = await Promise.all([
    readUsage(db, { from: seconds(hourlyFrom), to: seconds(to), grain: "hour" }),
    monthFrom < hourlyFrom
      ? readUsage(db, { from: seconds(monthFrom), to: seconds(hourlyFrom), grain: "day" })
      : Promise.resolve([] as UsageRow[]),
  ]);
  const byInstall = new Map<string, Usage>();
  for (const row of daily) {
    if (!isProductKey(row.product)) continue;
    const day = row.t * 1000;
    const points =
      PRODUCTS[row.product].measure === "level"
        ? Array.from({ length: 24 }, (_, h) => ({ hour: day + h * HOUR_MS, value: row.value }))
        : [{ hour: day, value: row.value }];
    append(byInstall, row.installId, row.product, points);
  }
  for (const row of hourly) {
    if (!isProductKey(row.product)) continue;
    append(byInstall, row.installId, row.product, [{ hour: row.t * 1000, value: row.value }]);
  }
  return byInstall;
}

interface ListedInstall extends NamedInstall {
  /** Epoch ms. */
  installedAt: number;
}

/** Every install that is not removed, with its names and install time. One query. */
async function readListedInstalls(d1: D1Database): Promise<ListedInstall[]> {
  const { results } = await d1
    .prepare(
      `SELECT i.id, i.app_slug, i.worker_name, i.display_name, i.manifest_json, i.installed_at,
              CASE WHEN i.manifest_json IS NULL THEN ${installJobAppNameSql("i")} END AS app_name
       FROM installs i WHERE i.status <> 'uninstalled'`,
    )
    .all<InstallNameRow & { installed_at: number }>();
  return results.map((row) => ({ ...namedInstall(row), installedAt: row.installed_at }));
}

/**
 * Computes the usage numbers at `now` from the usage series: each app's
 * spend per period and where its pace takes it, its burn and loop check at
 * every level, its projected share of the month's overage, and the month's
 * bill. Reads the hourly rows of the last 8 days and the daily rollups of
 * the month's older days, so it is the expensive part: pages call
 * {@link readSpendOverview} instead.
 *
 * An app's projections and loop check start at its install time (`since` in
 * the math), so the hours before it existed do not count as idle ones. Paused
 * apps are projected as using nothing more (storage aside).
 */
export async function computeSpendOverview(d1: D1Database, now: number): Promise<SpendSnapshot> {
  const db = createDb(d1);
  const [listed, plan, pauses, usage] = await Promise.all([
    readListedInstalls(d1),
    readAccountPlan(db),
    listOpenPauses(db),
    readAccountUsage(db, now),
  ]);
  return spendSnapshot({
    plan,
    now,
    usage,
    installs: listed.map((i) => ({ installId: i.id, installedAt: i.installedAt })),
    paused: new Set(pauses.map((p) => p.installId)),
  });
}

/** The snapshot from the series. Pure. */
export function spendSnapshot(input: {
  plan: AccountPlan;
  now: number;
  /** Every install's usage this month, removed apps included. */
  usage: ReadonlyMap<string, Usage>;
  /** The apps to give numbers for, with their install times (epoch ms). */
  installs: readonly { installId: string; installedAt: number }[];
  paused: ReadonlySet<string>;
}): SpendSnapshot {
  const { plan, now } = input;
  const all = Object.fromEntries(input.usage);
  const soFar = accountOverage(all, plan, now);
  const ahead = accountOverage(all, plan, now, { projected: true, stopped: input.paused });
  const apps = input.installs.map(({ installId, installedAt }): SnapshotApp => {
    const usage = input.usage.get(installId) ?? {};
    const since = installedAt > 0 && installedAt < now ? installedAt : undefined;
    const checks = LOOP_LEVEL_NAMES.map((level) => loopCheck({ plan, level, usage, now, since }));
    const loop = Object.fromEntries(
      LOOP_LEVEL_NAMES.map((level, i) => {
        const c = checks[i];
        return [
          level,
          { money: c?.money ?? false, abnormal: c?.abnormal ?? false, trips: c?.trips ?? false },
        ];
      }),
    ) as SnapshotApp["loop"];
    const spend = Object.fromEntries(
      PERIODS.map((period) => {
        const s = spendInPeriod(usage, period, now, { since });
        return [period, { spent: s.spent, projected: s.projected, resetsAt: s.resetsAt }];
      }),
    ) as SnapshotApp["spend"];
    return {
      installId,
      // Burn and ratio do not depend on the level.
      burnPerHour: checks[0]?.burn ?? 0,
      ratio: checks[0]?.ratio ?? null,
      loop,
      spend,
      overageUsd: ahead.byApp[installId]?.usd ?? 0,
    };
  });
  return {
    computedAt: now,
    plan,
    bill: { now: monthBill(plan, soFar.usd), projected: monthBill(plan, ahead.usd) },
    apps,
  };
}

/**
 * Computes the usage numbers at `now` ({@link computeSpendOverview}) and
 * stores them for pages to read. The spend watcher calls it at the end of
 * every tick; a page calls it when the stored numbers are missing or stale.
 * Returns what it stored.
 */
export async function writeSpendOverviewSnapshot(
  d1: D1Database,
  now: number = Date.now(),
): Promise<SpendSnapshot> {
  const snapshot = await computeSpendOverview(d1, now);
  await writeSettings(
    createDb(d1),
    { [SETTING.spendOverview]: JSON.stringify(snapshot) },
    new Date(now),
  );
  return snapshot;
}

/** The stored snapshot, or null when there is none or it does not read as one. */
function parseSnapshot(raw: string | undefined): SpendSnapshot | null {
  if (raw === undefined) return null;
  try {
    return spendSnapshotSchema.safeParse(JSON.parse(raw)).data ?? null;
  } catch {
    return null;
  }
}

/** A snapshot computed for another plan, too long ago, or (by a skewed clock) later than now is stale. */
function isFresh(snapshot: SpendSnapshot, plan: AccountPlan, now: number): boolean {
  const age = now - snapshot.computedAt;
  return snapshot.plan === plan && age >= -60_000 && age <= SNAPSHOT_MAX_AGE_MS;
}

const QUIET = { money: false, abnormal: false, trips: false };

/** Numbers for an app the snapshot does not have yet (installed since): nothing used. */
function emptyNumbers(installId: string, now: number): SnapshotApp {
  return {
    installId,
    burnPerHour: 0,
    ratio: null,
    loop: { relaxed: QUIET, standard: QUIET, strict: QUIET },
    spend: Object.fromEntries(
      PERIODS.map((p) => [p, { spent: 0, projected: 0, resetsAt: periodEnd(p, now) }]),
    ) as SnapshotApp["spend"],
    overageUsd: 0,
  };
}

/**
 * The account's spend protection settings and where its apps stand, for a
 * page. One round of small reads (the stored usage numbers among them);
 * when those are missing or older than {@link SNAPSHOT_MAX_AGE_MS}, they
 * are computed and stored first, so a page works before the watcher runs.
 */
export async function readSpendOverview(
  d1: D1Database,
  now: number = Date.now(),
): Promise<{ defaults: SpendDefaults; overview: SpendOverview }> {
  const db = createDb(d1);
  const [listed, plan, defaults, customized, pauses, grant, stored] = await Promise.all([
    readListedInstalls(d1),
    readAccountPlan(db),
    readSpendDefaults(db),
    readCustomizedAppSpendSettings(db),
    listOpenPauses(db),
    readGrant(d1),
    readSettings(db, [SETTING.spendOverview]),
  ]);
  let snapshot = parseSnapshot(stored[SETTING.spendOverview]);
  if (snapshot === null || !isFresh(snapshot, plan, now)) {
    snapshot = await writeSpendOverviewSnapshot(d1, now);
  }
  const numbers = new Map(snapshot.apps.map((a) => [a.installId, a]));
  const labels = distinctLabels(listed);
  const own = new Map(customized.map((s) => [s.installId, s]));
  const paused = new Set(pauses.map((p) => p.installId));

  const apps: SpendApp[] = listed.map((install) => {
    const settings = resolveSpendSettings(
      defaults,
      own.get(install.id) ?? defaultAppSpendSettings(install.id),
    );
    const n = numbers.get(install.id) ?? emptyNumbers(install.id, now);
    return {
      ...n,
      installId: install.id,
      label: labels.get(install.id) ?? install.name,
      paused: paused.has(install.id),
      autoPause: settings.autoPause.on,
      followsAccountTriggers: !settings.triggers.custom,
      budgetExempt: settings.budgetExempt,
      capSetAsideUntil: settings.capSetAsideUntil,
    };
  });
  apps.sort((a, b) => a.label.localeCompare(b.label) || a.installId.localeCompare(b.installId));

  const overview: SpendOverview = {
    plan,
    now,
    computedAt: snapshot.computedAt,
    missingScopes: grant === null ? [] : missingSpendProtectionScopes(grant.scopes),
    bill: snapshot.bill,
    budgetPick:
      plan === "paid"
        ? nextToPauseForBudget(
            apps.map((a) => ({
              id: a.installId,
              overageUsd: a.overageUsd,
              exempt: a.budgetExempt,
              paused: a.paused,
            })),
          )
        : null,
    apps,
  };
  return { defaults, overview };
}
