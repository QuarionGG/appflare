import type { AccountPlan } from "../account/plan";
import { type PauseCause, pauseCauseSentence } from "./attention-cause";
import {
  fullCount,
  PERIOD_ADJECTIVE,
  percent,
  productLabel,
  productRate,
  times,
  usd,
} from "./attention-format";
import type { Period } from "./math";

/**
 * Spend protection's rows in Home's "Needs attention": an app using far more
 * than usual, a free daily limit an app used up, a paused app, and a free
 * daily limit about to run out. Read by `readUsageAttention` from what the
 * spend watcher and the pause jobs record; worded here. Client-safe.
 */

/** The order the rows appear in, most urgent first. */
export const USAGE_ATTENTION_ORDER = ["unusual", "limit-used-up", "paused", "limit-near"] as const;
export type UsageAttentionKind = (typeof USAGE_ATTENTION_ORDER)[number];

/** Resuming as it is would only last until the next check: the app is still past its cap. */
export interface StillPastCap {
  /** Dollars per period. */
  amount: number;
  period: Period;
  /** What it spent in the period, when the pause recorded it. */
  spent: number | null;
  /** When the cap's period ends and the cap applies afresh (epoch ms). */
  resetsAt: number;
}

export type UsageAttention =
  | {
      kind: "unusual";
      installId: string;
      plan: AccountPlan;
      /** When the episode began (epoch ms). */
      since: number;
      /** The product furthest above its normal, when the watcher recorded it. */
      product: string | null;
      perHour: number | null;
      /** How many times its normal; null without a normal to compare with. */
      times: number | null;
      /** Dollars an hour at list price; null when not known. */
      burnPerHour: number | null;
      spentToday: number | null;
      /** Free: the share of a free daily limit it is on pace to use today. */
      freeShare: number | null;
      /** The labels of the channels the alert goes to (admins only; empty for members). */
      sentTo: string[];
    }
  | {
      kind: "limit-used-up";
      installId: string;
      product: string;
      /** The account's free amount a day. */
      limit: number;
      /** The app's share of the account's use of it today, when recorded. */
      appShare: number | null;
      /** When the app's unusual usage began, when it is in such an episode. */
      loopSince: number | null;
    }
  | {
      kind: "paused";
      installId: string;
      pausedAt: number;
      /** Who paused it, by name; null when Appflare did. */
      pausedBy: string | null;
      /** Why; null when the pause recorded none that reads. */
      cause: PauseCause | null;
      /** When the app's unusual usage began, when it was in such an episode. */
      loopSince: number | null;
      /** Set when Resume must offer to set the cap aside (see `StillPastCap`). */
      stillPastCap: StillPastCap | null;
    }
  | {
      kind: "limit-near";
      installId: string;
      product: string;
      limit: number;
      /** When it runs out at the current pace (epoch ms). */
      runsOutAt: number;
      appShare: number | null;
    };

export interface UsageAttentionCopy {
  /** A badge before the title, for the rows that need action now. */
  badge: { label: string; variant: "error" | "warning" } | null;
  title: string;
  description: string;
}

/** Formats an instant as the reader's clock time ("2:05 PM"). */
export type ClockFormat = (epochMs: number) => string;

/** "A", "A and B", "A, B and C". */
export function listWords(items: readonly string[]): string {
  if (items.length <= 1) return items.join("");
  return `${items.slice(0, -1).join(", ")} and ${items.at(-1)}`;
}

/** What a used-up free daily limit does, by product. */
function limitEffect(product: string): string {
  return product === "workers_requests" ? "every app stops answering" : "apps that need them fail";
}

/** After a pause by Appflare: what to do before resuming, by its cause. */
function afterPause(cause: PauseCause | null): string {
  switch (cause?.reason) {
    case "cap":
      return `Visitors see a "paused" page. Resume it when its cap resets, or change the cap on its Usage tab.`;
    case "budget":
      return `Visitors see a "paused" page. Resume it when the bill allows, or exempt it from the budget on its Usage tab.`;
    default:
      return `Visitors see a "paused" page. Resume when the cause is fixed, for example by undoing the settings change that started it.`;
  }
}

