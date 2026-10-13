import type { AccountPlan } from "../account/plan";
import type { PauseCause } from "./attention-cause";
import { stillPastCap } from "./cap-status";
import {
  accountOverage,
  activityCostSeries,
  DAY_MS,
  dayStart,
  daysIn,
  freeDailyShare,
  HOUR_MS,
  hourStart,
  NEAR_SHARE,
  normalHour,
  PERIODS,
  PRODUCT_KEYS,
  PRODUCTS,
  type ProductKey,
  periodEnd,
  periodStart,
  project,
  type Usage,
  usageAlertStatus,
} from "./math";
import { NORMAL_DAYS } from "./math/projection";
import { type HourValue, latest, sumBetween } from "./math/series";
import type { AppObservability } from "./observability.server";
import type { SpendApp } from "./overview";
import type { AlertRule } from "./store/alert-rules.server";
import type { UsageRow } from "./store/series.server";
import type {
  AppSpendSettings,
  EffectiveSpendSettings,
  SpendDefaults,
} from "./store/spend-settings";
import {
  type AlertRuleView,
  FRESH_MS,
  HOT_RATIO,
  type PauseView,
  type Point,
  type ProductUsage,
  type UsageEvent,
  type UsageStatus,
  type UsageTabData,
} from "./tab";
import type { SpendWatchStatus } from "./watcher-status";

/**
 * The Usage tab's numbers from what `readUsageTab` read: the app's own
 * series, the account's use of the same products, its settings, rules,
 * pause and history. Pure, so the page's states can be tested without D1.
 */

/** Days of the app's hourly rows the tab reads: the normal hour needs the 7 days before the last. */
export const APP_HOURLY_DAYS = NORMAL_DAYS + 1;
/** Hours the chart shows hour by hour (7 days). */
const CHART_HOURS = 7 * 24;
/** The hour still filling up is shown at its pace once this much of it is known, at least. */
const MIN_FILLED_MS = 10 * 60_000;
/** Days the 30-day chart shows. */
const CHART_DAYS = 30;
/** How long before unusual usage began a change counts as what started it. */
const CHANGE_BEFORE_MS = 2 * HOUR_MS;
/** An unusual-usage record this long before the episode's start still belongs to it. */
export const EPISODE_SLACK_MS = 10 * 60_000;

/** Where the app's hourly rows start: the reads and the series agree on it. */
export function appHourlyFrom(now: number): number {
  return dayStart(now) - APP_HOURLY_DAYS * DAY_MS;
}

/** Where the app's daily rows start: the month's first day or 30 days back, whichever is earlier. */
export function appDailyFrom(now: number): number {
  return Math.min(periodStart("month", now), dayStart(now) - (CHART_DAYS - 1) * DAY_MS);
}

/** Where the account's hourly rows start: yesterday, so the pace sees a whole day. */
export function accountHourlyFrom(now: number): number {
  return dayStart(now) - DAY_MS;
}

function isProductKey(key: string): key is ProductKey {
  return Object.hasOwn(PRODUCTS, key);
}

/**
 * Hourly series per install and product from hourly rows from `hourlyFrom`
 * on and daily rows before it (a day's total in its first hour; a level
 * held each hour of the day at the day's last level), as the overview does.
 */
export function usageFromRows(
  hourly: readonly UsageRow[],
  daily: readonly UsageRow[],
  hourlyFrom: number,
  monthFrom: number,
): Map<string, Usage> {
  const out = new Map<string, Usage>();
  const add = (installId: string, key: ProductKey, points: HourValue[]) => {
    const usage = out.get(installId) ?? {};
    usage[key] = [...(usage[key] ?? []), ...points];
    out.set(installId, usage);
  };
  for (const row of daily) {
    const day = row.t * 1000;
    if (!isProductKey(row.product) || day < monthFrom || day >= hourlyFrom) continue;
    add(
      row.installId,
      row.product,
      PRODUCTS[row.product].measure === "level"
        ? Array.from({ length: 24 }, (_, h) => ({ hour: day + h * HOUR_MS, value: row.value }))
        : [{ hour: day, value: row.value }],
    );
  }
  for (const row of hourly) {
    if (!isProductKey(row.product) || row.t * 1000 < hourlyFrom) continue;
    add(row.installId, row.product, [{ hour: row.t * 1000, value: row.value }]);
  }
  return out;
}

