import { dayStart, freeDailyLimit, PRODUCT_KEYS, PRODUCTS, type ProductKey } from "./math";

/**
 * The whole account's use today of what the Workers Free plan limits per
 * day, as Cloudflare counts it: Appflare's apps and everything else in the
 * account (Workers, databases and namespaces Appflare did not install).
 * Cloudflare applies those limits to the account, so when something else
 * uses one up, Appflare's apps fail too.
 *
 * The spend watcher reads it on Workers Free in the same request as its
 * other reads, and keeps only the latest reading, with its status
 * (`settings.spend_watch`): no history, and nothing is attributed, charted,
 * capped or paused for what is not Appflare's. Client-safe.
 */

/** One reading: the account's totals from 00:00 UTC of `at`'s day to `at`. */
export interface AccountDay {
  /** Epoch ms. */
  at: number;
  /** By product key; 0 for a product read and not used. */
  used: Record<string, number>;
}

/**
 * The products a reading holds: those with a Free daily limit past which
 * Cloudflare refuses (R2 bills instead). Left out: Workers Logs events,
 * which Appflare does not read and past whose limit Cloudflare drops logs
 * rather than failing anything; and Workers AI neurons, which the collector
 * already reads for the whole account and shares across the apps that bind
 * AI, so none of it is ever outside Appflare's apps.
 */
const NOT_READ: ReadonlySet<ProductKey> = new Set(["workers_logs_events", "ai_neurons"]);

export const ACCOUNT_DAY_PRODUCTS: readonly ProductKey[] = PRODUCT_KEYS.filter(
  (key) => freeDailyLimit(key) !== null && !PRODUCTS[key].billedOnFree && !NOT_READ.has(key),
);

/** The reading's totals when it was taken on `now`'s UTC day; null otherwise (or without one). */
export function accountToday(
  day: AccountDay | null | undefined,
  now: number,
): Readonly<Record<string, number>> | null {
  return day != null && dayStart(day.at) === dayStart(now) ? day.used : null;
}

/**
 * What a free daily limit sees of a product today: the account's total
 * (never less than Appflare's own, which a reading a few minutes old can
 * be), and how much of it is not from Appflare's apps.
 */
export function withOtherUsage(
  appflare: number,
  total: number | undefined,
): { used: number; other: number } {
  return total === undefined || !(total > appflare)
    ? { used: appflare, other: 0 }
    : { used: total, other: total - appflare };
}

/**
 * A stored reading, checked by hand (the watcher reads it on every check,
 * where Zod's first parse costs milliseconds of a Workers Free run); null
 * for anything that does not read as one. `watcher-checks.test.ts` holds it
 * to the status schema.
 */
export function accountDayIn(value: unknown): AccountDay | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
  const { at, used } = value as { at?: unknown; used?: unknown };
  if (typeof at !== "number" || !Number.isInteger(at)) return null;
  if (typeof used !== "object" || used === null || Array.isArray(used)) return null;
  const out: Record<string, number> = {};
  for (const [key, n] of Object.entries(used)) {
    if (typeof n !== "number" || !Number.isFinite(n) || n < 0) return null;
    out[key] = n;
  }
  return { at, used: out };
}
