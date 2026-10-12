import type { AccountPlan } from "../account/plan";
import type { UsageEvent } from "../notifications/usage-events.server";
import type { PauseCause } from "./attention-cause";
import { usd } from "./attention-format";
import {
  accountOverage,
  budgetReached,
  burnPerHour,
  capStatus,
  dayStart,
  freeDailyLimit,
  HOUR_MS,
  type LoopCheck,
  loopCheck,
  monthBill,
  nextLoopStreak,
  nextToPauseForBudget,
  normalHour,
  type ObjectAlarms,
  type Period,
  PRODUCT_KEYS,
  PRODUCTS,
  type ProductKey,
  periodStart,
  project,
  spendInPeriod,
  type UnusualSetting,
  type Usage,
  unusualUsage,
  usageAlertStatus,
} from "./math";
import { addSeries, sumBetween } from "./math/series";
import type { ActivityFacts } from "./store/activity";
import type { AlertRule } from "./store/alert-rules.server";
import type { EffectiveSpendSettings } from "./store/spend-settings";
import type { UsageState } from "./store/usage-state.server";

/**
 * What one check of the spend watcher decides, from each app's usage, its
 * settings and what the watcher remembered from the check before. Pure: the
 * caller stores the new states, records the activity, sends the events,
 * records alert firings (each sends its activity and event only the first
 * time in its period) and starts the pauses.
 *
 * - Unusual usage: an episode opens when an hour reaches the app's N× normal
 *   (and costs real money, or a real share of a free daily limit), with an
 *   `unusual_started` entry and a `usage_unusual` event; it ends, with
 *   `unusual_ended`, once no product is even half that far above normal, so
 *   an app hovering at the threshold does not open episode after episode.
 * - Usage alert rules: each that holds fires once per period.
 * - Free plan: a free daily limit the account is on pace to use up today is
 *   told once per UTC day, about the app using most of it; when it actually
 *   runs out, a second `limit_near` entry says so (no second message).
 * - Loop check: two checks in a row (the streak lives in the app's state).
 * - Spending cap: Workers Paid only, unless set aside until its period resets.
 * - Monthly budget (Workers Paid): the projected bill at or past the budget
 *   is recorded once a month, and pauses the app with the largest projected
 *   share of the overage that is neither exempt nor paused, one per check,
 *   whatever the app's own auto-pause says.
 *
 * Auto-pause by a trigger needs the app's effective "Pause automatically";
 * paused apps are never paused again, and their loop streak starts over. An
 * app whose pause failed within the hour is not paused again before then.
 */

/** One app as the check sees it. */
export interface WatchedAppInput {
  installId: string;
  /** Epoch ms: projections and spend leave out the time before it. */
  installedAt: number;
  usage: Usage;
  settings: EffectiveSpendSettings;
  state: UsageState;
  /** It has an open pause. */
  paused: boolean;
  /**
   * A pause of it failed within the last hour ({@link PAUSE_RETRY_MS}): no
   * trigger pauses it before then, so a pause that keeps failing is tried
   * (and told) at most once an hour, not on every check.
   */
  pauseFailedRecently?: boolean;
  /**
   * Some of its usage could not be read this check: what is missing is
   * not taken as a drop, so an unusual-usage episode stays open and the
   * loop check's streak is kept rather than started over.
   */
  incomplete?: boolean;
  /** Alarms of each namespace's busiest object over the last 60 minutes. */
  objectAlarms: readonly ObjectAlarms[];
  rules: readonly AlertRule[];
}

/** How long a failed pause holds off the next automatic pause of the app. */
export const PAUSE_RETRY_MS = 60 * 60_000;

export interface EvaluateInput {
  now: number;
  plan: AccountPlan;
  apps: readonly WatchedAppInput[];
  /**
   * Usage of every install this month, uninstalled ones included (they
   * used the account's allowance too), by install id: the bill and the
   * free daily limits are the account's.
   */
  accountUsage: ReadonlyMap<string, Usage>;
  /** The account's monthly budget in dollars including the $5 plan; null when off. */
  budget: number | null;
  /** A `budget_reached` entry was recorded this month already. */
  budgetToldThisMonth: boolean;
  /** Today's newest `limit_near` share by install (1 or more once used up). */
  limitSharesToday: ReadonlyMap<string, number>;
  /**
   * The free daily limit warnings, when worked out already for the whole
   * account ({@link freeLimitWarnings}): a check that judges its apps in
   * parts passes each part the account's. Worked out here otherwise.
   */
  limitWarnings?: ReadonlyMap<string, LimitWarning>;
}

export type ActivityDraft = {
  [K in "unusual_started" | "unusual_ended" | "alert_sent" | "limit_near" | "budget_reached"]: {
    installId: string | null;
    kind: K;
    facts: ActivityFacts[K];
  };
}["unusual_started" | "unusual_ended" | "alert_sent" | "limit_near" | "budget_reached"];

