import type { AccountPlan } from "../../account/plan";
import {
  DAY_MS,
  dayStart,
  daysIn,
  HOUR_MS,
  HOURS_PER_BILLING_MONTH,
  hoursLeft,
  type Period,
  periodEnd,
  periodStart,
} from "./periods";
import {
  billedPrice,
  PAID_PLAN_MONTHLY_USD,
  PRODUCT_KEYS,
  PRODUCTS,
  type ProductKey,
} from "./products";
import { pace, project, type WindowOptions } from "./projection";
import {
  addSeries,
  type HourValue,
  heldBetween,
  latest,
  type Series,
  sumBetween,
  type Usage,
} from "./series";

/**
 * Money here is usage times Cloudflare's list price: an estimate, not the
 * bill. "Spend" is what an app's activity would cost on its own, ignoring
 * included usage and leaving storage out: pausing an app cannot stop storage
 * charges, so storage counting toward a cap would trip it again after every
 * resume. "Overage" is the account's use past what its plan includes,
 * storage included, the part that is actually charged, split across apps by
 * their share of each product.
 */

function keysOf(usage: Usage): ProductKey[] {
  return PRODUCT_KEYS.filter((key) => usage[key] !== undefined);
}

/**
 * An app's list-price cost hour by hour. A count costs its value times the
 * price; a level costs its price per unit-month for the part of the month
 * that hour is (cut short by `now` for the hour still filling up).
 * `include` picks the products to count; all of them by default.
 */
export function costSeries(
  usage: Usage,
  now: number,
  include: (key: ProductKey) => boolean = () => true,
): HourValue[] {
  const parts: HourValue[][] = [];
  for (const key of keysOf(usage)) {
    if (!include(key)) continue;
    const price = billedPrice(key);
    const isLevel = PRODUCTS[key].measure === "level";
    const part: HourValue[] = [];
    for (const { hour, value } of usage[key] ?? []) {
      const hours = (Math.min(hour + HOUR_MS, now) - hour) / HOUR_MS;
      if (hours <= 0) continue;
      part.push({
        hour,
        value: isLevel ? (value * price * hours) / HOURS_PER_BILLING_MONTH : value * price,
      });
    }
    parts.push(part);
  }
  return addSeries(parts);
}

/**
 * The cost of an app's activity alone: counts, not storage. Spend, burn, caps
 * and the loop check all use it: storage moves slowly, a loop shows in
 * operations, and a pause stops activity but not storage.
 */
export function activityCostSeries(usage: Usage, now: number): HourValue[] {
  return costSeries(usage, now, (key) => PRODUCTS[key].measure === "count");
}

/** List-price dollars of activity over the last 60 minutes: what the app is burning now. */
export function burnPerHour(usage: Usage, now: number): number {
  return sumBetween(activityCostSeries(usage, now), now - HOUR_MS, now, now);
}

export interface PeriodSpend {
  /** Dollars since the period began. */
  spent: number;
  /** Where the current pace takes it by the period's end. */
  projected: number;
  /** Dollars per hour the projection assumes. */
  pace: number;
  /** When the period ends and a new one starts from zero. */
  resetsAt: number;
}

/** An app's list-price spend on activity in the period containing `now`. */
export function spendInPeriod(
  usage: Usage,
  period: Period,
  now: number,
  options: WindowOptions = {},
): PeriodSpend {
  const p = project(activityCostSeries(usage, now), period, now, options);
  return { spent: p.used, projected: p.projected, pace: p.pace, resetsAt: periodEnd(period, now) };
}

/** What the plan lets an account use of a product before charging, or null. */
function allowanceOn(key: ProductKey, plan: AccountPlan) {
  const p = PRODUCTS[key];
  if (plan === "paid") return p.included;
  return p.billedOnFree ? p.free : null;
}

export interface ProductMonth {
  /** Units used this month (unit-months for a level). */
  amount: number;
  /** What the plan includes this month, in the same units. */
  included: number;
  /** Dollars past `included`. */
  usd: number;
}

export interface MonthOptions {
  /** Carry the current pace to the month's end. */
  projected?: boolean;
  /**
   * The series the pace is taken from, when not the one measured: the account
   * without its paused apps, whose use has stopped even though their last
   * hours still lift the average.
   */
  paceFrom?: Series;
}

/**
 * The use of one product this calendar month and what it costs past the
 * plan's allowance. A daily allowance (Workers AI) is applied day by day. On
 * Free only the products that bill past their free amount (R2) cost anything.
 */
