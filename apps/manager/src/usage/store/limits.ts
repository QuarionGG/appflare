/**
 * D1 limits the usage store writes within, and the time units its tables use.
 *
 * D1 binds at most 100 parameters per statement and accepts statements of
 * up to 100 KB (developers.cloudflare.com/d1/platform/limits). Multi-row
 * writes are cut into statements that stay under the parameter limit, and
 * those into batches of at most `STATEMENTS_PER_BATCH`, so one call never
 * sends an unbounded batch.
 */
export const MAX_BOUND_PARAMETERS = 100;
export const STATEMENTS_PER_BATCH = 50;

export const HOUR_SECONDS = 3_600;
export const DAY_SECONDS = 86_400;

/** Splits `items` into runs of at most `size`. */
export function chunk<T>(items: readonly T[], size: number): T[][] {
  if (!(size >= 1)) throw new RangeError(`chunk size must be at least 1, got ${size}`);
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
}

/** How many rows of `columns` bound values fit in one statement. */
export function rowsPerStatement(columns: number): number {
  return Math.floor(MAX_BOUND_PARAMETERS / columns);
}

/** The unix second the UTC hour containing `unixSeconds` starts. */
export function hourStart(unixSeconds: number): number {
  return Math.floor(unixSeconds / HOUR_SECONDS) * HOUR_SECONDS;
}

/** The unix second the UTC day containing `unixSeconds` starts. */
export function dayStart(unixSeconds: number): number {
  return Math.floor(unixSeconds / DAY_SECONDS) * DAY_SECONDS;
}

/** Epoch milliseconds to unix seconds, rounded down. */
export function toUnixSeconds(epochMs: number): number {
  return Math.floor(epochMs / 1000);
}
