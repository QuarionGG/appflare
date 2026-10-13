import type { AccountPlan } from "../account/plan";
import type { UsageAttention } from "./attention";
import {
  count,
  OTHER_USAGE,
  otherShareShown,
  percent,
  productLabel,
  usd,
  withUnit,
} from "./attention-format";
import {
  billedPrice,
  DAY_MS,
  dayStart,
  HOUR_MS,
  PAID_PLAN_MONTHLY_USD,
  PRODUCT_KEYS,
  PRODUCTS,
  type ProductKey,
} from "./math";
import { clock, dateTime } from "./ui/format";

/**
 * Home's "Usage" section and the usage on each app card, shaped from what
 * `readHomeUsage` returns: the account's totals (from the stored spend
 * overview and the account's use of each product), a 7-day chart by app per
 * product, and per app a small chart of its most telling product with one
 * line about it. Pure and client-safe, so a product tab changes the chart
 * without asking the server again.
 *
 * The last 7 days are 6 whole UTC days and today. The days come hour by
 * hour from the spend watcher's history; when it has none yet, as daily
 * totals. Every point is a rate per hour, so a day drawn as its total over
 * 24 shares the axis with the hours.
 */

/** Whole UTC days before today on the charts; with today, 7 days. */
export const CHART_PAST_DAYS = 6;

/**
 * How long after install an app has no usage yet: Cloudflare's analytics
 * name a new Worker only 40 to 50 minutes after its first request (until
 * then its use is reported under no name), so about an hour.
 */
export const FRESH_MS = 60 * 60_000;

/**
 * The current hour is drawn only once this much of it has passed, as a rate
 * (its value so far scaled to a whole hour); earlier, the few minutes it
 * covers would read as a sudden drop or jump.
 */
export const PARTIAL_HOUR_MIN_MS = 10 * 60_000;

/** Kumo's categorical chart palette has 6 colours; past 6 apps the smallest share one, as "Other apps". */
export const PALETTE_SIZE = 6;

/**
 * An app's hour this many times its normal reads as "busier than usual" on
 * its card, and a product this far above its own normal is the one its card
 * shows.
 */
export const BUSY_RATIO = 3;

/** At most this many product tabs, the ones closest to their allowance. */
export const MAX_PRODUCT_TABS = 6;

/** The app's numbers, from the stored spend overview. */
export interface HomeUsageApp {
  installId: string;
  /** Epoch ms. */
  installedAt: number;
  paused: boolean;
  /** Dollars of activity over the last 60 minutes, at list price. */
  burnPerHour: number;
  /** `burnPerHour` over its normal hour; null with no normal yet. */
  ratio: number | null;
}

/** One product of one app over the chart's 7 days. */
export interface HomeUsageSeries {
  installId: string;
  product: ProductKey;
  /**
   * The 6 days before today, from `HomeUsageData.windowStart`: one value an
   * hour (`grain` "hour", 144 of them) or one total a day ("day", 6).
   */
  past: number[];
  /** Totals per hour of today (UTC), from 00:00; the last is the hour still running. */
  hours: number[];
  /** The last 60 minutes over the product's own normal hour; null without the hourly history or a normal. */
  ratio: number | null;
}

/** The account's use of a product, every install counted, removed ones too (limits are the account's). */
export interface AccountUse {
  today: number;
  month: number;
  /**
   * Workers Free: of `today`, what is not from Appflare's apps (Workers and
   * resources it did not install, and the manager itself), when the watcher
   * read the account's total. Not counted in `month`, which stays Appflare's
   * apps' own (earlier days' outside usage is not known).
   */
  other?: number;
}

/** What the server returns for Home's usage (`getHomeUsage`). */
export interface HomeUsageData {
  plan: AccountPlan;
  /** Epoch ms the server read them. */
  now: number;
  /**
   * Set when usage cannot be read until Cloudflare's permissions change: the
   * sign-in to redo (`oauth`) or the API token to give them (`token`). Null
   * while usage can be read.
   */
  needsAccess: { via: "oauth" | "token" } | null;
  /**
   * This month's Appflare usage so far and projected (Paid: $5 plus its
   * apps' usage past included; Free: R2 past its free amount). Other
   * Workers and resources in the account are not counted.
   */
  bill: { now: number; projected: number };
  apps: HomeUsageApp[];
  /** Epoch ms: the start of the first of the 6 days before today. */
  windowStart: number;
  /** How the series' `past` holds those days. */
  grain: "hour" | "day";
  /** The listed apps' counted products (storage is not charted). */
  series: HomeUsageSeries[];
  /** Counted products only. */
  account: Partial<Record<ProductKey, AccountUse>>;
}

