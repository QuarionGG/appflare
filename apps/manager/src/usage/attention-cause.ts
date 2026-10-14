import { z } from "zod";
import { ACCOUNT_PLANS, type AccountPlan } from "../account/plan";
import { count, PERIOD_ADJECTIVE, percent, times, usd } from "./attention-format";
import {
  LOOP_CHECKS_TO_PAUSE,
  LOOP_LEVEL_NAMES,
  LOOP_LEVELS,
  type LoopLevel,
  PERIODS,
} from "./math";

/**
 * Why an app was paused, as a pause records it (`app_pauses.detail_json`,
 * with `reason` in its own column) and as the "paused" notification and
 * Home's row say it. Client-safe and server-safe.
 */

/** Minutes between two checks of the spend watcher. */
const CHECK_MINUTES = 5;

export const pauseCauseSchema = z.discriminatedUnion("reason", [
  /** Someone paused it. */
  z.object({ reason: z.literal("manual") }),
  /** The loop trigger: far above normal and real money, on checks in a row. */
  z.object({
    reason: z.literal("loop"),
    level: z.enum(LOOP_LEVEL_NAMES),
    plan: z.enum(ACCOUNT_PLANS),
    /** Dollars an hour at list price when it tripped. */
    burnPerHour: z.number().nonnegative().nullable().optional(),
    /** How many times its normal hour, when it has a normal. */
    times: z.number().positive().nullable().optional(),
    /** One Durable Object's alarms in the last hour, when that tripped it. */
    alarms: z.number().int().positive().nullable().optional(),
  }),
  /** Its spending cap, in dollars per period (activity at list price). */
  z.object({
    reason: z.literal("cap"),
    amount: z.number().positive(),
    period: z.enum(PERIODS),
    /** What it had spent in the period when it was paused. */
    spent: z.number().nonnegative().optional(),
  }),
  /** The account's monthly budget, including the $5 plan. */
  z.object({
    reason: z.literal("budget"),
    budget: z.number().positive(),
    /** The month's projected bill when it was paused. */
    projected: z.number().nonnegative(),
  }),
]);
export type PauseCause = z.infer<typeof pauseCauseSchema>;

/**
 * A stored pause's cause: its `detail_json` read with the row's reason, or
 * null when the detail is missing or does not read as that reason's (a
 * manual pause needs none).
 */
export function parsePauseCause(reason: string, detailJson: string | null): PauseCause | null {
  let detail: unknown = {};
  if (detailJson !== null) {
    try {
      detail = JSON.parse(detailJson);
    } catch {
      return null;
    }
  }
  const parsed = pauseCauseSchema.safeParse(
    typeof detail === "object" && detail !== null ? { ...detail, reason } : { reason },
  );
  return parsed.success ? parsed.data : null;
}

/** The loop check's rule at a level, in words: "over $1.00 an hour and 50× its normal". */
export function loopRuleWords(level: LoopLevel, plan: AccountPlan): string {
  const rule = LOOP_LEVELS[level];
  return plan === "free"
    ? `${rule.factor}× its normal and on pace to use ${percent(rule.freeShare)} of a free daily limit within the day`
    : `over ${usd(rule.usdPerHour)} an hour and ${rule.factor}× its normal`;
}

const LEVEL_NAMES = { relaxed: "Relaxed", standard: "Standard", strict: "Strict" } as const;

/** Why it was paused, in one or two sentences; null for a manual pause. */
export function pauseCauseSentence(cause: PauseCause): string | null {
  switch (cause.reason) {
    case "manual":
      return null;
    case "cap":
      return `It passed its ${usd(cause.amount)} ${PERIOD_ADJECTIVE[cause.period]} cap.`;
    case "budget":
      return `This month's Appflare usage, including the $5 plan, was on pace for about ${usd(cause.projected)}, past the ${usd(cause.budget)} monthly budget, and this app had the largest share of it.`;
    case "loop": {
      if (cause.alarms != null) {
        return `One of its Durable Objects ran its alarm ${count(cause.alarms)} times in an hour, which only a loop does.`;
      }
      const minutes = LOOP_CHECKS_TO_PAUSE * CHECK_MINUTES;
      const reached =
        cause.burnPerHour != null && cause.times != null && cause.plan === "paid"
          ? ` It reached about ${usd(cause.burnPerHour)} an hour, ${times(cause.times)} its normal.`
          : "";
      return `Its usage looked like a loop for ${minutes} minutes: ${loopRuleWords(cause.level, cause.plan)} (loop check: ${LEVEL_NAMES[cause.level]}).${reached}`;
    }
  }
}
