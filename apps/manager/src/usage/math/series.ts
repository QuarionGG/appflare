import { HOUR_MS } from "./periods";
import type { ProductKey } from "./products";

/**
 * One hour of one product: `hour` is the start of the UTC hour (ms since the
 * epoch), `value` what was used in it (a count) or held during it (a level).
 * The hour containing `now` is still filling up: its value covers the time
 * from the hour's start to `now`. Missing hours count as zero.
 */
export interface HourValue {
  hour: number;
  value: number;
}

export type Series = readonly HourValue[];

/** An app's (or the account's) hourly usage, per product. */
export type Usage = Partial<Record<ProductKey, Series>>;

/** The stretch of time an hour's value covers, given that `now` may cut it short. */
function span(hour: number, now: number): number {
  return Math.min(hour + HOUR_MS, now) - hour;
}

/**
 * How much of a count was used between `from` and `to` (both clamped to
 * `now`). An hour cut by either end contributes in proportion to the overlap,
 * as if use were even across the hour.
 */
export function sumBetween(series: Series, from: number, to: number, now: number): number {
  const end = Math.min(to, now);
  let total = 0;
  for (const { hour, value } of series) {
    const covered = span(hour, now);
    if (covered <= 0) continue;
    const overlap = Math.min(hour + covered, end) - Math.max(hour, from);
    if (overlap > 0) total += (value * overlap) / covered;
  }
  return total;
}

/**
 * Unit-hours of a level held between `from` and `to` (clamped to `now`):
 * each hour's value times the part of it inside the window.
 */
export function heldBetween(series: Series, from: number, to: number, now: number): number {
  const end = Math.min(to, now);
  let total = 0;
  for (const { hour, value } of series) {
    const overlap = Math.min(hour + span(hour, now), end) - Math.max(hour, from);
    if (overlap > 0) total += (value * overlap) / HOUR_MS;
  }
  return total;
}

/** A level's latest value at or before `now`, or 0 when there is none. */
export function latest(series: Series, now: number): number {
  let best: HourValue | undefined;
  for (const point of series) {
    if (point.hour <= now && (best === undefined || point.hour > best.hour)) best = point;
  }
  return best?.value ?? 0;
}

/** Adds series hour by hour (the account's total from its apps, say). */
export function addSeries(all: readonly Series[]): HourValue[] {
  const byHour = new Map<number, number>();
  for (const series of all) {
    for (const { hour, value } of series) byHour.set(hour, (byHour.get(hour) ?? 0) + value);
  }
  return [...byHour].sort(([a], [b]) => a - b).map(([hour, value]) => ({ hour, value }));
}