/** An app as Home lists it, in the order of its cards. */
export interface HomeUsageAppName {
  id: string;
  label: string;
}

/** A colour, by meaning: an app's own palette slot, red for running away, grey for paused. */
export type UsageTone = { kind: "slot"; index: number } | { kind: "alert" } | { kind: "muted" };

/** A point: epoch ms and the use per hour then; `day` points are a whole day's average. */
export interface UsagePoint {
  t: number;
  perHour: number;
  day: boolean;
}

export interface UsageTile {
  label: string;
  value: string;
  note: string;
  bad: boolean;
}

export interface ChartSeries {
  /** The install, or null for "Other apps". */
  installId: string | null;
  name: string;
  tone: UsageTone;
  points: UsagePoint[];
}

export interface ProductChart {
  product: ProductKey;
  series: ChartSeries[];
  /** "Last 7 days · 12% of today's free limit" (the share part when the product has an allowance). */
  caption: string;
  /**
   * Workers Free: today's use of the product's daily limit that is not from
   * Appflare's apps, which the chart does not show (Appflare keeps no
   * history of it); null when there is none to speak of.
   */
  other: string | null;
}

export type CardState = "fresh" | "paused" | "capped" | "runaway" | "busy" | "normal";

export interface CardUsage {
  state: CardState;
  product: ProductKey;
  tone: UsageTone;
  /** Empty for a fresh app. */
  points: UsagePoint[];
  line: string;
  /** Pause (running away or a used-up limit) or Resume (paused) leads the card's buttons, for admins. */
  action: "pause" | "resume" | null;
}

export interface HomeUsageView {
  tiles: UsageTile[];
  /** The product tabs, in the products' usual order. */
  products: ProductKey[];
  /** The tab selected at first: the product an app is in trouble with, else Worker requests. */
  initialProduct: ProductKey | null;
  chart(product: ProductKey): ProductChart;
  cards: ReadonlyMap<string, CardUsage>;
}

const isCount = (key: ProductKey) => PRODUCTS[key].measure === "count";

function isProductKey(key: string | null): key is ProductKey {
  return key !== null && Object.hasOwn(PRODUCTS, key) && isCount(key as ProductKey);
}

const sum = (values: readonly number[]) => values.reduce((t, v) => t + v, 0);

/** Today's hours drawn, and the running hour's share of an hour so far. */
interface Grid {
  todayStart: number;
  /** Today's hours drawn (the running one only after `PARTIAL_HOUR_MIN_MS`). */
  hoursDrawn: number;
  running: number;
  partial: number;
}

function gridOf(data: HomeUsageData): Grid {
  const todayStart = dayStart(data.now);
  const running = Math.floor((data.now - todayStart) / HOUR_MS);
  const into = data.now - (todayStart + running * HOUR_MS);
  return {
    todayStart,
    hoursDrawn: into >= PARTIAL_HOUR_MIN_MS ? running + 1 : running,
    running,
    partial: into / HOUR_MS,
  };
}

/** A series on the grid; a missing series is all zeros, so stacked series line up. */
function pointsOf(series: HomeUsageSeries | undefined, data: HomeUsageData, g: Grid): UsagePoint[] {
  const points: UsagePoint[] = [];
  if (data.grain === "hour") {
    for (let i = 0; i < CHART_PAST_DAYS * 24; i++) {
      points.push({ t: data.windowStart + i * HOUR_MS, perHour: series?.past[i] ?? 0, day: false });
    }
  } else {
    for (let i = 0; i < CHART_PAST_DAYS; i++) {
      points.push({
        t: data.windowStart + i * DAY_MS + 12 * HOUR_MS,
        perHour: (series?.past[i] ?? 0) / 24,
        day: true,
      });
    }
  }
  for (let h = 0; h < g.hoursDrawn; h++) {
    const value = series?.hours[h] ?? 0;
    points.push({
      t: g.todayStart + h * HOUR_MS,
      perHour: h === g.running ? value / Math.max(g.partial, 1e-9) : value,
      day: false,
    });
  }
  return points;
}

/** What an app used of a product today, and over the 7 days. */
function usedToday(series: HomeUsageSeries | undefined): number {
  return sum(series?.hours ?? []);
}

