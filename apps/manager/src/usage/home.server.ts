import { createDb } from "../db/client";
import { type AccountUse, CHART_PAST_DAYS, type HomeUsageData, type HomeUsageSeries } from "./home";
import {
  DAY_MS,
  dayStart,
  HOUR_MS,
  normalHour,
  PRODUCT_KEYS,
  PRODUCTS,
  type ProductKey,
  periodStart,
  type Usage,
} from "./math";
import { sumBetween } from "./math/series";
import { readSpendOverview } from "./overview.server";
import type { UsageRow } from "./store/series.server";
import {
  ALL_HISTORY,
  type CachedHistory,
  oldestCachedCutoff,
  partHistory,
  readCachedHistory,
  usageByInstall,
} from "./watcher-history.server";
import { SHARD_APPS } from "./watcher-shard.server";
import { readSpendWatchStatus } from "./watcher-status";

/**
 * Home's usage (see `HomeUsageData`), in one round of reads beside each
 * other, plus a second only on Workers Free when the watcher keeps its
 * history in parts:
 *
 * - the totals and each app's numbers: the stored spend overview
 *   (`readSpendOverview`, one row while it is fresh) and the watcher's status;
 * - the apps' last 6 days hour by hour: the spend watcher's history as it
 *   keeps it in KV (`readCachedHistory`), never read from D1 hour by hour;
 * - one D1 batch by the time indexes: this month's daily rollups (and the
 *   6 days before today, when the month began later), the hours since the
 *   oldest point a kept history may stop at (today's, and the hours the
 *   history does not hold yet), and every install's time.
 *
 * Without a history (a new manager, or KV emptied), the 6 days come from the
 * daily rollups instead, as daily totals. Server only.
 */

/** Storage is a level, never charted; leaving it out keeps the answer small. */
const LEVELS = PRODUCT_KEYS.filter((key) => PRODUCTS[key].measure === "level");

function isCountProduct(key: string): key is ProductKey {
  return Object.hasOwn(PRODUCTS, key) && PRODUCTS[key as ProductKey].measure === "count";
}

/** Where the reads start and stop at `now` (epoch ms). */
function windows(now: number) {
  const today = dayStart(now);
  const windowStart = today - CHART_PAST_DAYS * DAY_MS;
  const monthStart = periodStart("month", now);
  return {
    today,
    windowStart,
    monthStart,
    dailyFrom: Math.min(monthStart, windowStart),
    hourlyFrom: Math.min(today, oldestCachedCutoff(now) * 1000),
  };
}

/**
 * The statements of the D1 batch at `now`, with their parameters. Exported
 * for the test that checks their query plans.
 */
export function homeSeriesStatements(now: number): {
  sql: string;
  params: (string | number)[];
}[] {
  const w = windows(now);
  const s = (ms: number) => Math.floor(ms / 1000);
  const levels = LEVELS.map((_, i) => `?${i + 3}`).join(", ");
  return [
    {
      sql: `SELECT install_id, product, day AS t, value FROM usage_daily
         WHERE day >= ?1 AND day < ?2 AND product NOT IN (${levels})`,
      params: [s(w.dailyFrom), s(w.today), ...LEVELS],
    },
    {
      sql: `SELECT install_id, product, hour AS t, value FROM usage_hourly
         WHERE hour >= ?1 AND hour < ?2 AND product NOT IN (${levels})`,
      params: [s(w.hourlyFrom), s(w.today + DAY_MS), ...LEVELS],
    },
    { sql: "SELECT id, installed_at FROM installs WHERE status <> 'uninstalled'", params: [] },
  ];
}

interface Row {
  install_id: string;
  product: string;
  t: number;
  value: number;
}

interface Batch {
  daily: Row[];
  hourly: Row[];
  installedAt: Map<string, number>;
}

async function readBatch(d1: D1Database, now: number): Promise<Batch> {
  const [daily, hourly, installs] = await d1.batch<Row | { id: string; installed_at: number }>(
    homeSeriesStatements(now).map(({ sql, params }) => d1.prepare(sql).bind(...params)),
  );
  return {
    daily: ((daily?.results ?? []) as Row[]).filter((r) => isCountProduct(r.product)),
    hourly: ((hourly?.results ?? []) as Row[]).filter((r) => isCountProduct(r.product)),
    installedAt: new Map(
      ((installs?.results ?? []) as { id: string; installed_at: number }[]).map((r) => [
        r.id,
        r.installed_at,
      ]),
    ),
  };
}

/** The account's use of each counted product today and this month, every install counted. */
function accountUse(batch: Batch, now: number): Partial<Record<ProductKey, AccountUse>> {
  const w = windows(now);
  const out: Partial<Record<ProductKey, AccountUse>> = {};
  const add = (product: string, today: number, month: number) => {
    if (!isCountProduct(product)) return;
    const use = out[product] ?? { today: 0, month: 0 };
    use.today += today;
    use.month += month;
    out[product] = use;
  };
  for (const r of batch.daily) if (r.t * 1000 >= w.monthStart) add(r.product, 0, r.value);
  for (const r of batch.hourly) if (r.t * 1000 >= w.today) add(r.product, r.value, r.value);
  return out;
}

/**
 * The watcher's hourly history of the listed apps: every install's when it
 * keeps one, else (Workers Free, checked in parts) its parts' when together
 * they hold every listed app. Null when it has none to give.
 */
