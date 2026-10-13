// Helpers for the usage-math tests: hourly series ending at `now`.
import { HOUR_MS, hourStart } from "./periods";
import type { HourValue } from "./series";

/** Wednesday 2026-10-14, 12:30 UTC: half-way through an hour. */
export const NOW = Date.parse("2026-10-14T12:30:00Z");

/**
 * One point per hour for the last `hours` hours (the current one included),
 * using `perHour(hoursAgo)` as the hour's full rate; the current hour gets
 * only the part already elapsed, as the collector would have stored it.
 * `hoursAgo` is 0 for the current hour, 1 for the one before, and so on.
 */
export function hourly(
  hours: number,
  perHour: number | ((hoursAgo: number) => number),
  now = NOW,
): HourValue[] {
  const rate = typeof perHour === "number" ? () => perHour : perHour;
  const current = hourStart(now);
  const elapsed = (now - current) / HOUR_MS;
  const points: HourValue[] = [];
  for (let ago = hours - 1; ago >= 0; ago--) {
    const value = rate(ago) * (ago === 0 ? elapsed : 1);
    points.push({ hour: current - ago * HOUR_MS, value });
  }
  return points;
}

/** A single point at an ISO time (hour-aligned). */
export function point(iso: string, value: number): HourValue {
  return { hour: Date.parse(iso), value };
}

/** A level held at `value` for the last `hours` hours (the current one included). */
export function held(hours: number, value: number, now = NOW): HourValue[] {
  return hourly(hours, value, now).map((p) => ({ ...p, value }));
}
