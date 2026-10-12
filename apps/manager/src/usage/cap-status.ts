import type { StillPastCap } from "./attention";
import type { PauseCause } from "./attention-cause";
import { periodEnd, periodStart } from "./math";
import type { EffectiveSpendSettings } from "./store/spend-settings";

/**
 * Whether resuming a paused app as it is would only last until the spend
 * watcher's next check: it was paused past its spending cap, auto-pause and
 * that cap still apply, the cap is not set aside, and the cap's period has
 * not reset since. Then Resume offers to set the cap aside until it resets
 * (Home and the app's Usage tab). Null otherwise. Pure; client-safe.
 */
export function stillPastCap(
  pause: { pausedAt: number; cause: PauseCause | null },
  effective: EffectiveSpendSettings,
  now: number,
): StillPastCap | null {
  const { cause } = pause;
  if (cause?.reason !== "cap") return null;
  const cap = effective.triggers.cap;
  if (cap.amount === null) return null;
  const setAside = effective.capSetAsideUntil !== null && effective.capSetAsideUntil > now;
  const stillOver =
    effective.autoPause.on &&
    cap.on &&
    !setAside &&
    cap.period === cause.period &&
    periodStart(cap.period, pause.pausedAt) === periodStart(cap.period, now) &&
    (cause.spent ?? cause.amount) >= cap.amount;
  if (!stillOver) return null;
  return {
    amount: cap.amount,
    period: cap.period,
    spent: cause.spent ?? null,
    resetsAt: periodEnd(cap.period, now),
  };
}
