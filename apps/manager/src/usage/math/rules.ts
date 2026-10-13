import type { AccountPlan } from "../../account/plan";
import { activityCostSeries, costSeries, type PeriodSpend, spendInPeriod } from "./cost";
import { daysIn, HOUR_MS, type Period, periodStart } from "./periods";
import { billedPrice, freeDailyLimit, PRODUCT_KEYS, PRODUCTS, type ProductKey } from "./products";
import { normalHour, project, type WindowOptions } from "./projection";
import { sumBetween, type Usage } from "./series";

// ---------- Shares of what the plan allows ----------

export interface ProductShare {
  /** 1 is all of it; past 1 is past it. */
  share: number;
  product: ProductKey;
}

interface ShareOptions extends WindowOptions {
  /** Measure where the pace takes it by the period's end instead of now. */
  projected?: boolean;
}

function countKeys(usage: Usage): ProductKey[] {
  return PRODUCT_KEYS.filter(
    (key) => usage[key] !== undefined && PRODUCTS[key].measure === "count",
  );
}

function usedIn(usage: Usage, key: ProductKey, period: Period, now: number, options: ShareOptions) {
  const series = usage[key] ?? [];
  return options.projected
    ? project(series, period, now, options).projected
    : sumBetween(series, periodStart(period, now), now, now);
}

/** The largest share among products; null when no product has a limit. */
function largest(shares: Iterable<ProductShare>): ProductShare | null {
  let best: ProductShare | null = null;
  for (const s of shares) if (best === null || s.share > best.share) best = s;
  return best;
}

/**
 * How much of a free daily limit the app has used today, for its most-used
 * product (only products Free limits per day). With `projected`, where its
 * pace takes it by midnight UTC.
 */
export function freeDailyShare(
  usage: Usage,
  now: number,
  options: ShareOptions = {},
): ProductShare | null {
  return largest(
    countKeys(usage).flatMap((key) => {
      const limit = freeDailyLimit(key);
      if (limit === null) return [];
      return [{ share: usedIn(usage, key, "day", now, options) / limit, product: key }];
    }),
  );
}

/**
 * How much of what the plan allows the app has used in the period, for its
 * most-used product: of the monthly included amount on Paid, of the free
 * limit on Free. A daily allowance counts once per day of the period.
 */
export function shareOfAllowance(
  usage: Usage,
  plan: AccountPlan,
  period: Period,
  now: number,
  options: ShareOptions = {},
): ProductShare | null {
  return largest(
    countKeys(usage).flatMap((key) => {
      const allowance = plan === "paid" ? PRODUCTS[key].included : PRODUCTS[key].free;
      if (allowance === null) return [];
      const limit =
        allowance.per === "day" ? allowance.amount * daysIn(period, now) : allowance.amount;
      return [{ share: usedIn(usage, key, period, now, options) / limit, product: key }];
    }),
  );
}

/** `value` over `normal`, or null with no normal yet (a normal is never 0). */
function ratioTo(value: number, normal: number | null): number | null {
  return normal === null || normal <= 0 ? null : value / normal;
}

// ---------- Loop check (auto-pause) ----------

export type LoopLevel = "relaxed" | "standard" | "strict";
export const LOOP_LEVEL_NAMES: readonly LoopLevel[] = ["relaxed", "standard", "strict"];
export const DEFAULT_LOOP_LEVEL: LoopLevel = "standard";

/**
 * A loop is real money AND far above the app's normal. Real money is over
 * `usdPerHour` on Paid. On Free it is being on pace to use `freeShare` of a
 * free daily limit by the end of the day, or R2 activity over `usdPerHour`:
 * R2 bills past its free amount even on Free, so its dollars are real there.
 */
export const LOOP_LEVELS: Readonly<
  Record<LoopLevel, { usdPerHour: number; factor: number; freeShare: number }>