/** Facts of the newest unusual-usage start, as the watcher records them. */
export interface UnusualFacts {
  at: number;
  product: string | null;
  times: number | null;
  freeShare: number | null;
  /** The episode is a new app (no normal yet) using a lot. */
  newApp?: boolean;
  /** With `newApp`: installed within the last 7 days. */
  installedRecently?: boolean;
}

export interface UsageTabInput {
  installId: string;
  now: number;
  plan: AccountPlan;
  installedAt: number;
  /** The usage scopes the Cloudflare grant lacks. */
  missingScopes: string[];
  /** What the spend watcher last said about reading usage; null before it ran. */
  watch: SpendWatchStatus | null;
  updatedAt: number;
  /** This app's hourly rows from `appHourlyFrom`. */
  appHourly: readonly UsageRow[];
  /** This app's daily rows from `appDailyFrom`. */
  appDaily: readonly UsageRow[];
  /** Every install's daily rows this month, of the app's products. */
  accountDaily: readonly UsageRow[];
  /** Every install's hourly rows from `accountHourlyFrom`, of the app's products. */
  accountHourly: readonly UsageRow[];
  /** Installs that are paused (their pace counts as stopped for the bill). */
  paused: ReadonlySet<string>;
  defaults: SpendDefaults;
  own: AppSpendSettings;
  effective: EffectiveSpendSettings;
  /** The app's numbers in the watcher's snapshot; undefined when it has none. */
  snapshot: SpendApp | undefined;
  rules: readonly AlertRule[];
  /** The `alert_sent` records of the current periods: which rule, for which period (unix seconds). */
  alertsSent: readonly { ruleId: string; periodStart: number }[];
  pause: {
    pausedAt: number;
    by: string | null;
    cause: PauseCause | null;
  } | null;
  /** When the app's current unusual-usage episode began; null outside one. */
  unusualSince: number | null;
  /** What the watcher recorded when the current episode began, if it did. */
  unusual: UnusualFacts | null;
  events: readonly UsageEvent[];
  channels: string[] | null;
  logs: AppObservability | null;
}

/** A level's value at each hour from `from`, carried forward over missing hours. */
function hourPoints(
  rows: ReadonlyMap<number, number>,
  from: number,
  count: number,
  step: number,
  level: boolean,
  carried: number,
): Point[] {
  const out: Point[] = [];
  let last = carried;
  for (let i = 0; i < count; i++) {
    const at = from + i * step;
    const value = rows.get(at);
    if (value !== undefined) last = value;
    out.push([at, value ?? (level ? last : 0)]);
  }
  return out;
}

/** What the plan allows of a product and how much of it the account used. */
function allowanceOf(
  key: ProductKey,
  plan: AccountPlan,
  now: number,
  account: { today: number; month: number; level: number },
): ProductUsage["allowance"] {
  const product = PRODUCTS[key];
  const level = product.measure === "level";
  if (plan === "paid") {
    const inc = product.included;
    const limit = inc.per === "day" && !level ? inc.amount * daysIn("month", now) : inc.amount;
    if (!(limit > 0)) return null;
    return { share: (level ? account.level : account.month) / limit, daily: false };
  }
  const free = product.free;
  if (free === null || !(free.amount > 0)) return null;
  if (level) return { share: account.level / free.amount, daily: false };
  return free.per === "day"
    ? { share: account.today / free.amount, daily: true }
    : { share: account.month / free.amount, daily: false };
}

