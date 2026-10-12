/**
 * The periods usage alerts, spending caps and the bill are measured over. All
 * are UTC, so there is no daylight-saving shift: a day is always 24 hours.
 * Cloudflare's free daily limits also reset at 00:00 UTC.
 *
 * Times are milliseconds since the epoch, like `Date.now()`.
 */

export const HOUR_MS = 3_600_000;
export const DAY_MS = 24 * HOUR_MS;

/** The hours in the 30-day month Cloudflare uses to turn GB held into GB-months. */
export const HOURS_PER_BILLING_MONTH = 30 * 24;

/** A UTC day, an ISO week (starting Monday 00:00 UTC), or a calendar month. */
export type Period = "day" | "week" | "month";
export const PERIODS: readonly Period[] = ["day", "week", "month"];

/** The start of the hour `t` falls in. */
export function hourStart(t: number): number {
  return Math.floor(t / HOUR_MS) * HOUR_MS;
}

/** The start of the UTC day `t` falls in. */
export function dayStart(t: number): number {
  return Math.floor(t / DAY_MS) * DAY_MS;
}

/** When the period containing `now` began: midnight, Monday midnight, or the 1st. */
export function periodStart(period: Period, now: number): number {
  const day = dayStart(now);
  if (period === "day") return day;
  if (period === "week") {
    // getUTCDay() is 0 on Sunday; an ISO week starts on Monday.
    const sinceMonday = (new Date(day).getUTCDay() + 6) % 7;
    return day - sinceMonday * DAY_MS;
  }
  const d = new Date(now);
  return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), 1);
}

/** When the period containing `now` ends (the next one's start). */
export function periodEnd(period: Period, now: number): number {
  const start = periodStart(period, now);
  if (period === "day") return start + DAY_MS;
  if (period === "week") return start + 7 * DAY_MS;
  const d = new Date(start);
  return Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 1);
}

/** Hours from `now` to the end of its period, fractional. */
export function hoursLeft(period: Period, now: number): number {
  return (periodEnd(period, now) - now) / HOUR_MS;
}

/** Whole days in the period containing `now`: 1, 7, or 28 to 31. */
export function daysIn(period: Period, now: number): number {
  return Math.round((periodEnd(period, now) - periodStart(period, now)) / DAY_MS);
}

/**
 * A stable name for the period containing `now`, like "week:2026-10-12" (the
 * date it began), so something meant to happen once per period can be keyed.
 */
export function periodKey(period: Period, now: number): string {
  return `${period}:${new Date(periodStart(period, now)).toISOString().slice(0, 10)}`;
}