> = {
  relaxed: { usdPerHour: 5, factor: 100, freeShare: 0.5 },
  standard: { usdPerHour: 1, factor: 50, freeShare: 0.25 },
  strict: { usdPerHour: 0.25, factor: 20, freeShare: 0.1 },
};

/** Checks in a row (5 minutes apart) that must trip before an app is paused. */
export const LOOP_CHECKS_TO_PAUSE = 2;

/**
 * More alarms than this in an hour from one Durable Object (one a second) is
 * a loop on its own evidence: legitimate objects seen so far stay far below.
 */
export const ALARMS_PER_OBJECT_HOUR = 3_600;

/** Alarms one Durable Object ran in the last hour. */
export interface ObjectAlarms {
  object: string;
  alarms: number;
}

/** The busiest object past the alarm threshold, or null. */
export function alarmLoop(objects: readonly ObjectAlarms[]): ObjectAlarms | null {
  let worst: ObjectAlarms | null = null;
  for (const o of objects) {
    if (o.alarms > ALARMS_PER_OBJECT_HOUR && (worst === null || o.alarms > worst.alarms)) worst = o;
  }
  return worst;
}

export interface LoopCheckInput extends WindowOptions {
  plan: AccountPlan;
  level: LoopLevel;
  usage: Usage;
  now: number;
  /** Alarm counts per Durable Object over the last hour, when known. */
  objectAlarms?: readonly ObjectAlarms[];
}

export interface LoopCheck {
  /** List-price dollars of activity over the last 60 minutes. */
  burn: number;
  /** The app's normal hour of activity, in dollars; null when there is none yet. */
  normal: number | null;
  /** `burn` over `normal`; null when there is no normal yet. */
  ratio: number | null;
  /** Free: the free daily limit the app is on pace to use most of today. */
  freeShare: ProductShare | null;
  /** The money half of the rule holds. */
  money: boolean;
  /** The abnormal half holds: `ratio` at the level's factor, or an alarm loop. */
  abnormal: boolean;
  alarmLoop: ObjectAlarms | null;
  /** This check trips. Pausing takes `LOOP_CHECKS_TO_PAUSE` in a row. */
  trips: boolean;
}

/**
 * One loop check of one app. Both halves must hold, so a tiny app at 100× its
 * normal does not trip, and neither does a busy app at its usual level. An app
 * with no normal yet (a new app) is judged by the money half alone, so a
 * runaway right after install still trips.
 */
export function loopCheck(input: LoopCheckInput): LoopCheck {
  const { plan, usage, now } = input;
  const rule = LOOP_LEVELS[input.level];
  const activity = activityCostSeries(usage, now);
  const burn = sumBetween(activity, now - HOUR_MS, now, now);
  const normal = normalHour(activity, now);
  const ratio = ratioTo(burn, normal);
  const alarm = alarmLoop(input.objectAlarms ?? []);

  let money: boolean;
  let freeShare: ProductShare | null = null;
  if (plan === "paid") {
    money = burn > rule.usdPerHour;
  } else {
    freeShare = freeDailyShare(usage, now, { ...input, projected: true });
    // R2 bills past its free amount even on Free, so its activity's dollars
    // are real money there too, measured against the same `usdPerHour`.
    const billed = sumBetween(
      costSeries(
        usage,
        now,
        (key) => PRODUCTS[key].billedOnFree && PRODUCTS[key].measure === "count",
      ),
      now - HOUR_MS,
      now,
      now,
    );
    money = (freeShare !== null && freeShare.share >= rule.freeShare) || billed > rule.usdPerHour;
  }
  const abnormal = (ratio !== null && ratio >= rule.factor) || alarm !== null;
  return {
    burn,
    normal,
    ratio,
    freeShare,
    money,
    abnormal,
    alarmLoop: alarm,
    trips: money && (abnormal || normal === null),
  };
}

/**
 * The two-checks rule as a state step: given how many checks in a row tripped
 * before, and whether this one did, the new count and whether to pause now.
 */
