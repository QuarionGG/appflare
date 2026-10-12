import type { AccountPlan } from "../../account/plan";
import { appTabLink } from "../../components/app-links";
import { PERIOD_NOUN, times, usd } from "../attention-format";
import { LOOP_LEVELS, type LoopLevel, type Period } from "../math";

/**
 * Words and numbers for the spend protection pages. Money and counts come
 * from `attention-format.ts`, so a page and a message read the same; times
 * here are in the browser's own time zone, since a page is read where it is
 * open (the periods themselves are UTC).
 */

export { PERIOD_NOUN, times, usd };

/** The loop levels' names, in order. */
export const LOOP_LEVEL_LABELS: Record<LoopLevel, string> = {
  relaxed: "Relaxed",
  standard: "Standard",
  strict: "Strict",
};

/**
 * What a loop level trips on, as a sentence: "Over $1.00 an hour and 50× its
 * normal, for 10 minutes." On Free the money half is a share of a free daily
 * limit by the end of the day.
 */
export function loopRuleSentence(plan: AccountPlan, level: LoopLevel): string {
  const l = LOOP_LEVELS[level];
  return plan === "free"
    ? `${l.factor}× its normal and on pace to use ${Math.round(l.freeShare * 100)}% of a free daily limit within the day, for 10 minutes.`
    : `Over ${usd(l.usdPerHour)} an hour and ${l.factor}× its normal, for 10 minutes.`;
}

const CLOCK = new Intl.DateTimeFormat("en", { hour: "numeric", minute: "2-digit" });
const WEEKDAY_CLOCK = new Intl.DateTimeFormat("en", {
  weekday: "short",
  hour: "numeric",
  minute: "2-digit",
});
const DAY = new Intl.DateTimeFormat("en", { month: "short", day: "numeric" });

const DAY_CLOCK = new Intl.DateTimeFormat("en", {
  month: "short",
  day: "numeric",
  hour: "numeric",
  minute: "2-digit",
});

/** A day and a time: "Oct 13, 2:00 AM". */
export function dateTime(epochMs: number): string {
  return DAY_CLOCK.format(epochMs);
}

/** A time of day: "2:05 PM". */
export function clock(epochMs: number): string {
  return CLOCK.format(epochMs);
}

/** When a period's spend starts again from zero: "resets at 2:00 AM", "resets Mon 2:00 AM", "resets Nov 1". */
export function resetsText(period: Period, resetsAt: number): string {
  if (period === "day") return `resets at ${clock(resetsAt)}`;
  if (period === "week") return `resets ${WEEKDAY_CLOCK.format(resetsAt)}`;
  return `resets ${DAY.format(resetsAt)}`;
}

/** Where an app's spend protection settings are: its Usage tab's section. */
export function appSpendHref(installId: string): string {
  return `${appTabLink(installId, "usage")}#spend-protection`;
}
