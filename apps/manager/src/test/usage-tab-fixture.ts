import type { AccountPlan } from "../account/plan";
import { alertSentence } from "../usage/alert-rules";
import type { PauseCause } from "../usage/attention-cause";
import {
  DAY_MS,
  dayStart,
  HOUR_MS,
  hourStart,
  LOOP_LEVEL_NAMES,
  loopCheck,
  PERIODS,
  PRODUCTS,
  type ProductKey,
  periodStart,
  spendInPeriod,
} from "../usage/math";
import type { SpendApp } from "../usage/overview";
import type { AlertRule } from "../usage/store/alert-rules.server";
import type { UsageRow } from "../usage/store/series.server";
import {
  type AppSpendSettings,
  DEFAULT_SPEND_DEFAULTS,
  defaultAppSpendSettings,
  resolveSpendSettings,
  type SpendDefaults,
} from "../usage/store/spend-settings";
import type { UsageEvent, UsageTabData } from "../usage/tab";
import {
  accountHourlyFrom,
  appDailyFrom,
  appHourlyFrom,
  buildUsageTab,
  usageFromRows,
} from "../usage/tab-build";

/**
 * Test-only: an app's Usage tab as the server builds it, from invented
 * hourly usage of six apps, bent by a scenario: calm, an app gone far above
 * normal (`runaway`), a loop that used up a free daily limit on Free
 * (`limit`), an app busier than usual (`busy`), an app paused past its daily
 * cap (`paused`), an app installed minutes ago (`fresh`), and a connection
 * without the usage permissions (`reconnect`). The tests and the screenshot
 * harness read it; times are relative to `now`.
 */

export type UsageScenario =
  | "calm"
  | "runaway"
  | "limit"
  | "busy"
  | "paused"
  | "fresh"
  | "reconnect";

/** Hourly base rates per install, before the day's rhythm. */
const BASE: Record<string, Partial<Record<ProductKey, number>>> = {
  "install-cloudmark": { workers_requests: 120, d1_rows_read: 4_000, d1_rows_written: 40 },
  "install-formzero": { workers_requests: 30, d1_rows_read: 200, d1_rows_written: 5 },
  "install-r2-explorer": { workers_requests: 60, r2_class_a: 20, r2_storage: 6.2 },
  "install-emdash": {
    workers_requests: 400,
    d1_rows_read: 30_000,
    kv_reads: 300,
    r2_storage: 1.1,
  },
  "install-statusbeam": { workers_requests: 250, do_requests: 1_440, d1_rows_written: 120 },
  "install-cut": { workers_requests: 900, kv_reads: 900, kv_writes: 2 },
};

const INSTALLS = Object.keys(BASE);
/** The app each scenario shows. */
export const SCENARIO_APP: Record<UsageScenario, string> = {
  calm: "install-statusbeam",
  runaway: "install-statusbeam",
  limit: "install-statusbeam",
  busy: "install-cut",
  paused: "install-statusbeam",
  fresh: "install-formzero",
  reconnect: "install-statusbeam",
};

/** Hours of history: 31 days. */
const HOURS = 31 * 24;
/** The loop started this many hours ago; when paused, it ran this long first. */
const LOOP_STARTED = 2.7;
const PAUSED_STARTED = 5.2;
const PAUSED_AFTER = 2.4;
/** A brand-new app was installed this many minutes ago. */
export const FRESH_MINUTES = 6;

function seeded(seed: number) {
  let s = seed;
  return () => {
    s = (s * 1664525 + 1013904223) % 4294967296;
    return s / 4294967296;
  };
}

/** How the scenario bends one app's product `hoursAgo`. */
function bend(id: string, key: ProductKey, hoursAgo: number, scenario: UsageScenario): number {
  if (
    scenario === "busy" &&
    id === "install-cut" &&
    (key === "workers_requests" || key === "kv_reads")
  ) {
    if (hoursAgo < 10) return 10 + 30 * (1 - hoursAgo / 10);
  }
  if (id === "install-statusbeam" && key === "do_requests") {
    if ((scenario === "runaway" || scenario === "limit") && hoursAgo < LOOP_STARTED) return -1;
    if (scenario === "paused" && hoursAgo < PAUSED_STARTED) {
      return hoursAgo > PAUSED_STARTED - PAUSED_AFTER ? -1 : 0;
    }
  }
  if (
    id === "install-statusbeam" &&
    scenario === "paused" &&
    hoursAgo < PAUSED_STARTED - PAUSED_AFTER
  ) {
    return key === "workers_requests" ? 0.002 : 0;
  }
  return 1;
}