function usedInWindow(series: HomeUsageSeries | undefined): number {
  return sum(series?.past ?? []) + usedToday(series);
}

/** The allowance a product is measured against on this plan, per day or month; null when none. */
function allowanceOf(plan: AccountPlan, key: ProductKey) {
  return plan === "paid" ? PRODUCTS[key].included : PRODUCTS[key].free;
}

/** The account's share of its allowance of `key`, and how to say what it is a share of. */
function accountShare(
  plan: AccountPlan,
  key: ProductKey,
  account: HomeUsageData["account"],
): { share: number; of: string } | null {
  const allowance = allowanceOf(plan, key);
  if (allowance === null || allowance.amount <= 0) return null;
  const use = account[key] ?? { today: 0, month: 0 };
  if (allowance.per === "day") {
    return {
      share: use.today / allowance.amount,
      of: plan === "free" ? "today's free limit" : "today's included",
    };
  }
  return {
    share: use.month / allowance.amount,
    of: plan === "free" ? "this month's free amount" : "this month's included",
  };
}

/** A week's worth of a product's allowance, to rank products by how close they come. */
function weeklyAllowance(plan: AccountPlan, key: ProductKey): number | null {
  const allowance = allowanceOf(plan, key);
  if (allowance === null || allowance.amount <= 0) return null;
  return allowance.per === "day" ? allowance.amount * 7 : (allowance.amount * 7) / 30;
}

/** Product tab names, short enough for several to fit on a phone; the chart's caption and tooltips use the full name. */
const TAB_LABELS: Readonly<Record<string, string>> = {
  workers_requests: "Worker requests",
  workers_cpu_ms: "CPU time",
  do_requests: "Durable Objects",
  do_duration: "DO duration",
  do_rows_read: "DO rows read",
  do_rows_written: "DO rows written",
  d1_rows_read: "D1 rows read",
  d1_rows_written: "D1 rows written",
  r2_class_a: "R2 class A",
  r2_class_b: "R2 class B",
  queues_operations: "Queues",
  workflow_steps: "Workflow steps",
  ai_neurons: "Workers AI",
  vectorize_queried_dimensions: "Vectorize",
  analytics_engine_data_points: "Analytics Engine",
  browser_hours: "Browser Run",
  containers_memory: "Container memory",
  containers_cpu: "Container CPU",
  containers_disk: "Container disk",
  workers_logs_events: "Workers Logs",
};

/** A product's tab name: its short name, else its full one. */
export function productTabLabel(key: ProductKey): string {
  return TAB_LABELS[key] ?? PRODUCTS[key].label;
}

/** An amount of a product in an hour: "4.4M requests", "0.3 requests". */
export function productAmount(key: ProductKey, value: number): string {
  const n = value > 0 && value < 10 && !Number.isInteger(value) ? value.toFixed(1) : count(value);
  return withUnit(n, PRODUCTS[key].unit);
}

/**
 * The palette slot of each app, in card order: its position when there are
 * at most 6 apps. Past 6, the 5 apps that used the most this week (activity
 * at list price) keep their own colours, in card order, and the rest share
 * the sixth as "Other apps".
 */
export function appSlots(
  apps: readonly HomeUsageAppName[],
  weekCost: ReadonlyMap<string, number>,
): Map<string, number | "other"> {
  if (apps.length <= PALETTE_SIZE) return new Map(apps.map((a, i) => [a.id, i]));
  const kept = new Set(
    [...apps]
      .sort((a, b) => (weekCost.get(b.id) ?? 0) - (weekCost.get(a.id) ?? 0))
      .slice(0, PALETTE_SIZE - 1)
      .map((a) => a.id),
  );
  let next = 0;
  return new Map(apps.map((a) => [a.id, kept.has(a.id) ? next++ : "other"]));
}

const slotTone = (slot: number | "other" | undefined): UsageTone => ({
  kind: "slot",
  index: slot === undefined || slot === "other" ? PALETTE_SIZE - 1 : slot,
});

/** The rows of `attention` about one app, by kind. */
function attentionOf(attention: readonly UsageAttention[], installId: string) {
  const mine = attention.filter((a) => a.installId === installId);
  const find = <K extends UsageAttention["kind"]>(kind: K) =>
    mine.find((a): a is Extract<UsageAttention, { kind: K }> => a.kind === kind);
  return {
    unusual: find("unusual"),
    usedUp: find("limit-used-up"),
    near: find("limit-near"),
    paused: find("paused"),
  };
}