/** A rule that holds now: recorded, told and announced only on its period's first firing. */
export interface FiringDraft {
  ruleId: string;
  /** Unix second its period began. */
  periodStart: number;
  value: number;
  activity: Extract<ActivityDraft, { kind: "alert_sent" }>;
  event: Extract<UsageEvent, { type: "usage_alert" }>;
}

export type PauseDraft = {
  installId: string;
} & (
  | { reason: "loop"; detail: Omit<Extract<PauseCause, { reason: "loop" }>, "reason"> }
  | { reason: "cap"; detail: Omit<Extract<PauseCause, { reason: "cap" }>, "reason"> }
  | { reason: "budget"; detail: Omit<Extract<PauseCause, { reason: "budget" }>, "reason"> }
);

export interface Decisions {
  /** Every app's new state. */
  states: Array<Omit<UsageState, "lastCheckedAt">>;
  activities: ActivityDraft[];
  events: UsageEvent[];
  firings: FiringDraft[];
  /** Pauses by a trigger of the app's own (loop or cap), one per app. */
  pauses: PauseDraft[];
  /**
   * The budget's pause this check: the app with the largest projected share
   * of the overage. When it cannot be paused now (another job of it runs),
   * the next check decides again rather than pausing another app.
   */
  budgetPause: PauseDraft | null;
}

const PERIOD_END = { day: "the day", week: "the week", month: "the month" } as const;
const PERIOD_NOW = { day: "today", week: "this week", month: "this month" } as const;

/**
 * A usage alert rule as a sentence, as the app's settings show it: "When it
 * has spent $6.00 this month", "When it is on pace to use 80% of included
 * usage by the end of the month". Free plan rules are a share of a free
 * daily limit.
 */
export function alertRuleSentence(
  rule: { kind: "spent" | "pace"; unit: "usd" | "pct"; amount: number; period: Period },
  plan: AccountPlan,
): string {
  const verb =
    rule.kind === "spent"
      ? rule.unit === "usd"
        ? "has spent"
        : "has used"
      : rule.unit === "usd"
        ? "is on pace to spend"
        : "is on pace to use";
  const amount =
    rule.unit === "usd"
      ? usd(rule.amount)
      : `${rule.amount}% of ${plan === "free" ? "a free daily limit" : "included usage"}`;
  const when =
    rule.kind === "pace" ? `by the end of ${PERIOD_END[rule.period]}` : PERIOD_NOW[rule.period];
  return `When it ${verb} ${amount} ${when}`;
}

/** The unusual-usage setting the math takes, from the app's effective factor. */
function unusualSetting(factor: number | null): UnusualSetting {
  return factor === 5 || factor === 20 || factor === 100 ? factor : "off";
}

/**
 * Whether some product is still at least half the factor above its normal:
 * an open episode stays open until it is not.
 */
function stillUnusual(usage: Usage, now: number, factor: number): boolean {
  for (const key of PRODUCT_KEYS) {
    const series = usage[key];
    if (series === undefined || PRODUCTS[key].measure !== "count") continue;
    const normal = normalHour(series, now);
    if (normal === null || normal <= 0) continue;
    if (sumBetween(series, now - HOUR_MS, now, now) >= (normal * factor) / 2) return true;
  }
  return false;
}

/** The free daily limits the account is on pace to use up today, most used first. */
interface LimitRunningOut {
  product: ProductKey;
  limit: number;
  /** Used today by the account. */
  used: number;
  share: number;
  projectedShare: number;
  /** Epoch ms it runs out at this pace; null once it has. */
  runsOutAt: number | null;
  /** Used today, by install. */
  byInstall: Map<string, number>;
}

function limitsRunningOut(
  accountUsage: ReadonlyMap<string, Usage>,
  now: number,
): LimitRunningOut[] {
  const day = dayStart(now);
  const out: LimitRunningOut[] = [];
  for (const product of PRODUCT_KEYS) {
    const limit = freeDailyLimit(product);
    // R2 bills past its free amount rather than refusing, and its free amount is monthly.
    if (limit === null || PRODUCTS[product].billedOnFree) continue;
    const byInstall = new Map<string, number>();
    const all = [];
    for (const [installId, usage] of accountUsage) {
      const series = usage[product];
      if (series === undefined) continue;
      all.push(series);
      byInstall.set(installId, sumBetween(series, day, now, now));
    }
    if (all.length === 0) continue;
    const p = project(addSeries(all), "day", now);
    if (p.projected < limit) continue;
    const runsOutAt =
      p.used >= limit || p.pace <= 0
        ? null
        : Math.round(now + ((limit - p.used) / p.pace) * HOUR_MS);
    out.push({
      product,
      limit,
      used: p.used,
      share: p.used / limit,
      projectedShare: p.projected / limit,
      runsOutAt,
      byInstall,
    });
  }
  return out.sort((a, b) => b.projectedShare - a.projectedShare);
}

