import { z } from "zod";
import type { AccountPlan } from "../account/plan";
import type { AutoPauseChoice } from "../db/usage-schema";
import type { StillPastCap } from "./attention";
import type { PauseCause } from "./attention-cause";
import type { LoopLevel, Period, ProductKey, UsageAlertState } from "./math";
import type { AppObservability } from "./observability.server";
import type { LoopNowAtLevel, PeriodSpendNow } from "./overview";
import type { EffectiveSpendSettings, SpendDefaults, UnusualFactor } from "./store/spend-settings";

/**
 * An installed app's Usage tab: what it used of each product and how that
 * compares with its normal, where it stands against its alerts and its
 * auto-pause triggers, and what happened lately. Read by `readUsageTab`
 * (tab.server.ts) for one app; the types here are client-safe.
 *
 * Money is usage times Cloudflare's list price: an estimate, labelled so.
 */

export const usageTabInput = z.strictObject({ installId: z.string().min(1).max(64) });

/** The chart's ranges: hours for 24 hours and 7 days, days for 30 days. */
export const USAGE_RANGES = ["24h", "7d", "30d"] as const;
export type UsageRange = (typeof USAGE_RANGES)[number];

/** Cloudflare's analytics show a new app's usage about this long after it is installed. */
export const FRESH_MS = 15 * 60_000;

/** An hour this many times its normal or more makes a product stand out ("4× normal"). */
export const HOT_RATIO = 3;

/** One point of a chart: the start of its hour or day (epoch ms), and its value. */
export type Point = [number, number];

export interface ProductUsage {
  key: ProductKey;
  /** A level (storage) held each hour, not a count used. */
  level: boolean;
  /**
   * The last 7 days hour by hour (168 points). The last is the hour still
   * filling up, for a count at its pace an hour so far.
   */
  hours: Point[];
  /**
   * The last 30 days, one point a day: for a count the day's average an
   * hour (so the normal hour stays comparable), for a level the day's last.
   */
  days: Point[];
  /** Used over the last 60 minutes; for a level, the latest level. */
  lastHour: number;
  /** The app's normal hour of it (a count); null with no normal yet. */
  normal: number | null;
  /** `lastHour` over `normal` when it has one. */
  ratio: number | null;
  /** Far above its normal (`HOT_RATIO`): the table marks it. */
  hot: boolean;
  /** Used today (UTC); for a level, the latest level. */
  today: number;
  /** Used this month; null for a level. */
  month: number | null;
  /** Where this month ends at the current pace; null for a level. */
  projectedMonth: number | null;
  /**
   * The account's use (every app) against what the plan allows: of the
   * included amount this month on Paid, of the free limit on Free (today's
   * for a daily limit). Null when the plan sets none.
   */
  allowance: { share: number; daily: boolean } | null;
  /** Paid: this app's part of the account's projected cost past included this month. */
  overageUsd: number | null;
}

/** Why an app was paused and who did it, for its banner and Resume. */
export interface PauseView {
  pausedAt: number;
  /** Who paused it, by name; null when Appflare did. */
  by: string | null;
  cause: PauseCause | null;
  /** When unusual usage began before the pause, if it did. */
  loopSince: number | null;
  /** Set when Resume must offer to set the cap aside. */
  stillPastCap: StillPastCap | null;
}

/** How the app is doing, in one sentence under "Usage by product" and in the banner above it. */
export type UsageStatus =
  /** Cloudflare must be reconnected (or the API token given more permissions) before usage can be read. */
  | { kind: "reconnect"; via: "oauth" | "token" }
  /** Installed minutes ago: Cloudflare reports nothing yet. */
  | { kind: "fresh"; installedAt: number }
  /** Nothing recorded yet. */
  | { kind: "empty" }
  | { kind: "paused"; pause: PauseView; product: ProductKey | null }
  /** Free: a free daily limit is used up today. */
  | {
      kind: "limit";
      product: ProductKey;
      /** The account's free amount a day. */
      limit: number;
      loopSince: number | null;
      appShare: number | null;
    }
  /** Far above normal: an unusual-usage episode, or the loop check trips. */
  | {
      kind: "runaway";
      product: ProductKey;
      perHour: number;
      ratio: number | null;
      since: number | null;
      burnPerHour: number;
      spentToday: number;
      /** Free: the share of a free daily limit it is on pace to use today. */
      freeShare: number | null;
      /** What changed right before it began: an update's version, or a settings change. */
      after: { kind: "update"; version: string | null } | { kind: "settings" } | null;
    }
  /** Well above its normal, but not costing enough to be a loop. */
  | { kind: "busy"; product: ProductKey; perHour: number; ratio: number }
  /** Its share of the account's Worker requests today, when it has any. */
  | { kind: "normal"; requestsShare: number | null };