/** The words of one row; `label` is what Home calls the app. */
export function usageAttentionCopy(
  item: UsageAttention,
  label: string,
  clock: ClockFormat,
): UsageAttentionCopy {
  switch (item.kind) {
    case "unusual": {
      const normal =
        item.times !== null ? `${times(item.times)} its normal` : "far above its normal";
      const first =
        item.product !== null && item.perHour !== null
          ? `${productRate(item.product, item.perHour)} since ${clock(item.since)}, ${normal}.`
          : `Since ${clock(item.since)}, its usage is ${normal}.`;
      const cost =
        item.plan === "paid" && item.burnPerHour !== null
          ? ` About ${usd(item.burnPerHour)} an hour at Cloudflare's prices${item.spentToday === null ? "" : `, ${usd(item.spentToday)} so far today`}.`
          : item.plan === "free" && item.freeShare !== null && item.product !== null
            ? ` At this pace it uses ${percent(item.freeShare)} of today's free ${productLabel(item.product)}.`
            : "";
      const sent = item.sentTo.length > 0 ? ` Sent to ${listWords(item.sentTo)}.` : "";
      return {
        badge: { label: "Unusual usage", variant: "error" },
        title: `${label} is using far more than usual`,
        description: `${first}${cost}${sent}`,
      };
    }
    case "limit-used-up": {
      const product = productLabel(item.product);
      const limit = `${fullCount(item.limit)} free ${product}`;
      const how =
        item.loopSince !== null
          ? `${label} went into a loop at ${clock(item.loopSince)} and used this account's ${limit} for today.`
          : `This account used its ${limit} for today${item.appShare === null ? "" : `, ${percent(item.appShare)} of them by ${label}`}.`;
      return {
        badge: { label: "Limit reached", variant: "error" },
        title: `Today's free ${product} are used up`,
        description: `${how} Cloudflare refuses more until 00:00 UTC, so ${limitEffect(item.product)} until then. The Free plan bills nothing; pausing stops it happening again tomorrow.`,
      };
    }
    case "paused": {
      if (item.pausedBy !== null) {
        const after =
          item.loopSince !== null && item.loopSince <= item.pausedAt
            ? ` after unusual usage that began at ${clock(item.loopSince)}`
            : "";
        return {
          badge: { label: "Paused", variant: "warning" },
          title: `${label} is paused`,
          description: `${item.pausedBy} paused it at ${clock(item.pausedAt)}${after}. Visitors see a "paused" page until it is resumed.`,
        };
      }
      const why = item.cause === null ? null : pauseCauseSentence(item.cause);
      return {
        badge: { label: "Paused", variant: "warning" },
        title: `Appflare paused ${label}`,
        description: `${why === null ? "" : `${why} `}Appflare paused it at ${clock(item.pausedAt)}. ${afterPause(item.cause)}`,
      };
    }
    case "limit-near": {
      const product = productLabel(item.product);
      return {
        badge: null,
        title: `Free ${product} run out around ${clock(item.runsOutAt)}`,
        description: `${item.appShare === null ? "" : `${label} is getting ${percent(item.appShare)} of today's ${product}. `}When the account's ${fullCount(item.limit)} free ${product} for the day are used, ${limitEffect(item.product)} until 00:00 UTC.`,
      };
    }
  }
}

/**
 * What the Resume dialog says when the app is still past its cap. `when`
 * formats the reset: a clock time for a daily cap, a day and time otherwise.
 */
export function stillPastCapCopy(
  cap: StillPastCap,
  when: { clock: ClockFormat; dayAndTime: ClockFormat },
): { description: string; body: string } {
  const spent = cap.spent === null ? "" : `${usd(cap.spent)} of `;
  const resets = cap.period === "day" ? when.clock(cap.resetsAt) : when.dayAndTime(cap.resetsAt);
  return {
    description: `It's still past its ${PERIOD_ADJECTIVE[cap.period]} cap: ${spent}${usd(cap.amount)}.`,
    body: `Resumed as it is, auto-pause would pause it again within 5 minutes. Resuming sets the cap aside until it resets at ${resets}; the loop check keeps running.`,
  };
}