export function homeUsageView(input: {
  data: HomeUsageData;
  /** The apps in card order (by label), as Home names them. */
  apps: readonly HomeUsageAppName[];
  /** Spend protection's rows of "Needs attention". */
  attention: readonly UsageAttention[];
}): HomeUsageView {
  const { data, attention } = input;
  const g = gridOf(data);
  const numbers = new Map(data.apps.map((a) => [a.installId, a]));
  const apps = input.apps.filter((a) => numbers.has(a.id));
  const listed = new Set(apps.map((a) => a.id));
  const series = data.series.filter((s) => listed.has(s.installId) && isCount(s.product));
  const byApp = new Map<string, Map<ProductKey, HomeUsageSeries>>();
  for (const s of series) {
    const products = byApp.get(s.installId) ?? new Map<ProductKey, HomeUsageSeries>();
    products.set(s.product, s);
    byApp.set(s.installId, products);
  }
  const seriesOf = (id: string, key: ProductKey) => byApp.get(id)?.get(key);
  /** An app's list-price cost of `key` over the window. */
  const windowCost = (id: string, key: ProductKey) =>
    usedInWindow(seriesOf(id, key)) * billedPrice(key);
  const weekCost = new Map(
    apps.map((a) => [
      a.id,
      sum([...(byApp.get(a.id)?.keys() ?? [])].map((key) => windowCost(a.id, key))),
    ]),
  );
  const slots = appSlots(apps, weekCost);

  // ---------- The cards ----------

  /** The app's product that cost the most this week; null when it used nothing. */
  const costliest = (id: string): ProductKey | null => {
    let best: ProductKey | null = null;
    let bestCost = 0;
    for (const key of byApp.get(id)?.keys() ?? []) {
      const cost = windowCost(id, key);
      if (cost > bestCost) [best, bestCost] = [key, cost];
    }
    return best;
  };

  /** The app's product furthest above its own normal, when one is at least `BUSY_RATIO` times it. */
  const furthestAboveNormal = (id: string): ProductKey | null => {
    let best: ProductKey | null = null;
    let bestRatio = BUSY_RATIO;
    for (const [key, s] of byApp.get(id) ?? []) {
      if (s.ratio !== null && s.ratio >= bestRatio) [best, bestRatio] = [key, s.ratio];
    }
    return best;
  };

  const requestsToday = data.account.workers_requests?.today ?? 0;

  const cards = new Map<string, CardUsage>();
  for (const app of apps) {
    const n = numbers.get(app.id) as HomeUsageApp;
    const rows = attentionOf(attention, app.id);
    // Fresh only while nothing of it shows yet: a new app that loops shows red, with Pause.
    const used = [...(byApp.get(app.id)?.values() ?? [])].some((s) => usedInWindow(s) > 0);
    const state: CardState =
      n.paused || rows.paused !== undefined
        ? "paused"
        : rows.usedUp !== undefined
          ? "capped"
          : rows.unusual !== undefined
            ? "runaway"
            : data.now - n.installedAt < FRESH_MS && !used
              ? "fresh"
              : rows.near !== undefined || (n.ratio !== null && n.ratio >= BUSY_RATIO)
                ? "busy"
                : "normal";
    // The product the watcher's rows name is the story; a paused app's is
    // what it spent most on (its loop is over, so nothing is above normal).
    const named = [rows.usedUp?.product, rows.unusual?.product, rows.near?.product].find(
      (p): p is ProductKey => isProductKey(p ?? null),
    );
    const product: ProductKey =
      named ??
      (state === "paused" ? costliest(app.id) : null) ??
      furthestAboveNormal(app.id) ??
      (state === "runaway" ? costliest(app.id) : null) ??
      (seriesOf(app.id, "workers_requests") !== undefined ? "workers_requests" : null) ??
      costliest(app.id) ??
      "workers_requests";
    const label = PRODUCTS[product].label;
    const tone: UsageTone =
      state === "runaway" || state === "capped"
        ? { kind: "alert" }
        : state === "paused"
          ? { kind: "muted" }
          : slotTone(slots.get(app.id));
    const share =
      requestsToday > 0 ? usedToday(seriesOf(app.id, "workers_requests")) / requestsToday : null;
    const busy = state === "busy" ? " · busier than usual" : "";
    // With no normal yet it is not "far above" one: it uses a lot.
    const how =
      rows.unusual?.newApp === true
        ? rows.unusual.installedRecently === true
          ? `${label}: a lot for a new app`
          : `${label}: a lot, no usual usage yet`
        : `${label} far above normal`;
    const line =
      state === "fresh"
        ? "Just installed"
        : state === "paused"
          ? `${pausedWhen(rows.paused?.pausedAt, data.now)} · no usage since`
          : state === "runaway"
            ? data.plan === "paid" && n.burnPerHour > 0
              ? `${usd(n.burnPerHour)}/h · ${how}`
              : how
            : state === "capped"
              ? `${label}: today's free limit used up`
              : // No share line at 0%; a share under 1% reads "under 1%" (percent()).
                share === null || share <= 0
                ? `No requests today${busy}`
                : `${percent(share)} of today's requests${busy}`;
    cards.set(app.id, {
      state,
      product,
      tone,
      points: state === "fresh" ? [] : pointsOf(seriesOf(app.id, product), data, g),
      line,
      action:
        state === "paused" ? "resume" : state === "runaway" || state === "capped" ? "pause" : null,
    });
  }

  // ---------- The chart ----------

  const used = PRODUCT_KEYS.filter(
    (key) => isCount(key) && series.some((s) => s.product === key && usedInWindow(s) > 0),
  );
  // The product an app is in trouble with, in card order; else requests.
  const loud = apps
    .map((a) => cards.get(a.id))
    .find(
      (c) =>
        c !== undefined &&
        c.state !== "normal" &&
        c.state !== "fresh" &&
        c.product !== "workers_requests",
    )?.product;
  const initialProduct =
    (loud !== undefined && used.includes(loud) ? loud : undefined) ??
    (used.includes("workers_requests") ? "workers_requests" : used[0]) ??
    null;
  const closeness = (key: ProductKey) => {
    const week = weeklyAllowance(data.plan, key);
    const total = sum(series.filter((s) => s.product === key).map(usedInWindow));
    return week === null ? 0 : total / week;
  };
  const picked = new Set(
    [...used]
      .sort((a, b) => closeness(b) - closeness(a))
      .filter((key) => key !== initialProduct)
      .slice(0, MAX_PRODUCT_TABS - (initialProduct === null ? 0 : 1)),
  );
  if (initialProduct !== null) picked.add(initialProduct);
  const products = used.filter((key) => picked.has(key));

  const chart = (product: ProductKey): ProductChart => {
    const own: ChartSeries[] = [];
    const others: UsagePoint[][] = [];
    for (const app of apps) {
      const s = seriesOf(app.id, product);
      if (s === undefined) continue;
      const points = pointsOf(s, data, g);
      const slot = slots.get(app.id);
      if (slot === "other") others.push(points);
      else own.push({ installId: app.id, name: app.label, tone: slotTone(slot), points });
    }
    const [first, ...rest] = others;
    if (first !== undefined) {
      own.push({
        installId: null,
        name: "Other apps",
        tone: slotTone("other"),
        points: first.map((p, i) => ({
          ...p,
          perHour: p.perHour + sum(rest.map((o) => o[i]?.perHour ?? 0)),
        })),
      });
    }
    const share = accountShare(data.plan, product, data.account);
    return {
      product,
      series: own,
      caption: `Last 7 days${share === null ? "" : ` · ${percent(share.share)} of ${share.of}`}`,
      other: otherLine(data, product),
    };
  };

  // ---------- The totals ----------

  const runaway = apps.filter((a) => cards.get(a.id)?.state === "runaway");
  const tiles: UsageTile[] =
    data.plan === "paid"
      ? [
          {
            label: "Usage this month",
            value: usd(Math.max(0, data.bill.now - PAID_PLAN_MONTHLY_USD)),
            note: "Appflare's apps, past what the $5 plan includes (estimate)",
            bad: false,
          },
          {
            label: "Projected month",
            value: usd(data.bill.projected),
            note: "Appflare's apps and the $5 plan, if the last day's pace holds",
            bad: false,
          },
          burningNow(data, apps, runaway.length > 0),
        ]
      : [
          canBeBilled(data),
          closestDailyLimit(
            data.account,
            attention.flatMap((a) => (a.kind === "limit-used-up" ? [a.product] : [])),
          ),
          {
            label: "Apps needing a look",
            value: String(
              new Set(attention.map((a) => a.installId).filter((id) => listed.has(id))).size,
            ),
            note: "Loops, limits and pauses",
            bad: attention.some((a) => a.kind === "limit-used-up" && listed.has(a.installId)),
          },
        ];

  return { tiles, products, initialProduct, chart, cards };
}

