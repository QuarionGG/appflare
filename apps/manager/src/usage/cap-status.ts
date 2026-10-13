import type { AccountPlan } from "../account/plan";
import type { StillPastCap } from "./attention";
import type { PauseCause } from "./attention-cause";
import { type Period, periodEnd, periodStart } from "./math";
import type { EffectiveSpendSettings } from "./store/spend-settings";

/**
 * Whether resuming a paused app as it is would only last until the spend
 * watcher's next check: it is past its spending cap now, auto-pause and that
 * cap still apply, and the cap is not set aside. Whatever paused it (a loop,
 * the budget, someone by hand): the cap would pause it again. Then Resume
 * offers to set the cap aside until it resets (Home and the app's Usage tab).
 * Null otherwise. Pure; client-safe.
 *
 * `now.spent` is what the app spent in each period by the latest numbers
 * (activity at list price, as the watcher's cap check counts it). Without
 * them, only a pause for the cap tells, by what it recorded, while the
 * cap's period has not reset since. Workers Free has no dollar caps.
 */
export function stillPastCap(
  pause: { pausedAt: number; cause: PauseCause | null },
  effective: EffectiveSpendSettings,
  now: number,
  numbers: { spent?: Partial<Record<Period, number>> | null; plan?: AccountPlan } = {},
): StillPastCap | null {
  if (numbers.plan === "free") return null;
  const { cause } = pause;
  const cap = effective.triggers.cap;
  if (cap.amount === null) return null;
  const setAside = effective.capSetAsideUntil !== null && effective.capSetAsideUntil > now;
  if (!effective.autoPause.on || !cap.on || setAside) return null;
  const latest = numbers.spent?.[cap.period];
  /** What it spent, when known; and what it is compared with (a cap pause's own record at least passed it). */
  let spent: number | null = latest ?? null;
  let compared: number | null = spent;
  if (
    latest === undefined &&
    cause?.reason === "cap" &&
    cap.period === cause.period &&
    periodStart(cap.period, pause.pausedAt) === periodStart(cap.period, now)
  ) {
    spent = cause.spent ?? null;
    compared = cause.spent ?? cause.amount;
  }
  if (compared === null || compared < cap.amount) return null;
  return {
    amount: cap.amount,
    period: cap.period,
    spent,
    resetsAt: periodEnd(cap.period, now),
  };
}