export function nextLoopStreak(
  previous: number,
  trips: boolean,
): { streak: number; pause: boolean } {
  const streak = trips ? previous + 1 : 0;
  return { streak, pause: streak >= LOOP_CHECKS_TO_PAUSE };
}

// ---------- Unusual usage (alert only) ----------

export const UNUSUAL_FACTORS = [5, 20, 100] as const;
export type UnusualFactor = (typeof UNUSUAL_FACTORS)[number];
export type UnusualSetting = UnusualFactor | "off";
export const DEFAULT_UNUSUAL_FACTOR: UnusualFactor = 20;

/** An hour must cost at least this much to be unusual where it is billed. */
export const UNUSUAL_MIN_USD_PER_HOUR = 0.05;
/** On Free, an hour must use at least this share of a free daily limit. */
export const UNUSUAL_MIN_FREE_SHARE = 0.05;

export interface UnusualUsage {
  product: ProductKey;
  /** Used over the last 60 minutes. */
  lastHour: number;
  /** The product's normal hour for this app. */
  normal: number;
  ratio: number;
  /** List-price dollars of `lastHour`. */
  usd: number;
}

export interface UnusualInput {
  plan: AccountPlan;
  setting: UnusualSetting;
  usage: Usage;
  now: number;
}

/**
 * The product furthest above its normal when the last hour is at least the
 * set factor times it and also matters: costs $0.05 where it is billed, or
 * uses 5% of a free daily limit on Free, so tiny apps do not alert on noise.
 * A product with no normal yet (a new app) cannot be unusual. Null when
 * nothing qualifies or the alert is off.
 */
export function unusualUsage(input: UnusualInput): UnusualUsage | null {
  if (input.setting === "off") return null;
  const factor = input.setting;
  const { plan, usage, now } = input;
  let best: UnusualUsage | null = null;
  for (const key of countKeys(usage)) {
    const series = usage[key] ?? [];
    const lastHour = sumBetween(series, now - HOUR_MS, now, now);
    const normal = normalHour(series, now);
    const ratio = ratioTo(lastHour, normal);
    if (normal === null || ratio === null || ratio < factor) continue;
    const usd = lastHour * billedPrice(key);
    const limit = freeDailyLimit(key);
    const matters =
      plan === "paid" || PRODUCTS[key].billedOnFree
        ? usd >= UNUSUAL_MIN_USD_PER_HOUR
        : limit !== null && lastHour / limit >= UNUSUAL_MIN_FREE_SHARE;
    if (!matters) continue;
    if (best === null || ratio > best.ratio) best = { product: key, lastHour, normal, ratio, usd };
  }
  return best;
}

// ---------- Usage alerts ----------

export interface UsageAlertRule {
  /** `spent`: has passed the amount. `pace`: is on pace to pass it by the period's end. */
  kind: "spent" | "pace";
  /** Dollars at list price, or percent of the allowance of the most-used product. */
  unit: "usd" | "pct";
  amount: number;
  period: Period;
}

/** At or past this share of the target, a rule is close. */
export const NEAR_SHARE = 0.8;

export type UsageAlertState = "watching" | "near" | "on_pace" | "fired";

export interface UsageAlertStatus {
  /** What the rule compares: `spent` or `projected`, by its kind. */
  value: number;
  target: number;
  /** Dollars or percent so far this period. */
  spent: number;
  /** Dollars or percent by the period's end at the current pace. */
  projected: number;
  /** For a percent rule, the product `value` is about. */
  product: ProductKey | null;
  fired: boolean;
  /** Not fired, but on pace to pass the target by the period's end. */
  onPace: boolean;
  /** Neither, but at 80% of the target or more. */
  near: boolean;
  state: UsageAlertState;
}

export interface UsageAlertInput extends WindowOptions {
  plan: AccountPlan;
  rule: UsageAlertRule;
  usage: Usage;
  now: number;
}