/**
 * When a paused app was paused, in the reader's time: "Paused at 10:00 AM"
 * today, "Paused on Oct 12, 3:00 PM" on an earlier day, "Paused" when the
 * pause's time is not known.
 */
function pausedWhen(pausedAt: number | undefined, now: number): string {
  if (pausedAt === undefined) return "Paused";
  const sameDay = new Date(pausedAt).toDateString() === new Date(now).toDateString();
  return sameDay ? `Paused at ${clock(pausedAt)}` : `Paused on ${dateTime(pausedAt)}`;
}

/** Paid: what every app costs an hour now, and which app most of it is when one runs away. */
function burningNow(
  data: HomeUsageData,
  apps: readonly HomeUsageAppName[],
  runaway: boolean,
): UsageTile {
  // A paused app burns nothing, whatever its last hour's numbers say.
  const burn = new Map(data.apps.map((a) => [a.installId, a.paused ? 0 : a.burnPerHour]));
  const top = [...apps].sort((a, b) => (burn.get(b.id) ?? 0) - (burn.get(a.id) ?? 0))[0];
  return {
    label: "Burning now",
    value: `${usd(sum(apps.map((a) => burn.get(a.id) ?? 0)))}/h`,
    note:
      runaway && top !== undefined ? `Mostly ${top.label}` : "At list price, before included usage",
    bad: runaway,
  };
}