/** A free daily limit about to run out today, as told about one app. */
export interface LimitWarning {
  product: ProductKey;
  /** Used today by the account. */
  used: number;
  /** `used` over the limit (1 or more once it ran out). */
  share: number;
  /** Epoch ms it runs out at this pace; null once it has. */
  runsOutAt: number | null;
  /** The app's share of the account's use of it today. */
  appShare: number;
}

/**
 * Free plan: the free daily limits the account is on pace to use up today,
 * each told about the active app using most of it (one limit per app, the
 * one closest to running out). Account-wide: it needs every install's usage,
 * and only today's and the last day's hours of it.
 */
export function freeLimitWarnings(
  accountUsage: ReadonlyMap<string, Usage>,
  activeIds: Iterable<string>,
  now: number,
): Map<string, LimitWarning> {
  const active = new Set(activeIds);
  const warnings = new Map<string, LimitWarning>();
  for (const limit of limitsRunningOut(accountUsage, now)) {
    let top: string | null = null;
    for (const [id, used] of limit.byInstall) {
      if (!active.has(id) || used <= 0) continue;
      if (top === null || used > (limit.byInstall.get(top) ?? 0)) top = id;
    }
    if (top === null || warnings.has(top)) continue;
    const appShare = limit.used > 0 ? (limit.byInstall.get(top) ?? 0) / limit.used : 0;
    warnings.set(top, {
      product: limit.product,
      used: limit.used,
      share: limit.share,
      runsOutAt: limit.runsOutAt,
      appShare: Math.min(1, appShare),
    });
  }
  return warnings;
}

function loopDetail(
  check: LoopCheck,
  level: EffectiveSpendSettings["triggers"]["loop"]["level"],
  plan: AccountPlan,
) {
  return {
    level,
    plan,
    burnPerHour: check.burn,
    times: check.ratio !== null && check.ratio > 0 ? check.ratio : null,
    alarms: check.alarmLoop === null ? null : Math.max(1, Math.round(check.alarmLoop.alarms)),
  };
}

