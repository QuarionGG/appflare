import { z } from "zod";
import { LOOP_LEVELS, SPEND_PERIODS } from "../db/usage-schema";
import { PAID_PLAN_MONTHLY_USD } from "./math";
import { UNUSUAL_FACTORS } from "./store/spend-settings";

/**
 * What an admin may change of the account's spend protection defaults, one
 * part at a time (each switch or field saves its own part). Client-safe, so
 * the page checks an amount the same way before sending it.
 */

/** The largest cap Appflare takes, in dollars: past it a cap protects nothing. */
export const MAX_CAP_USD = 100_000;
/** The largest monthly budget Appflare takes, in dollars. */
export const MAX_BUDGET_USD = 1_000_000;

export const SPEND_AMOUNT_ERRORS = {
  cap: `Enter an amount of dollars, more than $0 and at most $${MAX_CAP_USD.toLocaleString("en")}.`,
  budget: `Enter an amount of dollars, more than the $${PAID_PLAN_MONTHLY_USD} plan and at most $${MAX_BUDGET_USD.toLocaleString("en")}.`,
} as const;

const capAmount = z
  .number()
  .positive(SPEND_AMOUNT_ERRORS.cap)
  .max(MAX_CAP_USD, SPEND_AMOUNT_ERRORS.cap);
/** The budget includes the $5 plan, so one at or under it would be passed every month. */
const budgetAmount = z
  .number()
  .gt(PAID_PLAN_MONTHLY_USD, SPEND_AMOUNT_ERRORS.budget)
  .max(MAX_BUDGET_USD, SPEND_AMOUNT_ERRORS.budget);

export const setSpendDefaultsInput = z
  .strictObject({
    autoPause: z.boolean(),
    loop: z.strictObject({ on: z.boolean(), level: z.enum(LOOP_LEVELS) }),
    cap: z.strictObject({ on: z.boolean(), amount: capAmount, period: z.enum(SPEND_PERIODS) }),
    budget: z.strictObject({ on: z.boolean(), amount: budgetAmount }),
    unusualFactor: z.literal(UNUSUAL_FACTORS),
  })
  .partial()
  .refine((patch) => Object.keys(patch).length > 0, "Nothing to change.");
export type SetSpendDefaultsInput = z.infer<typeof setSpendDefaultsInput>;

/**
 * A dollar amount as typed ("12", "$12.50", "1,000"), or null when it is not
 * one. Whether it is in range is the schema's call.
 */
export function parseDollars(text: string): number | null {
  const cleaned = text.trim().replace(/^\$/, "").replaceAll(",", "").trim();
  if (!/^\d+(\.\d{1,2})?$|^\.\d{1,2}$/.test(cleaned)) return null;
  const value = Number(cleaned);
  return Number.isFinite(value) ? value : null;
}

/** A typed cap amount, or the message saying what is wrong with it. */
export function checkCapAmount(text: string): { amount: number } | { error: string } {
  const value = parseDollars(text);
  const parsed = capAmount.safeParse(value ?? Number.NaN);
  return parsed.success ? { amount: parsed.data } : { error: SPEND_AMOUNT_ERRORS.cap };
}

/** A typed budget, or the message saying what is wrong with it. */
export function checkBudgetAmount(text: string): { amount: number } | { error: string } {
  const value = parseDollars(text);
  const parsed = budgetAmount.safeParse(value ?? Number.NaN);
  return parsed.success ? { amount: parsed.data } : { error: SPEND_AMOUNT_ERRORS.budget };
}

/** An amount as the field shows it: "10", "12.5". */
export function dollarsText(amount: number): string {
  return String(Math.round(amount * 100) / 100);
}
