import { UNUSUAL_FACTORS, type UnusualFactor } from "../store/spend-settings";

/**
 * The unusual-usage alert's choices for a select: off, or at 5×, 20× or
 * 100× the app's normal hour. Values are the stored factors as text (0 is
 * off), since a select's values are strings.
 */
export const UNUSUAL_FACTOR_ITEMS: { value: string; label: string }[] = UNUSUAL_FACTORS.map(
  (factor) => ({
    value: String(factor),
    label: factor === 0 ? "Don't alert" : `At ${factor}× its normal`,
  }),
);

/** A select's value back as a factor, or null when it is not one of them. */
export function unusualFactorOf(value: unknown): UnusualFactor | null {
  return UNUSUAL_FACTORS.find((f) => String(f) === String(value)) ?? null;
}
