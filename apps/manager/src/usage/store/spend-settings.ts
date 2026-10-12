import { z } from "zod";
import {
  AUTO_PAUSE_CHOICES,
  type AutoPauseChoice,
  LOOP_LEVELS,
  type LoopLevel,
  SPEND_PERIODS,
  type SpendPeriod,
} from "../../db/usage-schema";

/**
 * Spend protection settings: the account's defaults, an app's own choices,
 * and how the two combine. Pure; the stores are defaults.server.ts and
 * app-settings.server.ts.
 */

const loopSchema = z.object({ on: z.boolean(), level: z.enum(LOOP_LEVELS) });
const capSchema = z.object({
  on: z.boolean(),
  amount: z.number().positive(),
  period: z.enum(SPEND_PERIODS),
});
const budgetSchema = z.object({ on: z.boolean(), amount: z.number().positive() });
/** The unusual-usage alert's choices: at 5×, 20× or 100× normal, or 0 for off. */
export const UNUSUAL_FACTORS = [0, 5, 20, 100] as const;
export type UnusualFactor = (typeof UNUSUAL_FACTORS)[number];
const unusualFactorSchema = z.literal(UNUSUAL_FACTORS);

export const spendDefaultsSchema = z.object({
  /** Apps that follow the account pause on their own. */
  autoPause: z.boolean(),
  /** The loop trigger. */
  loop: loopSchema,
  /** The spending cap trigger, in dollars per period. */
  cap: capSchema,
  /** The monthly budget, in dollars including the $5 plan. */
  budget: budgetSchema,
  unusualFactor: unusualFactorSchema,
});
export type SpendDefaults = z.infer<typeof spendDefaultsSchema>;
export const spendDefaultsPatchSchema = spendDefaultsSchema.partial();
export type SpendDefaultsPatch = z.infer<typeof spendDefaultsPatchSchema>;

/** The account's defaults until an admin changes them. */
export const DEFAULT_SPEND_DEFAULTS: SpendDefaults = {
  autoPause: false,
  loop: { on: true, level: "standard" },
  cap: { on: true, amount: 10, period: "month" },
  budget: { on: false, amount: 50 },
  unusualFactor: 20,
};

/** An app's own spend protection settings (`app_spend_settings`). */
export interface AppSpendSettings {
  installId: string;
  /** Null follows the account; 0 is off. */
  unusualFactor: UnusualFactor | null;
  autoPause: AutoPauseChoice;
  /** Pauses on the triggers below instead of the account's. */
  customTriggers: boolean;
  loopOn: boolean;
  /** Null: the account's level. */
  loopLevel: LoopLevel | null;
  capOn: boolean;
  /** Dollars per `capPeriod`; null when none was entered. */
  capAmount: number | null;
  capPeriod: SpendPeriod;
  budgetExempt: boolean;
  /** Epoch ms: the cap does not pause the app again before this ("Resume until the cap resets"). */
  capSetAsideUntil: number | null;
  /** Epoch ms; null for an app nobody changed (no row). */
  updatedAt: number | null;
  updatedBy: string | null;
}

/** What an app has before anyone changes anything: everything follows the account. */
export function defaultAppSpendSettings(installId: string): AppSpendSettings {
  return {
    installId,
    unusualFactor: null,
    autoPause: "default",
    customTriggers: false,
    loopOn: true,
    loopLevel: null,
    capOn: true,
    capAmount: null,
    capPeriod: "day",
    budgetExempt: false,
    capSetAsideUntil: null,
    updatedAt: null,
    updatedBy: null,
  };
}

export const appSpendSettingsPatchSchema = z
  .object({
    unusualFactor: unusualFactorSchema.nullable(),
    autoPause: z.enum(AUTO_PAUSE_CHOICES),
    customTriggers: z.boolean(),
    loopOn: z.boolean(),
    loopLevel: z.enum(LOOP_LEVELS).nullable(),
    capOn: z.boolean(),
    capAmount: z.number().positive().nullable(),
    capPeriod: z.enum(SPEND_PERIODS),
    budgetExempt: z.boolean(),
    capSetAsideUntil: z.number().int().nonnegative().nullable(),
  })
  .partial();
export type AppSpendSettingsPatch = z.infer<typeof appSpendSettingsPatchSchema>;

/** An app's settings after the account's defaults are applied. */
export interface EffectiveSpendSettings {
  installId: string;
  autoPause: { on: boolean; followsAccount: boolean };
  /** What pauses the app (when auto-pause is on): its own triggers, or the account's. */
  triggers: {
    custom: boolean;
    loop: { on: boolean; level: LoopLevel };
    /** `amount` is null when the app's own cap has none. */
    cap: { on: boolean; amount: number | null; period: SpendPeriod };
  };
  /** The unusual-usage alert's N× normal, null when off. */
  unusual: { factor: number | null; followsAccount: boolean };
  budgetExempt: boolean;
  capSetAsideUntil: number | null;
}

/**
 * Resolves an app's settings against the account's: auto-pause follows the
 * account unless the app chose on or off; the triggers are the account's
 * unless the app customized them, in which case its loop level falls back to
 * the account's; the unusual-usage factor follows the account unless the
 * app set one (0 is off).
 */
export function resolveSpendSettings(
  defaults: SpendDefaults,
  app: AppSpendSettings,
): EffectiveSpendSettings {
  const followsPause = app.autoPause === "default";
  const factor = app.unusualFactor ?? defaults.unusualFactor;
  return {
    installId: app.installId,
    autoPause: {
      on: followsPause ? defaults.autoPause : app.autoPause === "on",
      followsAccount: followsPause,
    },
    triggers: app.customTriggers
      ? {
          custom: true,
          loop: { on: app.loopOn, level: app.loopLevel ?? defaults.loop.level },
          cap: { on: app.capOn, amount: app.capAmount, period: app.capPeriod },
        }
      : { custom: false, loop: { ...defaults.loop }, cap: { ...defaults.cap } },
    unusual: { factor: factor > 0 ? factor : null, followsAccount: app.unusualFactor === null },
    budgetExempt: app.budgetExempt,
    capSetAsideUntil: app.capSetAsideUntil,
  };
}
