import { DAY_MS, HOUR_MS, hourStart, hoursLeft, type Period, periodStart } from "./periods";
import { type Series, sumBetween } from "./series";

/** The recent window the pace looks at, in hours. */
export const RECENT_HOURS = 3;
/** Below this share of the day's average, the recent hours count as stopped. */
export const STOPPED_SHARE = 0.1;
/** Days of history the normal hour is taken from, before the last day. */
export const NORMAL_DAYS = 7;

export interface WindowOptions {
  /**
   * When the data starts (an app's install time, say). Hours before it are
   * left out of the pace's averages instead of counting as zero. Without it,
   * every missing hour counts as zero.
   */
  since?: number;
}

/** The average per hour between `from` and `now`, over the part after `since`. */
function averagePerHour(series: Series, from: number, now: number, since?: number): number {
  const start = since === undefined ? from : Math.max(from, since);
  const hours = (now - start) / HOUR_MS;
  if (hours <= 0) return 0;
  return sumBetween(series, start, now, now) / hours;
}

/**
 * Units per hour to project with. Normally the faster of the last 3 hours and
 * the last 24 hours' average, so a quiet stretch does not hide a busy day and
 * a sudden jump counts at once. When the last 3 hours fell below 10% of the day's
 * average, the app stopped (paused, or its traffic ended), so only they count.
 */
export function pace(series: Series, now: number, options: WindowOptions = {}): number {
  const recent = averagePerHour(series, now - RECENT_HOURS * HOUR_MS, now, options.since);
  const day = averagePerHour(series, now - DAY_MS, now, options.since);
  if (recent < day * STOPPED_SHARE) return recent;
  return Math.max(recent, day);
}

export interface Projection {
  /** Used since the period began. */
  used: number;
  /** `used` plus the pace for the rest of the period. */
  projected: number;
  /** Units per hour the projection assumes. */
  pace: number;
}

/** Where a count stands in the period containing `now`, and where it ends at this pace. */
export function project(
  series: Series,
  period: Period,
  now: number,
  options: WindowOptions = {},
): Projection {
  const used = sumBetween(series, periodStart(period, now), now, now);
  const perHour = pace(series, now, options);
  return { used, projected: used + perHour * hoursLeft(period, now), pace: perHour };
}

/** The 95th percentile by nearest rank, or 0 for no values. */
export function percentile95(values: readonly number[]): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.ceil(sorted.length * 0.95) - 1] ?? 0;
}

/** Fewer active hours than this in the window means there is no normal yet. */
export const MIN_ACTIVE_HOURS = 3;

/**
 * Normal hours already worked out, by series object and the hour of `now`
 * (the window moves by the hour, so every check within an hour shares it);
 * a weak map keeps each only as long as its series. A series must not
 * change after it is measured.
 */
const normals = new WeakMap<Series, { hour: number; normal: number | null }>();

/**
 * The app's usual busy hour: the 95th percentile of its active hours (hours
 * with any use) over the 7 days before the last day. The last day is left out
 * so a loop that started yesterday does not become the normal it is measured
 * against. Only active hours count, so an app that runs one batch an hour a
 * day is compared with its batches, not with the idle hours between them.
 * Null when the window has fewer than 3 active hours: no normal yet.
 */
export function normalHour(series: Series, now: number): number | null {
  const current = hourStart(now);
  const known = normals.get(series);
  if (known !== undefined && known.hour === current) return known.normal;
  const normal = computeNormalHour(series, current);
  normals.set(series, { hour: current, normal });
  return normal;
}

function computeNormalHour(series: Series, current: number): number | null {
  const end = current - DAY_MS;
  const start = end - NORMAL_DAYS * DAY_MS;
  const hours = new Map<number, number>();
  for (const { hour, value } of series) {
    if (hour >= start && hour < end) hours.set(hour, (hours.get(hour) ?? 0) + value);
  }
  const active = [...hours.values()].filter((value) => value > 0);
  return active.length < MIN_ACTIVE_HOURS ? null : percentile95(active);
}