interface World {
  now: number;
  /** Hourly values per install and product, oldest first; the last is the hour still filling up. */
  series: Record<string, Partial<Record<ProductKey, number[]>>>;
}

function buildWorld(scenario: UsageScenario, plan: AccountPlan, now: number): World {
  const current = hourStart(now);
  const filled = (now - current) / HOUR_MS;
  const series: World["series"] = {};
  INSTALLS.forEach((id, appIndex) => {
    const own: Partial<Record<ProductKey, number[]>> = {};
    for (const [key, base] of Object.entries(BASE[id] ?? {}) as [ProductKey, number][]) {
      const rand = seeded(appIndex * 97 + key.length * 13 + 7);
      const values: number[] = [];
      for (let i = 0; i < HOURS; i++) {
        const hoursAgo = HOURS - 1 - i;
        const at = current - hoursAgo * HOUR_MS;
        if (PRODUCTS[key].measure === "level") {
          values.push(base * (0.9 + 0.1 * (i / HOURS)) + rand() * 0.01);
          continue;
        }
        const hourOfDay = new Date(at).getUTCHours();
        const rhythm = 0.55 + 0.45 * Math.sin(((hourOfDay - 9) / 24) * 2 * Math.PI);
        const noise = 0.8 + rand() * 0.4;
        const b = bend(id, key, hoursAgo, scenario);
        // A loop ignores the time of day: about 5M requests an hour, flat.
        const value = b < 0 ? 5_000_000 * noise : base * rhythm * noise * b;
        values.push(hoursAgo === 0 ? value * filled : value);
      }
      own[key] = values;
    }
    series[id] = own;
  });
  // On Free, Cloudflare refuses Durable Object requests past the account's daily limit.
  if (plan === "free" && (scenario === "limit" || scenario === "paused")) {
    const limit = PRODUCTS.do_requests.free?.amount ?? 100_000;
    const values = series["install-statusbeam"]?.do_requests ?? [];
    let day = -1;
    let used = 0;
    values.forEach((v, i) => {
      const d = Math.floor((current - (HOURS - 1 - i) * HOUR_MS) / DAY_MS);
      if (d !== day) {
        day = d;
        used = 0;
      }
      values[i] = Math.min(v, Math.max(0, limit - used));
      used += values[i] ?? 0;
    });
  }
  // Brand-new: Cloudflare reports nothing for the first 15 minutes.
  if (scenario === "fresh") series["install-formzero"] = {};
  return { now, series };
}

/** The world as the tables hold it: hourly rows, and daily rows (a day's sum, or its last level). */
function rows(world: World): { hourly: UsageRow[]; daily: UsageRow[] } {
  const current = hourStart(world.now);
  const hourly: UsageRow[] = [];
  const daily = new Map<string, UsageRow>();
  for (const [installId, products] of Object.entries(world.series)) {
    for (const [product, values] of Object.entries(products) as [ProductKey, number[]][]) {
      const level = PRODUCTS[product].measure === "level";
      values.forEach((value, i) => {
        const at = current - (values.length - 1 - i) * HOUR_MS;
        hourly.push({ installId, product, t: at / 1000, value });
        const day = dayStart(at) / 1000;
        const k = `${installId}|${product}|${day}`;
        const row = daily.get(k) ?? { installId, product, t: day, value: 0 };
        row.value = level ? value : row.value + value;
        daily.set(k, row);
      });
    }
  }
  return { hourly, daily: [...daily.values()] };
}

