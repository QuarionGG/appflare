import type { Database } from "../db/client";
import { DAY_MS, HOUR_MS, PRODUCTS, type ProductKey, periodStart, type Usage } from "./math";
import type { HourValue } from "./math/series";
import { readUsage, type UsageRow } from "./store/series.server";

/**
 * The usage history the watcher judges each app by: its hourly usage over
 * the last eight days (the normal hour needs the seven before the last day),
 * and this month's earlier days as daily totals (the bill, caps and alerts
 * add up the month). Reading all of that from D1 every five minutes would
 * read tens of thousands of rows a check, more than the Workers Free plan's
 * daily allowance of rows read lasts. Hours older than three hours no longer
 * change, so that part is kept in KV: read from D1 once, then brought up to
 * date each hour with the one hour that became final. Each check reads only
 * the recent hours from D1 and lays them over it.
 *
 * Each history is kept under its own KV key for the installs it holds
 * ({@link HistorySpec}): every install at once (a check that judges its apps
 * itself), a few installs (one part of a check on Workers Free), or the
 * account's sums (what that check works out for the whole account).
 *
 * The history is as compact as the math allows, since every point costs CPU
 * time in each check (the Workers Free plan allows 10 ms per run): a count
 * keeps its hours only where the normal hour looks (the last eight days, to
 * the hour), and a storage level only for the last 26 hours (the pace looks
 * back 24); before that, each UTC day's hours become one point at the day's
 * start (see {@link compactSeries}). The sums keep only the last 26 hours of
 * counts too.
 */

export const HISTORY_KEY = "usage:watcher-history";
/** Hours the analytics may still change; older hours are final. */
export const RECENT_HOURS = 3;
/** Days of hourly history (the normal hour's week, the last day, and today). */
export const HOURLY_DAYS = 8;
/** Hours kept hourly where only sums count (the pace looks back 24), with a margin. */
export const LEVEL_HOURLY_HOURS = 26;
/** Hours of new rows a cached history is brought up to date with; more is read afresh. */
const UPDATE_HOURS = 24;

const VERSION = 5;

/** Where the history and the recent hours meet, and where hourly history starts (unix seconds). */
export interface HistoryBounds {
  /** Start of the first recent hour: history is everything before it. */
  cutoff: number;
  /** Start of the first hour of hourly history (a day start). */
  hourlyFrom: number;
  /** Start of the month: daily history covers it up to `hourlyFrom`. */
  monthFrom: number;
}

export function historyBounds(now: number): HistoryBounds {
  const hour = Math.floor(now / HOUR_MS) * HOUR_MS;
  const day = Math.floor(now / DAY_MS) * DAY_MS;
  return {
    cutoff: (hour - RECENT_HOURS * HOUR_MS) / 1000,
    hourlyFrom: (day - HOURLY_DAYS * DAY_MS) / 1000,
    monthFrom: periodStart("month", now) / 1000,
  };
}

/** One product of one install: `[installId, product, [t, value, t, value, ...]]`, t in unix seconds. */
export type StoredSeries = [string, ProductKey, number[]];

/**
 * `full`: everything the math needs (the normal hour's eight days to the
 * hour). `sums`: enough for anything that adds up days, weeks or months or
 * looks at the last day (the bill, the overage, the free daily limits), not
 * for the normal hour.
 */
export type HistoryMode = "full" | "sums";

/** Which history: its KV key, how compact, and the installs it holds. */
export interface HistorySpec {
  key: string;
  mode: HistoryMode;
  /** The installs it holds; null for every install, removed ones included. */
  installIds: readonly string[] | null;
}

/** Every install's full history (a check that judges its apps itself). */
export const ALL_HISTORY: HistorySpec = { key: HISTORY_KEY, mode: "full", installIds: null };
/** Every install's sums (the account-wide part of a check on Workers Free). */
export const SUMS_HISTORY: HistorySpec = {
  key: `${HISTORY_KEY}:sums`,
  mode: "sums",
  installIds: null,
};
/** The full history of one part of a check on Workers Free. */
export function partHistory(index: number, installIds: readonly string[]): HistorySpec {
  return { key: `${HISTORY_KEY}:part:${index}`, mode: "full", installIds };
}

