import type { AccountPlan } from "../account/plan";
import type { LoopLevel, Period } from "./math";

/**
 * Where the account's apps stand against spend protection right now, as
 * Settings → Your account, an app's Usage tab and Home show it. Read on the
 * server (`overview.server.ts`); the selectors here are pure and client-safe,
 * so a page can show the effect of a setting while an admin changes it
 * (another loop level, another cap) without asking the server again.
 *
 * Money is usage times Cloudflare's list price: an estimate, labelled so.
 */

/** One loop level's check of one app right now (see `loopCheck` in the math). */
export interface LoopNowAtLevel {
  /** Real money: over the level's dollars an hour, or on Free its share of a free daily limit. */
  money: boolean;
  /** Far above the app's normal at the level's factor (or an alarm loop). */
  abnormal: boolean;
  /** This check trips; the watcher pauses after two in a row. */
  trips: boolean;
}

/** An app's list-price spend on activity in one period (storage left out). */
export interface PeriodSpendNow {
  spent: number;
  /** Where the current pace takes it by the period's end. */
  projected: number;
  /** Epoch ms the period ends. */
  resetsAt: number;
}

export interface SpendApp {
  installId: string;
  /** The app's label, told apart from the account's other apps. */
  label: string;
  paused: boolean;
  /** Auto-pause is on for the app, after the account's default. */
  autoPause: boolean;
  /** Pauses on the account's triggers (it did not set its own). */
  followsAccountTriggers: boolean;
  /** Never paused for the monthly budget. */
  budgetExempt: boolean;
  /**
   * Epoch ms: the cap does not pause the app before then ("Resume until the
   * cap resets"); null when it is not set aside.
   */
  capSetAsideUntil: number | null;
  /** Dollars of activity over the last 60 minutes. */
  burnPerHour: number;
  /** `burnPerHour` over its normal hour; null with no normal yet. */
  ratio: number | null;
  loop: Record<LoopLevel, LoopNowAtLevel>;
  spend: Record<Period, PeriodSpendNow>;
  /** The app's projected part of this month's usage past included. */
  overageUsd: number;
}

export interface SpendOverview {
  plan: AccountPlan;
  /** Epoch ms the page read them. */
  now: number;
  /** Epoch ms the usage numbers were computed (the watcher refreshes them every few minutes). */
  computedAt: number;
  /**
   * The Cloudflare permissions usage is read with that the connection
   * lacks; empty when it has them (or connects with an API token, whose
   * permissions show when a read fails). Non-empty means the numbers here are
   * empty until Cloudflare is reconnected.
   */
  missingScopes: string[];
  /**
   * This month's bill so far and projected: on Paid the $5 plan plus usage
   * past included, on Free what bills past its free amount (R2). Counts apps
   * removed this month too.
   */
  bill: { now: number; projected: number };
  /**
   * The app the monthly budget would pause first: the largest projected part
   * of the overage, neither exempt nor paused. Null when no pause would lower
   * the bill.
   */
  budgetPick: string | null;
  /** Every app in the account, in label order. */
  apps: SpendApp[];
}

/** The apps on the account's triggers. */
export function followingApps(apps: readonly SpendApp[]): SpendApp[] {
  return apps.filter((a) => a.followsAccountTriggers);
}

/** The apps that set their own triggers. */
export function ownTriggerApps(apps: readonly SpendApp[]): SpendApp[] {
  return apps.filter((a) => !a.followsAccountTriggers);
}

/** The apps the monthly budget never pauses. */
export function budgetExemptApps(apps: readonly SpendApp[]): SpendApp[] {
  return apps.filter((a) => a.budgetExempt);
}

/** The apps whose loop check trips right now at `level` (paused apps are not running). */
export function loopingNow(apps: readonly SpendApp[], level: LoopLevel): SpendApp[] {
  return apps.filter((a) => !a.paused && a.loop[level].trips);
}

export interface CapWatchRow {
  app: SpendApp;
  spent: number;
  projected: number;
  /** Spent the cap already. */
  over: boolean;
  /** Epoch ms the cap is set aside until for this app ("Resume until the cap resets"), or null. */
  setAsideUntil: number | null;
}

/**
 * The apps over a cap of `amount` per `period`, or getting there: spent half
 * of it, or on pace to pass it by the reset. Most spent first. An app whose
 * cap is set aside at `now` says until when, since the cap cannot pause it.
 */
export function capWatch(
  apps: readonly SpendApp[],
  amount: number,
  period: Period,
  now: number,
): CapWatchRow[] {
  if (!(amount > 0)) return [];
  return apps
    .filter(
      (app) => app.spend[period].spent >= amount * 0.5 || app.spend[period].projected >= amount,
    )
    .map((app) => ({
      app,
      spent: app.spend[period].spent,
      projected: app.spend[period].projected,
      over: app.spend[period].spent >= amount,
      setAsideUntil:
        app.capSetAsideUntil !== null && app.capSetAsideUntil > now ? app.capSetAsideUntil : null,
    }))
    .sort((a, b) => b.spent - a.spent);
}