async function readHistory(
  kv: KVNamespace | undefined,
  now: number,
  listed: readonly string[],
  sharded: boolean,
  all: CachedHistory | null,
): Promise<CachedHistory | null> {
  if (all !== null || !sharded || listed.length === 0) return all;
  // One more part than the apps fill, in case one was installed or removed since.
  const count = Math.ceil(listed.length / SHARD_APPS) + 1;
  const parts = await Promise.all(
    Array.from({ length: count }, (_, i) =>
      readCachedHistory(kv, now, { key: partHistory(i, []).key, mode: "full" }),
    ),
  );
  const found = parts.filter((p): p is CachedHistory => p !== null);
  const held = new Set(found.flatMap((p) => p.installIds ?? []));
  if (found.length === 0 || listed.some((id) => !held.has(id))) return null;
  return {
    cutoff: Math.min(...found.map((p) => p.cutoff)),
    installIds: [...held],
    series: found.flatMap((p) => p.series),
  };
}

/** Each listed app's series from the history and the hours after it, hour by hour. */
function hourlySeries(
  history: CachedHistory,
  batch: Batch,
  listed: ReadonlySet<string>,
  now: number,
): HomeUsageSeries[] {
  const w = windows(now);
  const recent: UsageRow[] = batch.hourly
    .filter((r) => r.t >= history.cutoff && listed.has(r.install_id))
    .map((r) => ({ installId: r.install_id, product: r.product, t: r.t, value: r.value }))
    .sort((a, b) => a.t - b.t);
  const usage = usageByInstall(
    history.series.filter(([id, product]) => listed.has(id) && isCountProduct(product)),
    recent,
  );
  const hourCount = Math.floor((now - w.today) / HOUR_MS) + 1;
  const out: HomeUsageSeries[] = [];
  for (const [installId, products] of usage as Map<string, Usage>) {
    for (const [product, points] of Object.entries(products) as [ProductKey, Usage[ProductKey]][]) {
      if (points === undefined || !isCountProduct(product)) continue;
      const byHour = new Map(points.map((p) => [p.hour, p.value]));
      const normal = normalHour(points, now);
      out.push({
        installId,
        product,
        past: Array.from(
          { length: CHART_PAST_DAYS * 24 },
          (_, i) => byHour.get(w.windowStart + i * HOUR_MS) ?? 0,
        ),
        hours: Array.from({ length: hourCount }, (_, h) => byHour.get(w.today + h * HOUR_MS) ?? 0),
        ratio: normal === null ? null : sumBetween(points, now - HOUR_MS, now, now) / normal,
      });
    }
  }
  return out;
}

/** Each listed app's series from the daily rollups and today's hours, when there is no history. */
function dailySeries(batch: Batch, listed: ReadonlySet<string>, now: number): HomeUsageSeries[] {
  const w = windows(now);
  const hourCount = Math.floor((now - w.today) / HOUR_MS) + 1;
  const byKey = new Map<string, HomeUsageSeries>();
  const entry = (installId: string, product: ProductKey) => {
    const key = `${installId}\n${product}`;
    let found = byKey.get(key);
    if (found === undefined) {
      found = {
        installId,
        product,
        past: new Array<number>(CHART_PAST_DAYS).fill(0),
        hours: new Array<number>(hourCount).fill(0),
        ratio: null,
      };
      byKey.set(key, found);
    }
    return found;
  };
  for (const r of batch.daily) {
    const i = Math.round((r.t * 1000 - w.windowStart) / DAY_MS);
    if (!listed.has(r.install_id) || !isCountProduct(r.product)) continue;
    if (i >= 0 && i < CHART_PAST_DAYS) entry(r.install_id, r.product).past[i] = r.value;
  }
  for (const r of batch.hourly) {
    const h = Math.round((r.t * 1000 - w.today) / HOUR_MS);
    if (!listed.has(r.install_id) || !isCountProduct(r.product)) continue;
    if (h >= 0 && h < hourCount) entry(r.install_id, r.product).hours[h] = r.value;
  }
  return [...byKey.values()];
}

/**
 * Home's usage at `now`. Usage needs other permissions when the watcher
 * found it so, or, before it has checked, when the Cloudflare sign-in lacks
 * them.
 */
export async function readHomeUsage(
  d1: D1Database,
  kv: KVNamespace | undefined,
  now: number = Date.now(),
): Promise<HomeUsageData> {
  const [{ overview }, batch, watch, all] = await Promise.all([
    readSpendOverview(d1, now, kv),
    readBatch(d1, now),
    readSpendWatchStatus(createDb(d1)),
    readCachedHistory(kv, now, ALL_HISTORY),
  ]);
  const ids = overview.apps.map((a) => a.installId);
  const listed = new Set(ids);
  const history = await readHistory(kv, now, ids, overview.plan === "free", all);
  return {
    plan: overview.plan,
    now,
    needsAccess:
      watch?.state === "needs_access"
        ? { via: watch.via }
        : overview.missingScopes.length > 0
          ? { via: "oauth" }
          : null,
    bill: overview.bill,
    apps: overview.apps.map((a) => ({
      installId: a.installId,
      installedAt: batch.installedAt.get(a.installId) ?? 0,
      paused: a.paused,
      burnPerHour: a.burnPerHour,
      ratio: a.ratio,
    })),
    windowStart: windows(now).windowStart,
    grain: history === null ? "day" : "hour",
    series:
      history === null
        ? dailySeries(batch, listed, now)
        : hourlySeries(history, batch, listed, now),
    // Every install, removed ones too: they count toward the account's limits and included amounts.
    account: accountUse(batch, now),
  };
}