/** One usage alert of the app with where it stands now. */
export interface AlertRuleView {
  id: string;
  kind: "spent" | "pace";
  unit: "usd" | "pct";
  amount: number;
  period: Period;
  /** Dollars or percent so far this period, and where the pace takes it. */
  spent: number;
  projected: number;
  state: UsageAlertState;
}

/** Something that happened to the app, for Recent activity and the chart's markers. */
export type UsageEvent = { id: string; at: number } & (
  | { kind: "installed"; from: "catalog" | "repository" | "source" }
  | { kind: "updated"; version: string | null; automatic: boolean }
  | { kind: "rolled_back"; version: string | null }
  | {
      kind: "app_settings";
      automatic: boolean;
      /** What changed, as the job recorded it: "Check interval set to 10", "API key changed". */
      changes: string[];
    }
  | { kind: "unusual_started"; product: string | null; times: number | null }
  | { kind: "unusual_ended"; startedAt: number }
  | { kind: "alert_sent"; sentence: string }
  | { kind: "limit_near"; product: string; share: number; runsOutAt: number | null }
  | { kind: "paused"; by: string | null; cause: PauseCause | null }
  | { kind: "resumed"; by: string | null }
  | { kind: "pause_failed"; error: string }
  | { kind: "resume_failed"; error: string }
  | {
      kind: "settings_changed";
      by: string | null;
      changed: string[];
      /** A usage alert added, changed or removed, with its sentence. */
      alert: { change: "added" | "changed" | "removed"; sentence: string } | null;
    }
  | { kind: "cap_set_aside"; by: string | null; until: number }
  | { kind: "observability_changed"; by: string | null; enabled: boolean }
);

/** The app's own spend protection choices (what its controls show). */
export interface OwnSpendSettings {
  /** Null follows the account; 0 is off. */
  unusualFactor: UnusualFactor | null;
  autoPause: AutoPauseChoice;
  customTriggers: boolean;
  loopOn: boolean;
  loopLevel: LoopLevel | null;
  capOn: boolean;
  capAmount: number | null;
  capPeriod: Period;
  budgetExempt: boolean;
}

export interface UsageTabData {
  installId: string;
  plan: AccountPlan;
  /** Epoch ms the page read it. */
  now: number;
  /** Epoch ms the app's usage was last brought up to date. */
  updatedAt: number;
  installedAt: number;
  /** Cloudflare permissions usage is read with that the connection lacks. */
  missingScopes: string[];
  status: UsageStatus;
  /** The product the chart opens on. */
  headline: ProductKey | null;
  /** Every product the app used in the last 30 days, in the products' order. */
  products: ProductUsage[];
  /**
   * The app's spend on activity this month, hour by hour (days before the
   * last 8 as one point each), to tell when it passed a cap.
   */
  costHours: Point[];
  spend: {
    defaults: SpendDefaults;
    own: OwnSpendSettings;
    effective: EffectiveSpendSettings;
    /** The app's numbers from the spend watcher's snapshot. */
    burnPerHour: number;
    ratio: number | null;
    loop: Record<LoopLevel, LoopNowAtLevel>;
    periods: Record<Period, PeriodSpendNow>;
    /** Usage alerts sent this app in their current periods. */
    alertsSent: number;
    /** The notification channels its alerts go to; null when the viewer may not see them. */
    channels: string[] | null;
  };
  rules: AlertRuleView[];
  pause: PauseView | null;
  /** Newest first. */
  events: UsageEvent[];
  /** Workers Logs, read from Cloudflare only for a brand-new app; null otherwise. */
  logs: AppObservability | null;
}

/** When `costHours` reached `cap` this period, to the hour; null when it did not. */
export function capPassedAt(
  costHours: readonly Point[],
  cap: number,
  periodStartMs: number,
): number | null {
  if (!(cap > 0)) return null;
  let total = 0;
  for (const [at, usd] of costHours) {
    if (at < periodStartMs) continue;
    total += usd;
    if (total >= cap) return at;
  }
  return null;
}