export interface UsageHistory {
  bounds: HistoryBounds;
  /** The compacted series, oldest point first. */
  series: StoredSeries[];
  /** From KV as it was, from KV brought up to date, or read from D1 now. */
  source: "cache" | "update" | "database";
}

/** As KV holds it: a JSON header line, then the series as JSON. */
interface StoredHeader {
  v: number;
  bounds: HistoryBounds;
  mode: HistoryMode;
  /** The installs it holds, sorted; null for every install. */
  installIds: string[] | null;
}

function isProduct(key: string): key is ProductKey {
  return Object.hasOwn(PRODUCTS, key);
}

/** The bounds a history's series are compacted at (unix seconds). */
function compactBounds(bounds: HistoryBounds, mode: HistoryMode) {
  const hourNow = bounds.cutoff + RECENT_HOURS * 3_600;
  const levelFrom = hourNow - LEVEL_HOURLY_HOURS * 3_600;
  return {
    countFrom: mode === "full" ? hourNow - HOURLY_DAYS * 86_400 : levelFrom,
    levelFrom,
  };
}

/** The first hour a history of the mode reads hour by hour (a day start); days before, as daily rows. */
function hourlyReadFrom(bounds: HistoryBounds, mode: HistoryMode): number {
  if (mode === "full") return bounds.hourlyFrom;
  const { levelFrom } = compactBounds(bounds, mode);
  return levelFrom - (levelFrom % 86_400);
}

/**
 * A series made compact for the math, its points sorted by hour (unix
 * seconds, `[t, value, ...]`). A count keeps its hours from `countFrom` on;
 * the hours of each day before that are added into one point at the day's
 * start, so any sum over whole days, weeks or months is unchanged (and the
 * normal hour, which looks only from `countFrom` on, sees every hour). A
 * level keeps its hours from `levelFrom` on and its latest point (the level
 * it holds now); before that, each day becomes one point holding the sum of
 * its hourly levels, the unit-hours held, which is what the bill adds up.
 */
export function compactSeries(
  points: readonly number[],
  measure: "count" | "level",
  bounds: { countFrom: number; levelFrom: number },
): number[] {
  const from = measure === "count" ? bounds.countFrom : bounds.levelFrom;
  // A level's latest point stays as it is: it is the level held now.
  const keepLast = measure === "level" ? points.length - 2 : points.length;
  const out: number[] = [];
  let day = -1;
  let sum = 0;
  for (let i = 0; i < points.length; i += 2) {
    const t = points[i] ?? 0;
    const value = points[i + 1] ?? 0;
    if (t >= from || i >= keepLast) {
      if (day >= 0) {
        out.push(day, sum);
        day = -1;
      }
      out.push(t, value);
      continue;
    }
    const start = t - (t % 86_400);
    if (start !== day) {
      if (day >= 0) out.push(day, sum);
      day = start;
      sum = 0;
    }
    sum += value;
  }
  if (day >= 0) out.push(day, sum);
  return out;
}

/** Points to add per series key. */
type Additions = Map<string, { installId: string; product: ProductKey; points: number[] }>;

function addRow(into: Additions, row: UsageRow, daily: boolean): void {
  if (!isProduct(row.product)) return;
  const key = `${row.installId}\u0000${row.product}`;
  let series = into.get(key);
  if (series === undefined) {
    series = { installId: row.installId, product: row.product, points: [] };
    into.set(key, series);
  }
  if (daily && PRODUCTS[row.product].measure === "level") {
    // A day's level held for its 24 hours: its unit-hours, as 23 hours at
    // the day's start and the level itself in its last hour, so a series
    // whose latest point is a day still ends on the level it holds.
    series.points.push(row.t, row.value * 23, row.t + 23 * 3_600, row.value);
  } else {
    series.points.push(row.t, row.value);
  }
}

