import { ACCOUNT_DAY_PRODUCTS, withOtherUsage } from "./account-day";
import { count, percent, productLabel } from "./attention-format";
import { dayStart, freeDailyLimit, type ProductKey, type Usage } from "./math";
import { sumBetween } from "./math/series";

/**
 * Workers Free: the account-level warning that the whole account is near a
 * free daily limit, whatever is using it. Cloudflare stops a product for
 * the whole account once its daily limit is used, so Appflare's apps fail
 * too even when something else used it up.
 *
 * Once today's account total of a product reaches {@link ACCOUNT_WARN_SHARE}
 * of its limit, Appflare records it (an account-level `limit_near` entry,
 * no install) and sends one message for it that day; when the limit then
 * runs out, a second entry says so, without a message.
 *
 * One rule keeps it from repeating an app's own warning, channel by channel:
 * a channel hears about a product's free limit once a day, from whichever
 * warning comes first among the events it receives. The account's warning
 * skips the channels that already got an app's warning about the product
 * today; an app's warning skips the channels that get the account's once
 * the account was warned. A channel that receives only one of the two
 * events always hears that one.
 *
 * Pure and client-safe; account-limits.server.ts records and sends.
 */

/** The share of a free daily limit the account must reach to be warned. */
export const ACCOUNT_WARN_SHARE = 0.9;

/** A free daily limit the account is near, with who is using it. */
export interface AccountLimitNear {
  product: ProductKey;
  limit: number;
  /** Used today by the whole account. */
  used: number;
  /** `used` over the limit (1 or more once it ran out). */
  share: number;
  /** The share of `used` that is not from Appflare's apps. */
  otherShare: number;
  /** The Appflare app that used most of it today, and its share of `used`. */
  top: { installId: string; share: number } | null;
}

/**
 * The free daily limits the account has used at least
 * {@link ACCOUNT_WARN_SHARE} of today, most used first. `accountToday` is
 * the watcher's reading of the whole account (account-day.ts); `usage`
 * every install's usage (removed ones count too); `listed` the installs an
 * app can be named from.
 */
export function accountLimitsNear(input: {
  now: number;
  accountToday: Readonly<Record<string, number>>;
  usage: ReadonlyMap<string, Usage>;
  listed: ReadonlySet<string>;
}): AccountLimitNear[] {
  const day = dayStart(input.now);
  const out: AccountLimitNear[] = [];
  for (const product of ACCOUNT_DAY_PRODUCTS) {
    const limit = freeDailyLimit(product);
    const total = input.accountToday[product];
    if (limit === null || total === undefined) continue;
    let appflare = 0;
    let top: { installId: string; used: number } | null = null;
    for (const [installId, usage] of input.usage) {
      const series = usage[product];
      if (series === undefined) continue;
      const used = sumBetween(series, day, input.now, input.now);
      appflare += used;
      if (used > 0 && input.listed.has(installId) && (top === null || used > top.used)) {
        top = { installId, used };
      }
    }
    const { used, other } = withOtherUsage(appflare, total);
    if (used < limit * ACCOUNT_WARN_SHARE) continue;
    out.push({
      product,
      limit,
      used,
      share: used / limit,
      otherShare: used > 0 ? other / used : 0,
      top: top === null ? null : { installId: top.installId, share: top.used / used },
    });
  }
  return out.sort((a, b) => b.share - a.share);
}

/** What the account's warnings decide this check. */
export interface AccountLimitDecisions {
  /**
   * New account-level entries: the day's warning (with a message), or that
   * the limit ran out since (without). `appFirst`: an app was warned about
   * the product earlier today, so its message skips the channels that got
   * the app's.
   */
  records: Array<{ near: AccountLimitNear; message: boolean; appFirst: boolean }>;
  /**
   * The products the account was warned about today: an app's warning about
   * one skips the channels that get the account's.
   */
  covered: Set<string>;
}

/**
 * Applies the once-a-day rule (see the module comment). `accountShares` is
 * today's newest account-level share by product (1 or more once used up);
 * `appWarned` the products an app was warned about today.
 */
export function accountLimitDecisions(
  near: readonly AccountLimitNear[],
  today: {
    accountShares: ReadonlyMap<string, number>;
    appWarned: ReadonlySet<string>;
  },
): AccountLimitDecisions {
  const out: AccountLimitDecisions = { records: [], covered: new Set(today.accountShares.keys()) };
  for (const limit of near) {
    const before = today.accountShares.get(limit.product);
    if (before === undefined) {
      out.records.push({
        near: limit,
        message: true,
        appFirst: today.appWarned.has(limit.product),
      });
      out.covered.add(limit.product);
    } else if (before < 1 && limit.share >= 1) {
      out.records.push({ near: limit, message: false, appFirst: false });
    }
  }
  return out;
}

/** The Cloudflare product a limit belongs to, as the account warning names what stops. */
const SERVICE: Readonly<Record<string, string>> = {
  workers_requests: "Workers",
  do_requests: "Durable Objects",
  do_duration: "Durable Objects",
  do_rows_read: "Durable Objects",
  do_rows_written: "Durable Objects",
  d1_rows_read: "D1",
  d1_rows_written: "D1",
  kv_reads: "KV",
  kv_writes: "KV",
  kv_deletes: "KV",
  kv_lists: "KV",
  queues_operations: "Queues",
  workflow_steps: "Workflows",
  analytics_engine_data_points: "Analytics Engine",
  browser_hours: "Browser Rendering",
};

/** What the account warning says, for Home's row and the message. */
export interface AccountLimitWords {
  title: string;
  description: string;
}

/**
 * The account warning in words: "This account has used 90% of today's free
 * D1 rows written (90.3K of 100K), mostly other usage in this account. Cloudflare
 * stops D1 for the whole account when it runs out, until 00:00 UTC." Who
 * used it: "mostly other usage in this account" when that is most of it; else the
 * Appflare app that used the most ("mostly Short links"), or "mostly
 * Appflare's apps" when no one app is most of it.
 */
export function accountLimitWords(
  limit: Pick<AccountLimitNear, "limit" | "used" | "share" | "otherShare"> & {
    /** A product key; one this version does not know is named by its key. */
    product: string;
    /** The top Appflare app's name and share of the account's use; null when none. */
    top: { label: string; share: number } | null;
  },
): AccountLimitWords {
  const label = productLabel(limit.product);
  const service = SERVICE[limit.product] ?? label;
  const who =
    limit.otherShare >= 0.5
      ? "mostly other usage in this account"
      : limit.top !== null && limit.top.share >= 0.5
        ? `mostly ${limit.top.label}`
        : limit.top !== null
          ? `mostly Appflare's apps, ${limit.top.label} the most`
          : "mostly Appflare's apps";
  const amounts = `${count(Math.min(limit.used, limit.limit))} of ${count(limit.limit)}`;
  if (limit.share >= 1) {
    return {
      title: `This account used up today's free ${label}`,
      description: `This account used all of today's free ${label} (${amounts}), ${who}. Cloudflare stops ${service} for the whole account until 00:00 UTC, Appflare's apps included.`,
    };
  }
  return {
    title: `This account is near today's free ${label} limit`,
    description: `This account has used ${percent(limit.share)} of today's free ${label} (${amounts}), ${who}. Cloudflare stops ${service} for the whole account when it runs out, until 00:00 UTC.`,
  };
}
