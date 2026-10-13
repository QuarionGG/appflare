import { z } from "zod";
import type { AccountPlan } from "../account/plan";
import { ALERT_RULE_KINDS, ALERT_RULE_UNITS, SPEND_PERIODS } from "../db/usage-schema";
import { PERIOD_NOUN, usd } from "./attention-format";
import type { Period } from "./math";
import { MAX_CAP_USD, parseDollars } from "./spend-defaults";

/**
 * An app's usage alerts ("When it has spent $6.00 this month"): what an admin
 * may add or change, and the rule as a sentence, the same on the app's Usage
 * tab, in its activity and in the message the alert sends. Client-safe.
 */

/** The largest percent a rule takes: 100 times what is included. */
export const MAX_ALERT_PERCENT = 10_000;

export const ALERT_AMOUNT_ERRORS = {
  usd: `Enter an amount of dollars from $0.01 to $${MAX_CAP_USD.toLocaleString("en")}.`,
  pct: `Enter a percent, more than 0 and at most ${MAX_ALERT_PERCENT.toLocaleString("en")}.`,
  /** The Free plan bills nothing for Workers: its alerts watch a free daily limit, today. */
  free: "On the Free plan an alert watches a share of a free daily limit, today.",
} as const;

export const alertRuleFields = z.strictObject({
  kind: z.enum(ALERT_RULE_KINDS),
  unit: z.enum(ALERT_RULE_UNITS),
  amount: z.number().positive(),
  period: z.enum(SPEND_PERIODS),
});
export type AlertRuleFields = z.infer<typeof alertRuleFields>;

/** The amount is in range for its unit. */
const inRange = (rule: AlertRuleFields) =>
  rule.unit === "usd" ? rule.amount <= MAX_CAP_USD : rule.amount <= MAX_ALERT_PERCENT;

const checkedRule = alertRuleFields.superRefine((rule, ctx) => {
  if (!inRange(rule)) {
    ctx.addIssue({ code: "custom", path: ["amount"], message: ALERT_AMOUNT_ERRORS[rule.unit] });
  }
});

const installId = z.string().min(1).max(64);
const ruleId = z.string().min(1).max(64);

export const createAlertRuleInput = z.strictObject({ installId, rule: checkedRule });
export type CreateAlertRuleInput = z.infer<typeof createAlertRuleInput>;

export const updateAlertRuleInput = z.strictObject({ installId, ruleId, rule: checkedRule });
export type UpdateAlertRuleInput = z.infer<typeof updateAlertRuleInput>;

export const deleteAlertRuleInput = z.strictObject({ installId, ruleId });
export type DeleteAlertRuleInput = z.infer<typeof deleteAlertRuleInput>;

/** Why a rule does not suit the plan, or null: on Free, a percent of a free daily limit, today. */
export function planRefusal(plan: AccountPlan, rule: AlertRuleFields): string | null {
  return plan === "free" && (rule.unit !== "pct" || rule.period !== "day")
    ? ALERT_AMOUNT_ERRORS.free
    : null;
}

/** A typed amount, or the message saying what is wrong with it. */
export function checkAlertAmount(
  text: string,
  unit: AlertRuleFields["unit"],
): { amount: number } | { error: string } {
  const value = unit === "usd" ? parseDollars(text) : parsePercent(text);
  const ok =
    value !== null &&
    value > 0 &&
    (unit === "usd" ? value <= MAX_CAP_USD : value <= MAX_ALERT_PERCENT);
  return ok ? { amount: value } : { error: ALERT_AMOUNT_ERRORS[unit] };
}

/** A percent as typed ("50", "12.5%"), or null when it is not one. */
function parsePercent(text: string): number | null {
  const cleaned = text.trim().replace(/%$/, "").replaceAll(",", "").trim();
  if (!/^\d+(\.\d{1,2})?$|^\.\d{1,2}$/.test(cleaned)) return null;
  const value = Number(cleaned);
  return Number.isFinite(value) ? value : null;
}

/** The verb of a rule: "has spent", "is on pace to use". */
export function alertVerb(kind: AlertRuleFields["kind"], unit: AlertRuleFields["unit"]): string {
  if (kind === "spent") return unit === "usd" ? "has spent" : "has used";
  return unit === "usd" ? "is on pace to spend" : "is on pace to use";
}

/** "$6.00", or "50% of included usage" (Paid), "50% of a free daily limit" (Free). */
export function alertAmountText(
  plan: AccountPlan,
  rule: Pick<AlertRuleFields, "unit" | "amount">,
): string {
  if (rule.unit === "usd") return usd(rule.amount);
  const percent = `${Math.round(rule.amount * 100) / 100}%`;
  return `${percent} of ${plan === "free" ? "a free daily limit" : "included usage"}`;
}

/** When a rule's period ends, after "on pace to … by": "the end of the day". */
const PERIOD_END: Record<Period, string> = {
  day: "the end of the day",
  week: "the end of the week",
  month: "the end of the month",
};

/** The rule's sentence in three parts, so a page can set the amount apart. */
export function alertSentenceParts(
  plan: AccountPlan,
  rule: AlertRuleFields,
): { before: string; amount: string; after: string } {
  return {
    before: `When it ${alertVerb(rule.kind, rule.unit)}`,
    amount: alertAmountText(plan, rule),
    after: rule.kind === "pace" ? `by ${PERIOD_END[rule.period]}` : PERIOD_NOUN[rule.period],
  };
}

/** "When it has spent $6.00 this month", "When it is on pace to use 50% of a free daily limit by the end of the day". */
export function alertSentence(plan: AccountPlan, rule: AlertRuleFields): string {
  const p = alertSentenceParts(plan, rule);
  return `${p.before} ${p.amount} ${p.after}`;
}
