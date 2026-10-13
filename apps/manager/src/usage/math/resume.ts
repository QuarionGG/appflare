import { HOUR_MS, hourStart } from "./periods";
import { PRODUCT_KEYS, PRODUCTS, type ProductKey } from "./products";
import { type HourValue, sumBetween, type Usage } from "./series";

/**
 * A resumed app is judged only on what it does after the resume: what it
 * used before (often the very loop it was paused for) must not pause it
 * again, or alert again. Usage is kept by the hour, so the hour the resume
 * fell in mixes both; `base` is how much of each product that hour held
 * when the resume was first seen, and only what it gained since counts.
 */
export interface ResumeWindow {
  /** When the app was resumed (epoch ms). */
  at: number;
  /** The resume hour's value of each count product when the resume was first seen. */
  base: Partial<Record<ProductKey, number>>;
}

/**
 * A window this short after a resume is stretched to it before its use is
 * taken as a rate an hour, so a few minutes of start-up (or analytics that
 * arrive late) do not read as a runaway.
 */
export const MIN_RESUME_WINDOW_MS = 5 * 60_000;

/**
 * Whether a resume still shapes the last hour's window: until the hour
 * after the resume hour has left it.
 */
export function resumeMatters(resumeAt: number, now: number): boolean {
  return resumeAt <= now && hourStart(resumeAt) + 2 * HOUR_MS > now;
}

/**
 * The resume hour's value of each count product in `usage`: the base a
 * {@link ResumeWindow} keeps.
 */
export function resumeBase(usage: Usage, resumeAt: number): Partial<Record<ProductKey, number>> {
  const hour = hourStart(resumeAt);
  const base: Partial<Record<ProductKey, number>> = {};
  for (const key of PRODUCT_KEYS) {
    if (PRODUCTS[key].measure !== "count") continue;
    const point = usage[key]?.find((p) => p.hour === hour);
    if (point !== undefined) base[key] = point.value;
  }
  return base;
}

/**
 * The app's count usage since the resume: hours before the resume hour are
 * left out, and the resume hour keeps only what it gained over `base`,
 * placed at the resume itself (it was all used after it). Level products
 * (storage) are left as they are: a resume does not change what is stored.
 */
export function usageSinceResume(usage: Usage, resume: ResumeWindow): Usage {
  const hour = hourStart(resume.at);
  const out: Usage = {};
  for (const key of PRODUCT_KEYS) {
    const series = usage[key];
    if (series === undefined) continue;
    if (PRODUCTS[key].measure !== "count") {
      out[key] = series;
      continue;
    }
    const kept: HourValue[] = [];
    for (const point of series) {
      if (point.hour < hour) continue;
      if (point.hour === hour) {
        const gained = point.value - (resume.base[key] ?? 0);
        if (gained > 0) kept.push({ hour: resume.at, value: gained });
        continue;
      }
      kept.push(point);
    }
    out[key] = kept;
  }
  return out;
}

/**
 * Use of a count over the last 60 minutes as a rate an hour. After a
 * resume within the hour, only the time since it counts, stretched to at
 * least {@link MIN_RESUME_WINDOW_MS}.
 */
export function lastHourRate(
  series: readonly HourValue[],
  now: number,
  resumeAt: number | undefined,
): number {
  const from = resumeAt === undefined ? now - HOUR_MS : Math.max(now - HOUR_MS, resumeAt);
  const used = sumBetween(series, from, now, now);
  const window = now - from;
  if (window >= HOUR_MS) return used;
  return (used * HOUR_MS) / Math.max(window, MIN_RESUME_WINDOW_MS);
}