export function evaluate(input: EvaluateInput): Decisions {
  const { now, plan } = input;
  const out: Decisions = {
    states: [],
    activities: [],
    events: [],
    firings: [],
    pauses: [],
    budgetPause: null,
  };
  const today = dayStart(now) / 1000;
  const stopped = new Set<string>();

  // Free daily limits about to run out: told about the app using most of each.
  const warnings =
    input.limitWarnings ??
    (plan === "free"
      ? freeLimitWarnings(
          input.accountUsage,
          input.apps.map((a) => a.installId),
          now,
        )
      : new Map<string, LimitWarning>());

  for (const app of input.apps) {
    const { installId, usage, settings, state } = app;
    // Projections start at the install, as the pages' numbers do (overview.server.ts).
    const since = app.installedAt > 0 && app.installedAt < now ? app.installedAt : undefined;
    const next: Omit<UsageState, "lastCheckedAt"> = {
      installId,
      loopChecks: state.loopChecks,
      unusualSince: state.unusualSince,
      limitWarnedDay: state.limitWarnedDay,
      lastBurn: state.lastBurn,
      normalBurn: state.normalBurn,
    };

    // Unusual usage.
    const setting = unusualSetting(settings.unusual.factor);
    const unusual = unusualUsage({ plan, setting, usage, now });
    if (unusual !== null && state.unusualSince === null && setting !== "off") {
      const burn = burnPerHour(usage, now);
      const spentToday = spendInPeriod(usage, "day", now, { since }).spent;
      const limit = freeDailyLimit(unusual.product);
      const freeShare =
        plan === "free" && limit !== null
          ? project(usage[unusual.product] ?? [], "day", now, { since }).projected / limit
          : null;
      next.unusualSince = now;
      out.activities.push({
        installId,
        kind: "unusual_started",
        facts: {
          factor: setting,
          times: unusual.ratio,
          product: unusual.product,
          perHour: unusual.lastHour,
          burnPerHour: burn,
          spentToday,
          ...(freeShare === null ? {} : { freeShare }),
        },
      });
      out.events.push({
        type: "usage_unusual",
        installId,
        plan,
        since: now,
        product: unusual.product,
        perHour: unusual.lastHour,
        times: unusual.ratio,
        factor: setting,
        burnPerHour: burn,
        spentToday,
        freeShare,
      });
    } else if (
      state.unusualSince !== null &&
      unusual === null &&
      !app.incomplete &&
      (setting === "off" || !stillUnusual(usage, now, setting))
    ) {
      next.unusualSince = null;
      out.activities.push({
        installId,
        kind: "unusual_ended",
        facts: { startedAt: state.unusualSince },
      });
    }

    // Usage alert rules.
    for (const rule of app.rules) {
      const status = usageAlertStatus({
        plan,
        rule: { kind: rule.kind, unit: rule.unit, amount: rule.amount, period: rule.period },
        usage,
        now,
        since,
      });
      if (!status.fired) continue;
      const start = periodStart(rule.period, now) / 1000;
      if (rule.lastFiring?.periodStart === start) continue;
      const sentence = alertRuleSentence(rule, plan);
      out.firings.push({
        ruleId: rule.id,
        periodStart: start,
        value: status.value,
        activity: {
          installId,
          kind: "alert_sent",
          facts: {
            ruleId: rule.id,
            sentence,
            periodStart: start,
            value: status.value,
            amount: rule.amount,
          },
        },
        event: {
          type: "usage_alert",
          installId,
          plan,
          ruleId: rule.id,
          sentence,
          kind: rule.kind,
          unit: rule.unit,
          amount: rule.amount,
          value: status.value,
          period: rule.period,
          periodStart: start,
        },
      });
    }

    // A free daily limit about to run out (or run out) today.
    const warning = warnings.get(installId);
    if (warning !== undefined) {
      const facts = {
        product: warning.product,
        share: warning.share,
        runsOutAt: warning.runsOutAt,
        appShare: warning.appShare,
      };
      if (state.limitWarnedDay !== today) {
        next.limitWarnedDay = today;
        out.activities.push({ installId, kind: "limit_near", facts });
        out.events.push({
          type: "usage_limit_near",
          installId,
          product: warning.product,
          used: warning.used,
          runsOutAt: warning.runsOutAt,
          appShare: facts.appShare,
        });
      } else if (warning.share >= 1 && (input.limitSharesToday.get(installId) ?? 0) < 1) {
        // Used up now: Home turns the row into "used up"; the day's message went already.
        out.activities.push({ installId, kind: "limit_near", facts });
      }
    }

    // Loop check, every check, so the streak and the burn are always current.
    const level = settings.triggers.loop.level;
    const check = loopCheck({ plan, level, usage, now, objectAlarms: app.objectAlarms, since });
    const streak =
      app.incomplete && !check.trips && !app.paused
        ? { streak: state.loopChecks, pause: false }
        : nextLoopStreak(state.loopChecks, check.trips && !app.paused);
    next.loopChecks = streak.streak;
    next.lastBurn = check.burn;
    next.normalBurn = check.normal;

    if (app.paused) stopped.add(installId);
    else if (app.pauseFailedRecently) {
      // Its last pause failed: the next try waits out the hour.
    } else if (settings.autoPause.on && settings.triggers.loop.on && streak.pause) {
      out.pauses.push({ installId, reason: "loop", detail: loopDetail(check, level, plan) });
      stopped.add(installId);
    } else if (settings.autoPause.on && plan === "paid") {
      const cap = settings.triggers.cap;
      const setAside = settings.capSetAsideUntil !== null && settings.capSetAsideUntil > now;
      if (cap.on && cap.amount !== null && cap.amount > 0 && !setAside) {
        const status = capStatus({ usage, cap: cap.amount, period: cap.period, now, since });
        if (status.passed) {
          out.pauses.push({
            installId,
            reason: "cap",
            detail: { amount: cap.amount, period: cap.period, spent: status.spent },
          });
          stopped.add(installId);
        }
      }
    }
    out.states.push(next);
  }

  // The monthly budget (Workers Paid only).
  if (plan === "paid" && input.budget !== null && input.budget > 0) {
    const apps = Object.fromEntries(input.accountUsage);
    const overage = accountOverage(apps, plan, now, { projected: true, stopped });
    const projected = monthBill(plan, overage.usd);
    if (budgetReached(projected, input.budget)) {
      const monthStart = periodStart("month", now) / 1000;
      if (!input.budgetToldThisMonth) {
        out.activities.push({
          installId: null,
          kind: "budget_reached",
          facts: { monthStart, budget: input.budget, projected },
        });
        out.events.push({ type: "budget_reached", budget: input.budget, projected, monthStart });
      }
      const candidates = input.apps.map((a) => ({
        id: a.installId,
        overageUsd: overage.byApp[a.installId]?.usd ?? 0,
        exempt: a.settings.budgetExempt,
        // An app whose pause failed within the hour cannot be paused now:
        // the budget goes on to the next, whose pause lowers the bill too.
        paused: stopped.has(a.installId) || a.pauseFailedRecently === true,
      }));
      const pick = nextToPauseForBudget(candidates);
      if (pick !== null) {
        out.budgetPause = {
          installId: pick,
          reason: "budget",
          detail: { budget: input.budget, projected },
        };
      }
    }
  }
  return out;
}