/** Free: nothing, unless R2 is past its free amount, or on pace to pass it, since R2 bills on any plan. */
function canBeBilled(data: HomeUsageData): UsageTile {
  if (data.bill.now > 0) {
    return {
      label: "Can be billed",
      value: `${usd(data.bill.now)} (R2)`,
      note: `R2 bills past its free amount, even on Free: ${usd(data.bill.projected)} by the month's end at this pace`,
      bad: false,
    };
  }
  if (data.bill.projected > 0) {
    return {
      label: "Can be billed",
      value: "$0 so far",
      note: `On pace for ${usd(data.bill.projected)} (R2): R2 bills past its free amount, even on Free`,
      bad: false,
    };
  }
  return {
    label: "Can be billed",
    value: "$0",
    note: "Free plan: Cloudflare stops apps at the daily limits",
    bad: false,
  };
}

/** A product's daily free amount on Workers Free; null when it has none per day. */
function freePerDay(key: ProductKey): number | null {
  const free = PRODUCTS[key].free;
  return isCount(key) && free !== null && free.per === "day" && free.amount > 0
    ? free.amount
    : null;
}

/**
 * Free: what the chart of `key` leaves out of the account's use today, the
 * part not from Appflare's apps: "Not charted: other usage in this account
 * (not Appflare apps), 89.8K rows today, 90% of today's free limit." Null
 * when it is under 1% of the limit, or there is no reading of it.
 */
function otherLine(data: HomeUsageData, key: ProductKey): string | null {
  const limit = freePerDay(key);
  const other = data.account[key]?.other ?? 0;
  if (data.plan !== "free" || limit === null || otherShareShown(other / limit) === null) {
    return null;
  }
  return `Not charted: ${OTHER_USAGE}, ${productAmount(key, other)} today, ${percent(other / limit)} of today's free limit.`;
}

/**
 * Free: the daily limit the account has used most of today: every app's
 * use (removed ones too) and, once the watcher read the account's totals,
 * everything else in the account. A limit "Needs attention" says is used up
 * reads as at least 100%, even when the hours stored so far add up to less.
 */
function closestDailyLimit(
  account: HomeUsageData["account"],
  usedUp: readonly string[],
): UsageTile {
  let best: { key: ProductKey; share: number } = { key: "workers_requests", share: 0 };
  for (const key of PRODUCT_KEYS) {
    const limit = freePerDay(key);
    if (limit === null) continue;
    const used = (account[key]?.today ?? 0) / limit;
    const share = usedUp.includes(key) ? Math.max(1, used) : used;
    if (share > best.share) best = { key, share };
  }
  const limit = freePerDay(best.key) ?? 1;
  const other = otherShareShown((account[best.key]?.other ?? 0) / limit);
  return {
    label: "Closest daily limit",
    value: percent(best.share),
    note:
      other === null
        ? `${productLabel(best.key)}, counted for the whole account`
        : `${productLabel(best.key)}: ${percent(other)} of the limit is ${OTHER_USAGE}`,
    bad: false,
  };
}