function compacted(additions: Additions, bounds: HistoryBounds, mode: HistoryMode): StoredSeries[] {
  const at = compactBounds(bounds, mode);
  return [...additions.values()].map((s) => [
    s.installId,
    s.product,
    compactSeries(s.points, PRODUCTS[s.product].measure, at),
  ]);
}

/** Builds a compacted history from D1's rows (oldest first, as `readUsage` gives them). */
export function buildHistorySeries(
  hourly: readonly UsageRow[],
  daily: readonly UsageRow[],
  bounds: HistoryBounds,
  mode: HistoryMode = "full",
): StoredSeries[] {
  const additions: Additions = new Map();
  // Every daily row is before the hourly ones.
  for (const row of daily) addRow(additions, row, true);
  for (const row of hourly) addRow(additions, row, false);
  return compacted(additions, bounds, mode);
}

/**
 * A cached history brought up to date: the hours that became final since
 * (oldest first) added after its series, compacted at the new bounds.
 */
export function updateHistorySeries(
  series: readonly StoredSeries[],
  hours: readonly UsageRow[],
  bounds: HistoryBounds,
  mode: HistoryMode,
): StoredSeries[] {
  const additions: Additions = new Map();
  for (const [installId, product, points] of series) {
    additions.set(`${installId}\u0000${product}`, { installId, product, points: [...points] });
  }
  for (const row of hours) addRow(additions, row, false);
  return compacted(additions, bounds, mode);
}

/** The KV text of a history. */
export function historyText(
  header: Omit<StoredHeader, "v">,
  series: readonly StoredSeries[],
): string {
  return `${JSON.stringify({ v: VERSION, ...header })}\n${JSON.stringify(series)}`;
}

/** A history read back from its KV text; null when it is not one of this version. */
export function readHistoryText(
  text: string,
): { header: StoredHeader; series: () => StoredSeries[] } | null {
  const line = text.indexOf("\n");
  if (line < 0) return null;
  const header = JSON.parse(text.slice(0, line)) as StoredHeader;
  if (header?.v !== VERSION) return null;
  return { header, series: () => JSON.parse(text.slice(line + 1)) as StoredSeries[] };
}

function sameInstalls(a: readonly string[] | null, b: readonly string[] | null): boolean {
  if (a === null || b === null) return a === b;
  return a.length === b.length && a.every((id, i) => id === b[i]);
}

/**
 * A history: from KV when it was kept for this hour; brought up to date
 * from KV when it was kept for an earlier hour of the month (reading only
 * the hours since, one indexed range); else read from D1 (two indexed
 * ranges). Kept in KV when it changed. A history whose installs changed
 * (an install joined or left a part) is read afresh. `fresh` names the
 * installs the check wrote hours of that the history holds already: only
 * theirs are read afresh (`true`: all of it).
 */