function snapshotOf(
  installId: string,
  label: string,
  hourly: UsageRow[],
  daily: UsageRow[],
  plan: AccountPlan,
  now: number,
  since: number,
  paused: boolean,
): SpendApp {
  const usage =
    usageFromRows(hourly, daily, appHourlyFrom(now), periodStart("month", now)).get(installId) ??
    {};
  const checks = LOOP_LEVEL_NAMES.map((level) => loopCheck({ plan, level, usage, now, since }));
  return {
    installId,
    label,
    paused,
    autoPause: false,
    followsAccountTriggers: true,
    budgetExempt: false,
    capSetAsideUntil: null,
    burnPerHour: checks[0]?.burn ?? 0,
    ratio: checks[0]?.ratio ?? null,
    loop: Object.fromEntries(
      LOOP_LEVEL_NAMES.map((level, i) => [
        level,
        {
          money: checks[i]?.money ?? false,
          abnormal: checks[i]?.abnormal ?? false,
          trips: checks[i]?.trips ?? false,
        },
      ]),
    ) as SpendApp["loop"],
    spend: Object.fromEntries(
      PERIODS.map((p) => {
        const s = spendInPeriod(usage, p, now, { since });
        return [p, { spent: s.spent, projected: s.projected, resetsAt: s.resetsAt }];
      }),
    ) as SpendApp["spend"],
    overageUsd: 0,
  };
}

function rule(
  id: string,
  installId: string,
  r: Pick<AlertRule, "kind" | "unit" | "amount" | "period">,
  now: number,
): AlertRule {
  return {
    id,
    installId,
    ...r,
    createdAt: now - 20 * DAY_MS,
    createdBy: "user-ada",
    lastFiring: null,
  };
}

export interface UsageTabFixtureOptions {
  now?: number;
  plan?: AccountPlan;
  /** Admins see the channels alerts go to. */
  isAdmin?: boolean;
  defaults?: Partial<SpendDefaults>;
  own?: Partial<AppSpendSettings>;
  /** How Appflare connects, for `reconnect`: OAuth (the default) or an API token. */
  via?: "oauth" | "token";
  /** Leave the alerts the rules passed unsent (the watcher has not checked yet). */
  alertsUnsent?: boolean;
  /** Rules of the app; Service status's two by default. */
  rules?: AlertRule[];
}