export function buildUsageTab(input: UsageTabInput): UsageTabData {
  const { now, plan, installId } = input;
  const since = input.installedAt > 0 && input.installedAt < now ? input.installedAt : undefined;
  // A paused app uses nothing more: its projections hold where it stopped.
  const stopped = input.pause !== null;
  const monthFrom = periodStart("month", now);
  const today = dayStart(now);
  const hourlyFrom = appHourlyFrom(now);
  const appUsage =
    usageFromRows(input.appHourly, input.appDaily, hourlyFrom, monthFrom).get(installId) ?? {};

  // The account's use of the app's products: today's and this month's, the levels held now.
  const accountToday = new Map<string, number>();
  const accountMonth = new Map<string, number>();
  const levelByInstall = new Map<string, Map<string, { day: number; value: number }>>();
  for (const row of input.accountDaily) {
    const day = row.t * 1000;
    if (day < monthFrom) continue;
    accountMonth.set(row.product, (accountMonth.get(row.product) ?? 0) + row.value);
    if (day === today)
      accountToday.set(row.product, (accountToday.get(row.product) ?? 0) + row.value);
    const held = levelByInstall.get(row.product) ?? new Map();
    const prev = held.get(row.installId);
    if (prev === undefined || prev.day < day) held.set(row.installId, { day, value: row.value });
    levelByInstall.set(row.product, held);
  }
  const accountLevel = (key: string) =>
    [...(levelByInstall.get(key)?.values() ?? [])].reduce((t, v) => t + v.value, 0);

  const overage =
    plan === "paid"
      ? accountOverage(
          Object.fromEntries(
            usageFromRows(
              input.accountHourly,
              input.accountDaily,
              accountHourlyFrom(now),
              monthFrom,
            ),
          ),
          plan,
          now,
          { projected: true, stopped: input.paused },
        ).byApp[installId]
      : undefined;

  // The app's rows by product and time, for the charts.
  const hourRows = new Map<string, Map<number, number>>();
  for (const row of input.appHourly) {
    const m = hourRows.get(row.product) ?? new Map();
    m.set(row.t * 1000, row.value);
    hourRows.set(row.product, m);
  }
  const dayRows = new Map<string, Map<number, number>>();
  for (const row of input.appDaily) {
    const m = dayRows.get(row.product) ?? new Map();
    m.set(row.t * 1000, row.value);
    dayRows.set(row.product, m);
  }

  const chartFrom = hourStart(now) - (CHART_HOURS - 1) * HOUR_MS;
  const daysFrom = today - (CHART_DAYS - 1) * DAY_MS;
  const used = PRODUCT_KEYS.filter((key) => hourRows.has(key) || dayRows.has(key));
  const products: ProductUsage[] = used.map((key) => {
    const level = PRODUCTS[key].measure === "level";
    const series = appUsage[key] ?? [];
    const hours = hourPoints(
      hourRows.get(key) ?? new Map(),
      chartFrom,
      CHART_HOURS,
      HOUR_MS,
      level,
      latest(series, chartFrom - 1),
    ).map(([at, value]): Point => {
      // The hour still filling up, at its pace an hour, so the line does not dip at its end.
      if (level || at < hourStart(now)) return [at, value];
      return [at, (value * HOUR_MS) / Math.max(now - at, MIN_FILLED_MS)];
    });
    const dayValues = dayRows.get(key) ?? new Map<number, number>();
    const days = hourPoints(dayValues, daysFrom, CHART_DAYS, DAY_MS, level, 0).map(
      ([at, value]): Point => {
        if (level) return [at, value];
        // A count's day as its average hour; today's over the hours so far.
        const hoursIn = Math.max(1, (Math.min(at + DAY_MS, now) - at) / HOUR_MS);
        return [at, value / hoursIn];
      },
    );
    const account = {
      today: accountToday.get(key) ?? 0,
      month: accountMonth.get(key) ?? 0,
      level: accountLevel(key),
    };
    const allowance = allowanceOf(key, plan, now, account);
    const overageUsd = plan === "paid" ? (overage?.byProduct[key] ?? 0) : null;
    if (level) {
      const held = latest(series, now);
      return {
        key,
        level,
        hours,
        days,
        lastHour: held,
        normal: null,
        ratio: null,
        hot: false,
        today: held,
        month: null,
        projectedMonth: null,
        allowance,
        overageUsd,
      };
    }
    const lastHour = sumBetween(series, now - HOUR_MS, now, now);
    const normal = normalHour(series, now);
    const ratio = normal !== null && normal > 0 ? lastHour / normal : null;
    const month = sumBetween(series, monthFrom, now, now);
    return {
      key,
      level,
      hours,
      days,
      lastHour,
      normal,
      ratio,
      hot: ratio !== null && ratio >= HOT_RATIO,
      today: sumBetween(series, today, now, now),
      month,
      projectedMonth: stopped ? month : project(series, "month", now, { since }).projected,
      allowance,
      overageUsd,
    };
  });

  const byKey = new Map(products.map((p) => [p.key, p]));
  const hottest =
    products.filter((p) => p.hot).sort((a, b) => (b.ratio ?? 0) - (a.ratio ?? 0))[0]?.key ?? null;
  const fallback =
    hottest ??
    (byKey.has("workers_requests") ? "workers_requests" : null) ??
    products.find((p) => !p.level)?.key ??
    products[0]?.key ??
    null;
  const known = (key: string | null | undefined): ProductKey | null =>
    key != null && isProductKey(key) && byKey.has(key) ? key : null;

  const snap = input.snapshot;
  const pause: PauseView | null =
    input.pause === null
      ? null
      : {
          pausedAt: input.pause.pausedAt,
          by: input.pause.by,
          cause: input.pause.cause,
          loopSince:
            input.unusualSince !== null && input.unusualSince <= input.pause.pausedAt
              ? input.unusualSince
              : null,
          stillPastCap: stillPastCap(input.pause, input.effective, now, {
            spent:
              snap === null || snap === undefined
                ? null
                : {
                    day: snap.spend.day.spent,
                    week: snap.spend.week.spent,
                    month: snap.spend.month.spent,
                  },
            plan,
          }),
        };

  const unusual = input.unusualSince === null ? null : input.unusual;

  // Today's newest free daily limit record.
  const limitToday = input.events.find(
    (e): e is Extract<UsageEvent, { kind: "limit_near" }> =>
      e.kind === "limit_near" && e.at >= today,
  );

  let status: UsageStatus;
  let headline: ProductKey | null = fallback;
  const needsAccess = input.watch?.state === "needs_access" ? input.watch : null;
  if (input.missingScopes.length > 0 || needsAccess !== null) {
    status = { kind: "reconnect", via: needsAccess?.via ?? "oauth" };
  } else if (products.length === 0 && now - input.installedAt < FRESH_MS) {
    status = { kind: "fresh", installedAt: input.installedAt };
  } else if (pause !== null) {
    // The product of the unusual usage that led to it, when there was some.
    const before = input.events.find(
      (e) =>
        e.kind === "unusual_started" && e.at <= pause.pausedAt && e.at >= pause.pausedAt - DAY_MS,
    );
    headline = known(before?.kind === "unusual_started" ? before.product : null) ?? fallback;
    status = { kind: "paused", pause, product: headline };
  } else if (
    limitToday !== undefined &&
    known(limitToday.product) !== null &&
    (limitToday.share >= 1 || limitToday.runsOutAt === null || limitToday.runsOutAt <= now)
  ) {
    const product = known(limitToday.product) as ProductKey;
    const freeAmount = PRODUCTS[product].free?.amount ?? 0;
    const app = byKey.get(product);
    headline = product;
    status = {
      kind: "limit",
      product,
      limit: freeAmount,
      loopSince: input.unusualSince,
      appShare:
        app !== undefined && (accountToday.get(product) ?? 0) > 0
          ? app.today / (accountToday.get(product) ?? 1)
          : null,
    };
  } else if (
    input.unusualSince !== null ||
    (snap?.loop[input.effective.triggers.loop.level].trips ?? false)
  ) {
    const product = known(unusual?.product) ?? fallback;
    headline = product;
    const p = product === null ? undefined : byKey.get(product);
    const startedAt = input.unusualSince;
    const change =
      startedAt === null
        ? undefined
        : input.events.find(
            (e) =>
              (e.kind === "updated" || e.kind === "app_settings") &&
              e.at <= startedAt &&
              e.at >= startedAt - CHANGE_BEFORE_MS,
          );
    if (product === null || p === undefined) {
      status = { kind: "normal", requestsShare: null };
    } else {
      status = {
        kind: "runaway",
        product,
        perHour: p.lastHour,
        ratio: p.ratio ?? unusual?.times ?? null,
        newApp: unusual?.newApp === true && p.ratio === null,
        installedRecently: unusual?.installedRecently === true,
        since: startedAt,
        burnPerHour: snap?.burnPerHour ?? 0,
        spentToday: snap?.spend.day.spent ?? 0,
        freeShare:
          plan === "free"
            ? (unusual?.freeShare ??
              freeDailyShare(appUsage, now, { projected: true, since })?.share ??
              null)
            : null,
        after:
          change?.kind === "updated"
            ? { kind: "update", version: change.version }
            : change?.kind === "app_settings"
              ? { kind: "settings" }
              : null,
      };
    }
  } else if (hottest !== null) {
    const p = byKey.get(hottest);
    status = { kind: "busy", product: hottest, perHour: p?.lastHour ?? 0, ratio: p?.ratio ?? 0 };
  } else if (products.length === 0) {
    status = { kind: "empty" };
  } else {
    const mine = byKey.get("workers_requests")?.today ?? 0;
    const all = accountToday.get("workers_requests") ?? 0;
    status = { kind: "normal", requestsShare: mine > 0 && all > 0 ? mine / all : null };
  }

  // Which rules sent their alert in their current period: from the records, never inferred.
  const sent = new Set(
    input.rules
      .filter(
        (rule) =>
          input.alertsSent.some(
            (a) => a.ruleId === rule.id && a.periodStart * 1000 === periodStart(rule.period, now),
          ) ||
          (rule.lastFiring !== null &&
            rule.lastFiring.periodStart * 1000 === periodStart(rule.period, now)),
      )
      .map((rule) => rule.id),
  );
  const rules: AlertRuleView[] = input.rules.map((rule) => {
    const s = usageAlertStatus({ plan, rule, usage: appUsage, now, since });
    const projected = stopped ? s.spent : s.projected;
    const value = rule.kind === "spent" ? s.spent : projected;
    const state: AlertRuleView["state"] = sent.has(rule.id)
      ? "fired"
      : rule.amount > 0 && (value >= rule.amount || projected >= rule.amount)
        ? "on_pace"
        : rule.amount > 0 && value >= rule.amount * NEAR_SHARE
          ? "near"
          : "watching";
    return {
      id: rule.id,
      kind: rule.kind,
      unit: rule.unit,
      amount: rule.amount,
      period: rule.period,
      spent: s.spent,
      projected,
      state,
    };
  });
  const alertsSent = sent.size;

  const costFrom = Math.min(...PERIODS.map((p) => periodStart(p, now)));
  const costHours: Point[] = activityCostSeries(appUsage, now)
    .filter((h) => h.hour >= costFrom)
    .map((h) => [h.hour, h.value]);

  const quiet = { money: false, abnormal: false, trips: false };
  return {
    installId,
    plan,
    now,
    updatedAt: input.updatedAt,
    installedAt: input.installedAt,
    missingScopes: [...new Set([...input.missingScopes, ...(needsAccess?.missing ?? [])])],
    status,
    headline,
    products,
    costHours,
    spend: {
      defaults: input.defaults,
      own: {
        unusualFactor: input.own.unusualFactor,
        autoPause: input.own.autoPause,
        customTriggers: input.own.customTriggers,
        loopOn: input.own.loopOn,
        loopLevel: input.own.loopLevel,
        capOn: input.own.capOn,
        capAmount: input.own.capAmount,
        capPeriod: input.own.capPeriod,
        budgetExempt: input.own.budgetExempt,
      },
      effective: input.effective,
      burnPerHour: snap?.burnPerHour ?? 0,
      ratio: snap?.ratio ?? null,
      loop: snap?.loop ?? { relaxed: quiet, standard: quiet, strict: quiet },
      periods:
        (snap === undefined
          ? undefined
          : stopped
            ? (Object.fromEntries(
                PERIODS.map((p) => [p, { ...snap.spend[p], projected: snap.spend[p].spent }]),
              ) as UsageTabData["spend"]["periods"])
            : snap.spend) ??
        (Object.fromEntries(
          PERIODS.map((p) => [p, { spent: 0, projected: 0, resetsAt: periodEnd(p, now) }]),
        ) as UsageTabData["spend"]["periods"]),
      alertsSent,
      channels: input.channels,
    },
    rules,
    pause,
    events: [...input.events],
    logs: input.logs,
  };
}