export async function loadHistory(
  db: Database,
  kv: KVNamespace | undefined,
  now: number,
  spec: HistorySpec,
  options: { fresh?: boolean | ReadonlySet<string> } = {},
): Promise<UsageHistory> {
  const bounds = historyBounds(now);
  const installIds = spec.installIds === null ? null : [...spec.installIds].sort();
  const scope = installIds === null ? {} : { installIds };
  const fresh = options.fresh === undefined || options.fresh === false ? null : options.fresh;
  let cached: ReturnType<typeof readHistoryText> = null;
  if (kv !== undefined && fresh !== true) {
    try {
      const text = await kv.get(spec.key, "text");
      cached = text === null ? null : readHistoryText(text);
    } catch {
      cached = null;
    }
  }
  const usable =
    cached !== null &&
    cached.header.mode === spec.mode &&
    sameInstalls(cached.header.installIds, installIds) &&
    cached.header.bounds.monthFrom === bounds.monthFrom &&
    cached.header.bounds.cutoff <= bounds.cutoff &&
    bounds.cutoff - cached.header.bounds.cutoff <= UPDATE_HOURS * 3_600;
  const reread = fresh === null || fresh === true || fresh.size === 0 ? null : fresh;
  if (
    cached !== null &&
    usable &&
    reread === null &&
    cached.header.bounds.cutoff === bounds.cutoff
  ) {
    return { bounds, series: cached.series(), source: "cache" };
  }
  const hourlyFrom = hourlyReadFrom(bounds, spec.mode);
  /** Every row of `ids` (all the history's installs when null), read from D1. */
  const readAll = async (ids: readonly string[] | null) => {
    const within = ids === null ? scope : { installIds: ids };
    const [hourly, daily] = await Promise.all([
      readUsage(db, { from: hourlyFrom, to: bounds.cutoff, grain: "hour", ...within }),
      bounds.monthFrom < hourlyFrom
        ? readUsage(db, { from: bounds.monthFrom, to: hourlyFrom, grain: "day", ...within })
        : Promise.resolve([]),
    ]);
    return buildHistorySeries(hourly, daily, bounds, spec.mode);
  };
  let series: StoredSeries[];
  let source: UsageHistory["source"];
  if (cached !== null && usable) {
    const keep = (id: string) => reread === null || !reread.has(id);
    const hours =
      cached.header.bounds.cutoff < bounds.cutoff
        ? await readUsage(db, {
            from: cached.header.bounds.cutoff,
            to: bounds.cutoff,
            grain: "hour",
            ...scope,
          })
        : [];
    series = updateHistorySeries(
      cached.series().filter(([id]) => keep(id)),
      hours.filter((row) => keep(row.installId)),
      bounds,
      spec.mode,
    );
    if (reread !== null) {
      const ids = [...reread].filter((id) => installIds === null || installIds.includes(id));
      if (ids.length > 0) series.push(...(await readAll(ids)));
    }
    source = "update";
  } else {
    series = await readAll(null);
    source = "database";
  }
  if (kv !== undefined) {
    try {
      // Kept a day past its hour: the next hours bring it up to date.
      await kv.put(spec.key, historyText({ bounds, mode: spec.mode, installIds }, series), {
        expirationTtl: (UPDATE_HOURS + 1) * 3_600,
      });
    } catch (error) {
      console.warn("spend watcher: usage history not cached", {
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }
  return { bounds, series, source };
}

/**
 * Each install's usage for the math (hours in epoch ms): the history's
 * series, with the recent hours (all at or after its cut-off, oldest first)
 * after it. An hour both hold takes the recent value.
 */
export function usageByInstall(
  history: readonly StoredSeries[],
  recent: readonly UsageRow[],
): Map<string, Usage> {
  const out = new Map<string, Usage>();
  const seriesOf = (installId: string, product: ProductKey): HourValue[] => {
    let usage = out.get(installId);
    if (usage === undefined) {
      usage = {};
      out.set(installId, usage);
    }
    let series = usage[product] as HourValue[] | undefined;
    if (series === undefined) {
      series = [];
      usage[product] = series;
    }
    return series;
  };
  for (const [installId, product, points] of history) {
    if (!isProduct(product)) continue;
    const series = seriesOf(installId, product);
    for (let i = 0; i < points.length; i += 2) {
      series.push({ hour: (points[i] ?? 0) * 1000, value: points[i + 1] ?? 0 });
    }
  }
  for (const row of recent) {
    if (!isProduct(row.product)) continue;
    const series = seriesOf(row.installId, row.product);
    const hour = row.t * 1000;
    const last = series[series.length - 1];
    if (last === undefined || last.hour < hour) series.push({ hour, value: row.value });
    else if (last.hour === hour) last.value = row.value;
    else {
      // Out of order (rare): put it in its place.
      const at = series.findIndex((p) => p.hour >= hour);
      if (series[at]?.hour === hour) series.splice(at, 1, { hour, value: row.value });
      else series.splice(at, 0, { hour, value: row.value });
    }
  }
  return out;
}
