import { z } from "zod";
import { type ActivityKind, PAUSE_REASONS } from "../../db/usage-schema";

/**
 * The facts each kind of usage activity carries (`usage_activity.facts_json`).
 * Each kind names the facts its message and marker need; a writer may add
 * more, which are kept. Instants are epoch ms; `periodStart` and `monthStart`
 * unix seconds, like the usage tables.
 */

const jobId = z.string().min(1).nullable().optional();

export const ACTIVITY_FACTS = {
  /** An unusual-usage episode began: the alert's N× setting and how far above normal it was. */
  unusual_started: z.looseObject({
    factor: z.number().positive(),
    times: z.number().nonnegative(),
  }),
  /** The episode ended; `startedAt` is when it began. */
  unusual_ended: z.looseObject({ startedAt: z.number().int().nonnegative() }),
  /** A usage alert was sent: the rule's sentence as it read then, and what it saw. */
  alert_sent: z.looseObject({
    ruleId: z.string().min(1),
    sentence: z.string().min(1),
    periodStart: z.number().int(),
    value: z.number(),
    amount: z.number(),
  }),
  /** A free daily limit runs out today. */
  limit_near: z.looseObject({
    product: z.string().min(1),
    share: z.number().nonnegative(),
    runsOutAt: z.number().int().nullable(),
  }),
  /** The month's bill is on pace to pass the budget (account-wide). */
  budget_reached: z.looseObject({
    monthStart: z.number().int(),
    budget: z.number().positive(),
    projected: z.number().nonnegative(),
  }),
  paused: z.looseObject({ pauseId: z.string().min(1), reason: z.enum(PAUSE_REASONS), jobId }),
  resumed: z.looseObject({ pauseId: z.string().min(1), jobId }),
  pause_failed: z.looseObject({
    reason: z.enum(PAUSE_REASONS),
    jobId,
    error: z.string().min(1),
  }),
  resume_failed: z.looseObject({
    pauseId: z.string().min(1).nullable().optional(),
    jobId,
    error: z.string().min(1),
  }),
  /** Which spend protection settings changed (their names, not their values). */
  settings_changed: z.looseObject({ changed: z.array(z.string().min(1)).min(1) }),
  /** "Resume until the cap resets": the cap is set aside until then. */
  cap_set_aside: z.looseObject({ until: z.number().int().nonnegative() }),
  /** Workers Logs turned on or off for the app. */
  observability_changed: z.looseObject({ enabled: z.boolean() }),
} as const satisfies Record<ActivityKind, z.ZodType>;

export type ActivityFacts = { [K in ActivityKind]: z.infer<(typeof ACTIVITY_FACTS)[K]> };

/** One entry of the log, its facts typed by its kind. */
export type Activity = {
  [K in ActivityKind]: {
    id: string;
    /** Null for the account. */
    installId: string | null;
    /** Epoch ms. */
    at: number;
    kind: K;
    /** The user id; null for Appflare on its own. */
    by: string | null;
    facts: ActivityFacts[K];
  };
}[ActivityKind];