export function usageTabFixture(
  scenario: UsageScenario,
  options: UsageTabFixtureOptions = {},
): UsageTabData {
  const now = options.now ?? Date.UTC(2026, 9, 12, 15, 30);
  const plan = options.plan ?? (scenario === "limit" ? "free" : "paid");
  const installId = SCENARIO_APP[scenario];
  const world = buildWorld(scenario, plan, now);
  const { hourly, daily } = rows(world);
  const index = INSTALLS.indexOf(installId);
  const installedAt =
    scenario === "fresh" ? now - FRESH_MINUTES * 60_000 : now - (24 + index * 3) * DAY_MS;
  const loopStart = now - (scenario === "paused" ? PAUSED_STARTED : LOOP_STARTED) * HOUR_MS;
  const pausedAt = now - (PAUSED_STARTED - PAUSED_AFTER) * HOUR_MS;
  const looping = scenario === "runaway" || scenario === "limit" || scenario === "paused";

  const defaults: SpendDefaults = { ...DEFAULT_SPEND_DEFAULTS, ...options.defaults };
  const own: AppSpendSettings = {
    ...defaultAppSpendSettings(installId),
    ...(installId === "install-statusbeam"
      ? { customTriggers: true, capAmount: 2, capPeriod: "day" as const }
      : {}),
    ...(scenario === "paused" ? { autoPause: "on" as const } : {}),
    ...options.own,
  };
  const effective = resolveSpendSettings(defaults, own);

  const events: UsageEvent[] = [
    {
      id: "e-install",
      at: installedAt,
      kind: "installed",
      from: "catalog",
    },
  ];
  if (installId === "install-statusbeam") {
    events.push({
      id: "e-update",
      at: now - 9 * DAY_MS,
      kind: "updated",
      version: "0.1.0",
      automatic: true,
    });
  }
  let pause: Parameters<typeof buildUsageTab>[0]["pause"] = null;
  if (looping) {
    events.push(
      {
        id: "e-settings",
        at: loopStart - 0.1 * HOUR_MS,
        kind: "app_settings",
        automatic: false,
        changes: ["Check interval set to 10 seconds"],
      },
      {
        id: "e-unusual",
        at: loopStart + 0.15 * HOUR_MS,
        kind: "unusual_started",
        product: "do_requests",
        times: 3000,
      },
    );
  }
  if (scenario === "limit") {
    events.push({
      id: "e-limit",
      at: loopStart + 0.6 * HOUR_MS,
      kind: "limit_near",
      product: "do_requests",
      share: 1,
      runsOutAt: loopStart + 0.6 * HOUR_MS,
    });
  }
  if (scenario === "paused") {
    const cause: PauseCause = { reason: "cap", amount: 2, period: "day", spent: 2.31 };
    events.push({ id: "e-paused", at: pausedAt, kind: "paused", by: null, cause });
    pause = { pausedAt, by: null, cause };
  }
  if (scenario === "busy") {
    events.push({
      id: "e-update-cut",
      at: now - 14 * DAY_MS,
      kind: "updated",
      version: "0.1.0",
      automatic: true,
    });
  }
  events.sort((a, b) => b.at - a.at);

  const rules =
    options.rules ??
    (installId === "install-statusbeam"
      ? [
          rule(
            "rule-spent",
            installId,
            { kind: "spent", unit: "usd", amount: 6, period: "month" },
            now,
          ),
          rule(
            "rule-pace",
            installId,
            { kind: "pace", unit: "usd", amount: 20, period: "month" },
            now,
          ),
        ]
      : installId === "install-cut"
        ? [
            rule(
              "rule-cut",
              installId,
              { kind: "pace", unit: "pct", amount: 50, period: "month" },
              now,
            ),
          ]
        : []);

  const appProducts = new Set(Object.keys(world.series[installId] ?? {}));
  const monthFrom = periodStart("month", now) / 1000;
  const input: Parameters<typeof buildUsageTab>[0] = {
    installId,
    now,
    plan,
    installedAt,
    missingScopes: [],
    watch:
      scenario === "reconnect"
        ? {
            state: "needs_access",
            at: now - 60_000,
            via: options.via ?? "oauth",
            missing: options.via === "token" ? [] : ["account-analytics.read"],
          }
        : { state: "watching", at: now - 60_000 },
    updatedAt: now - 60_000,
    appHourly: hourly.filter((r) => r.installId === installId && r.t * 1000 >= appHourlyFrom(now)),
    appDaily: daily.filter((r) => r.installId === installId && r.t * 1000 >= appDailyFrom(now)),
    accountDaily: daily.filter((r) => appProducts.has(r.product) && r.t >= monthFrom),
    accountHourly: hourly.filter(
      (r) => appProducts.has(r.product) && r.t * 1000 >= accountHourlyFrom(now),
    ),
    paused: new Set(scenario === "paused" ? [installId] : []),
    defaults,
    own,
    effective,
    snapshot: snapshotOf(
      installId,
      "Service status",
      hourly.filter((r) => r.installId === installId),
      daily.filter((r) => r.installId === installId),
      plan,
      now,
      installedAt,
      scenario === "paused",
    ),
    rules,
    alertsSent: [],
    pause,
    unusualSince: looping && scenario !== "paused" ? loopStart + 0.15 * HOUR_MS : null,
    unusual: looping
      ? { at: loopStart + 0.15 * HOUR_MS, product: "do_requests", times: 3000, freeShare: null }
      : null,
    events,
    channels: options.isAdmin === false ? null : ["Telegram", "Slack"],
    logs: null,
  };
  // The rules past their amount this period have sent their alert, as the watcher would have.
  const first = buildUsageTab(input);
  const fired = first.rules.filter((r) => (r.kind === "spent" ? r.spent : r.projected) >= r.amount);
  if (fired.length === 0 || options.alertsUnsent === true) return first;
  const sentAt = looping ? loopStart + 0.5 * HOUR_MS : now - 2 * HOUR_MS;
  return buildUsageTab({
    ...input,
    alertsSent: fired.map((r) => ({
      ruleId: r.id,
      periodStart: periodStart(r.period, now) / 1000,
    })),
    events: [
      ...fired.map(
        (r): UsageEvent => ({
          id: `e-alert-${r.id}`,
          at: sentAt,
          kind: "alert_sent",
          sentence: alertSentence(plan, r),
        }),
      ),
      ...events,
    ].sort((a, b) => b.at - a.at),
  });
}