export function productMonth(
  key: ProductKey,
  series: Series,
  plan: AccountPlan,
  now: number,
  options: MonthOptions = {},
): ProductMonth {
  const product = PRODUCTS[key];
  const allowance = allowanceOn(key, plan);
  const start = periodStart("month", now);
  const price = billedPrice(key);
  const projected = options.projected === true;

  if (product.measure === "level") {
    // Storage stays held (and billed) while an app is paused.
    let held = heldBetween(series, start, now, now);
    if (projected) held += latest(series, now) * hoursLeft("month", now);
    const amount = held / HOURS_PER_BILLING_MONTH;
    const included = allowance?.amount ?? 0;
    const usd = allowance ? Math.max(0, amount - included) * price : 0;
    return { amount, included, usd };
  }

  const perHour = projected ? pace(options.paceFrom ?? series, now) : 0;

  if (allowance?.per === "day") {
    const today = dayStart(now);
    let amount = 0;
    let past = 0;
    for (let day = start; day < periodEnd("month", now); day += DAY_MS) {
      let used = 0;
      if (day < today) used = sumBetween(series, day, day + DAY_MS, now);
      else if (day === today)
        used = sumBetween(series, day, now, now) + perHour * hoursLeft("day", now);
      else if (projected) used = perHour * 24;
      else break;
      amount += used;
      past += Math.max(0, used - allowance.amount);
    }
    return { amount, included: allowance.amount * daysIn("month", now), usd: past * price };
  }

  const amount = sumBetween(series, start, now, now) + perHour * hoursLeft("month", now);
  const included = allowance?.amount ?? 0;
  const usd = allowance ? Math.max(0, amount - included) * price : 0;
  return { amount, included, usd };
}

export interface AppOverage {
  usd: number;
  byProduct: Partial<Record<ProductKey, number>>;
}

export interface AccountOverage {
  /** Dollars past included for the whole account this month. */
  usd: number;
  byProduct: Partial<Record<ProductKey, ProductMonth>>;
  /** Each app's part of `usd`, by its share of each product's use. */
  byApp: Record<string, AppOverage>;
}

export interface OverageOptions {
  projected?: boolean;
  /**
   * Apps that are paused: projected as using nothing more (storage aside).
   * Without this a budget check right after a pause still sees the paused
   * app's pace and pauses another.
   */
  stopped?: ReadonlySet<string>;
}

/**
 * The account's usage past included this month, split across apps: each
 * product's overage goes to the apps in proportion to their use of it, so the
 * apps' parts always add up to the total. `apps` should hold everything that uses the account's allowance; anything
 * missing makes the estimate low.
 */
export function accountOverage(
  apps: Readonly<Record<string, Usage>>,
  plan: AccountPlan,
  now: number,
  options: OverageOptions = {},
): AccountOverage {
  const stopped = options.stopped ?? new Set<string>();
  const projected = options.projected === true;
  const result: AccountOverage = { usd: 0, byProduct: {}, byApp: {} };
  for (const id of Object.keys(apps)) result.byApp[id] = { usd: 0, byProduct: {} };

  for (const key of PRODUCT_KEYS) {
    const users = Object.entries(apps).filter(([, usage]) => usage[key] !== undefined);
    if (users.length === 0) continue;
    const total = productMonth(key, addSeries(users.map(([, u]) => u[key] ?? [])), plan, now, {
      projected,
      paceFrom: addSeries(users.filter(([id]) => !stopped.has(id)).map(([, u]) => u[key] ?? [])),
    });
    result.byProduct[key] = total;
    result.usd += total.usd;
    if (total.usd === 0) continue;
    // Each app's own projection. The pace takes the faster of two windows, so
    // the apps' projections need not add up to the account's: share by their
    // sum, not by the account's amount.
    const amounts = users.map(([id, usage]) => {
      const series = usage[key] ?? [];
      const paceFrom = stopped.has(id) ? [] : series;
      return [id, productMonth(key, series, plan, now, { projected, paceFrom }).amount] as const;
    });
    const sum = amounts.reduce((t, [, amount]) => t + amount, 0);
    if (sum === 0) continue;
    for (const [id, mine] of amounts) {
      const usd = total.usd * (mine / sum);
      const app = result.byApp[id];
      if (app === undefined || usd === 0) continue;
      app.byProduct[key] = usd;
      app.usd += usd;
    }
  }
  return result;
}

/**
 * The month's bill: on Paid the plan's $5 plus usage past included; on Free
 * whatever bills past its free amount (R2).
 */
export function monthBill(plan: AccountPlan, overageUsd: number): number {
  return (plan === "paid" ? PAID_PLAN_MONTHLY_USD : 0) + overageUsd;
}
