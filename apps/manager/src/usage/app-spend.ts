import { z } from "zod";
import { AUTO_PAUSE_CHOICES, LOOP_LEVELS, SPEND_PERIODS } from "../db/usage-schema";
import { MAX_CAP_USD, SPEND_AMOUNT_ERRORS } from "./spend-defaults";
import { UNUSUAL_FACTORS } from "./store/spend-settings";

/**
 * What an admin may change of one app's spend protection on its Usage tab,
 * one part at a time (each control saves its own part). Client-safe.
 *
 * - `unusualFactor`: the unusual-usage alert at 5×, 20× or 100× normal, 0
 *   for off, null to follow the account.
 * - `autoPause`: follow the account's default, or on or off for this app.
 * - `customTriggers`: pause on this app's own triggers instead of the
 *   account's; `loop` and `cap` are those triggers (kept while the app
 *   follows the account, for when it customizes them again).
 * - `budgetExempt`: the monthly budget never pauses this app.
 */

const capAmount = z
  .number()
  .positive(SPEND_AMOUNT_ERRORS.cap)
  .max(MAX_CAP_USD, SPEND_AMOUNT_ERRORS.cap);

export const appSpendPatch = z
  .strictObject({
    unusualFactor: z.literal(UNUSUAL_FACTORS).nullable(),
    autoPause: z.enum(AUTO_PAUSE_CHOICES),
    customTriggers: z.boolean(),
    loop: z.strictObject({ on: z.boolean(), level: z.enum(LOOP_LEVELS) }),
    cap: z.strictObject({
      on: z.boolean(),
      amount: capAmount.nullable(),
      period: z.enum(SPEND_PERIODS),
    }),
    budgetExempt: z.boolean(),
  })
  .partial()
  .refine((patch) => Object.keys(patch).length > 0, "Nothing to change.");
export type AppSpendPatch = z.infer<typeof appSpendPatch>;

/** Workers Free bills nothing for Workers, so a dollar cap would never trip. */
export const FREE_CAP_REFUSAL =
  "Workers Free can't bill you for Workers, so there's no dollar cap. The loop check still pauses an app.";

export const setAppSpendInput = z.strictObject({
  installId: z.string().min(1).max(64),
  patch: appSpendPatch,
});
export type SetAppSpendInput = z.infer<typeof setAppSpendInput>;
