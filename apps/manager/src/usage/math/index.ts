/**
 * The usage math behind spend protection: prices and limits, periods,
 * projections, list-price cost, and the checks that alert or pause an app.
 *
 * Pure functions, no I/O, so the watcher and the pages compute the same
 * answers. Usage goes in as hourly points per product (`Usage`): `hour` is the
 * start of a UTC hour in milliseconds, `value` what was used in that hour (a
 * count) or held during it (a level, like GB stored). Every function takes
 * `now`; the hour containing it is the one still filling up. Missing hours
 * count as zero, so a level needs a point for every hour it is held.
 *
 * Spend, burn and caps count activity only; storage counts toward the bill
 * (overage) but not toward anything a pause is meant to stop.
 */

export {
  type AccountOverage,
  type AppOverage,
  accountOverage,
  activityCostSeries,
  burnPerHour,
  costSeries,
  type MonthOptions,
  monthBill,
  type OverageOptions,
  type PeriodSpend,
  type ProductMonth,
  productMonth,
  spendInPeriod,
} from "./cost";
export {
  DAY_MS,
  dayStart,
  daysIn,
  HOUR_MS,
  HOURS_PER_BILLING_MONTH,
  hourStart,
  hoursLeft,
  PERIODS,
  type Period,
  periodEnd,
  periodKey,
  periodStart,
} from "./periods";
export {
  type Allowance,
  billedPrice,
  freeDailyLimit,
  PAID_PLAN_MONTHLY_USD,
  PRODUCT_KEYS,
  PRODUCTS,
  type Product,
  type ProductKey,
} from "./products";
export {
  normalHour,
  type Projection,
  pace,
  project,
  type WindowOptions,
} from "./projection";
export {
  lastHourRate,
  MIN_RESUME_WINDOW_MS,
  type ResumeWindow,
  resumeBase,
  resumeMatters,
  usageSinceResume,
} from "./resume";
export {
  ALARMS_PER_OBJECT_HOUR,
  alarmLoop,
  type BudgetCandidate,
  budgetReached,
  type CapInput,
  type CapStatus,
  capStatus,
  DEFAULT_LOOP_LEVEL,
  DEFAULT_UNUSUAL_FACTOR,
  freeDailyShare,
  type HeavyNewUse,
  heavyNewUse,
  LOOP_CHECKS_TO_PAUSE,
  LOOP_LEVEL_NAMES,
  LOOP_LEVELS,
  type LoopCheck,
  type LoopCheckInput,
  type LoopLevel,
  loopCheck,
  NEAR_SHARE,
  nextLoopStreak,
  nextToPauseForBudget,
  type ObjectAlarms,
  type ProductShare,
  shareOfAllowance,
  UNUSUAL_FACTORS,
  UNUSUAL_MIN_FREE_SHARE,
  UNUSUAL_MIN_USD_PER_HOUR,
  type UnusualFactor,
  type UnusualInput,
  type UnusualSetting,
  type UnusualUsage,
  type UsageAlertInput,
  type UsageAlertRule,
  type UsageAlertState,
  type UsageAlertStatus,
  unusualUsage,
  usageAlertStatus,
} from "./rules";
export type { HourValue, Series, Usage } from "./series";