/** Where a usage alert rule stands for one app now. */
export function usageAlertStatus(input: UsageAlertInput): UsageAlertStatus {
  const { plan, rule, usage, now } = input;
  let spent: number;
  let projected: number;
  let product: ProductKey | null = null;
  if (rule.unit === "usd") {
    const s = spendInPeriod(usage, rule.period, now, input);
    spent = s.spent;
    projected = s.projected;
  } else {
    const sofar = shareOfAllowance(usage, plan, rule.period, now, input);
    const ahead = shareOfAllowance(usage, plan, rule.period, now, { ...input, projected: true });
    spent = (sofar?.share ?? 0) * 100;
    projected = (ahead?.share ?? 0) * 100;
    product = (rule.kind === "spent" ? sofar?.product : ahead?.product) ?? null;
  }
  const value = rule.kind === "spent" ? spent : projected;
  const target = rule.amount;
  const armed = target > 0;
  const fired = armed && value >= target;
  const onPace = armed && !fired && projected >= target;
  const near = armed && !fired && !onPace && value >= target * NEAR_SHARE;
  const state: UsageAlertState = fired ? "fired" : onPace ? "on_pace" : near ? "near" : "watching";
  return { value, target, spent, projected, product, fired, onPace, near, state };
}

// ---------- Spending cap (auto-pause) ----------

export interface CapStatus extends PeriodSpend {
  cap: number;
  /** Spend this period has reached the cap. */
  passed: boolean;
  /** The start of the hour the spend reached the cap, or null. */
  passedAt: number | null;
}

export interface CapInput extends WindowOptions {
  usage: Usage;
  cap: number;
  period: Period;
  now: number;
}

/**
 * Where an app's list-price spend on activity stands against a cap for the
 * period. Storage is left out: a pause cannot stop it, so it would trip the
 * cap again after every resume.
 */
export function capStatus(input: CapInput): CapStatus {
  const { usage, cap, period, now } = input;
  const spend = spendInPeriod(usage, period, now, input);
  const passed = cap > 0 && spend.spent >= cap;
  let passedAt: number | null = null;
  if (passed) {
    const start = periodStart(period, now);
    let total = 0;
    for (const { hour, value } of activityCostSeries(usage, now)) {
      if (hour < start || hour >= now) continue;
      total += value;
      if (total >= cap) {
        passedAt = hour;
        break;
      }
    }
  }
  return { ...spend, cap, passed, passedAt };
}

// ---------- Monthly budget ----------

/** The projected month bill reached the budget (0 means no budget). */
export function budgetReached(projectedBill: number, budget: number): boolean {
  return budget > 0 && projectedBill >= budget;
}

export interface BudgetCandidate {
  id: string;
  /**
   * The app's projected part of this month's overage, the part of the bill a
   * pause can lower: `accountOverage(apps, plan, now, { projected: true,
   * stopped }).byApp[id].usd`. List-price spend would not do: an app whose
   * use stays within included usage costs nothing to keep running.
   */
  overageUsd: number;
  /** Never paused for the budget; its use still counts toward the bill. */
  exempt: boolean;
  paused: boolean;
}

/**
 * The app the budget pauses next: the one with the largest projected part of
 * the overage that is neither exempt nor already paused. One at a time; the
 * next check pauses another if the projection still does not fit. Null when
 * no app is left whose pause would lower the bill.
 */
export function nextToPauseForBudget(apps: readonly BudgetCandidate[]): string | null {
  let pick: BudgetCandidate | null = null;
  for (const app of apps) {
    if (app.exempt || app.paused || !(app.overageUsd > 0)) continue;
    if (
      pick === null ||
      app.overageUsd > pick.overageUsd ||
      (app.overageUsd === pick.overageUsd && app.id < pick.id)
    ) {
      pick = app;
    }
  }
  return pick?.id ?? null;
}
