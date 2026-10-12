import { describe, expect, it } from "vitest";
import { usageTabFixture } from "../test/usage-tab-fixture";
import { DAY_MS, HOUR_MS, hourStart, periodStart } from "./math";
import {
  DEFAULT_SPEND_DEFAULTS,
  defaultAppSpendSettings,
  resolveSpendSettings,
} from "./store/spend-settings";
import { capPassedAt } from "./tab";
import { accountHourlyFrom, appHourlyFrom, buildUsageTab, type UsageTabInput } from "./tab-build";

/**
 * The Usage tab's numbers and state from what its reads return: invented
 * usage of six apps, bent into each state the page shows, and a few rows
 * built by hand where the exact numbers matter.
 */

const NOW = Date.UTC(2026, 9, 12, 15, 30);

function bare(over: Partial<UsageTabInput> = {}): UsageTabInput {
  const own = defaultAppSpendSettings("app");
  return {
    installId: "app",
    now: NOW,
    plan: "paid",
    installedAt: NOW - 40 * DAY_MS,
    missingScopes: [],
    watch: null,
    updatedAt: NOW - 60_000,
    appHourly: [],
    appDaily: [],
    accountDaily: [],
    accountHourly: [],
    paused: new Set(),
    defaults: DEFAULT_SPEND_DEFAULTS,
    own,
    effective: resolveSpendSettings(DEFAULT_SPEND_DEFAULTS, own),
    snapshot: undefined,
    rules: [],
    alertsSent: [],
    pause: null,
    unusualSince: null,
    unusual: null,
    events: [],
    channels: [],
    logs: null,
    ...over,
  };
}

const s = (ms: number) => ms / 1000;

describe("buildUsageTab", () => {
  it("calm: normal, every product with its hours, days and month, the requests' share of the account's", () => {
    const tab = usageTabFixture("calm", { now: NOW });
    expect(tab.status.kind).toBe("normal");
    expect(tab.headline).toBe("workers_requests");
    expect(tab.products.map((p) => p.key)).toEqual([
      "workers_requests",
      "do_requests",
      "d1_rows_written",
    ]);
    for (const p of tab.products) {
      expect(p.hours).toHaveLength(168);
      expect(p.days).toHaveLength(30);
      expect(p.hours.at(-1)?.[0]).toBe(hourStart(NOW));
      expect(p.hot).toBe(false);
      expect(p.month).toBeGreaterThan(p.today);
      expect(p.projectedMonth).toBeGreaterThan(p.month ?? 0);
      expect(p.allowance?.daily).toBe(false);
      expect(p.overageUsd).toBe(0);
    }
    if (tab.status.kind !== "normal") throw new Error("not normal");
    // Six apps make requests; Service status makes about a tenth of them.
    expect(tab.status.requestsShare).toBeGreaterThan(0.05);
    expect(tab.status.requestsShare).toBeLessThan(0.3);
    expect(tab.rules.map((r) => r.state)).toEqual(["watching", "watching"]);
    expect(tab.spend.alertsSent).toBe(0);
    expect(tab.spend.channels).toEqual(["Telegram", "Slack"]);
  });

  it("runaway: far above normal since the episode began, right after a settings change", () => {
    const tab = usageTabFixture("runaway", { now: NOW });
    expect(tab.headline).toBe("do_requests");
    const status = tab.status;
    if (status.kind !== "runaway") throw new Error(`not runaway: ${status.kind}`);
    expect(status.product).toBe("do_requests");
    expect(status.perHour).toBeGreaterThan(3_000_000);
    expect(status.ratio).toBeGreaterThan(1000);
    expect(status.since).toBe(NOW - 2.55 * HOUR_MS);
    expect(status.after).toEqual({ kind: "settings" });
    expect(status.burnPerHour).toBeGreaterThan(0.5);
    expect(status.freeShare).toBeNull();
    const dos = tab.products.find((p) => p.key === "do_requests");
    expect(dos?.hot).toBe(true);
    // On pace past $20 this month: its alert was sent and counts in the badge.
    expect(tab.rules.find((r) => r.id === "rule-pace")?.state).toBe("fired");
    expect(tab.spend.alertsSent).toBeGreaterThanOrEqual(1);
  });

  it("limit (Free): a free daily limit used up after a loop", () => {
    const tab = usageTabFixture("limit", { now: NOW });
    expect(tab.plan).toBe("free");
    const status = tab.status;
    if (status.kind !== "limit") throw new Error(`not limit: ${status.kind}`);
    expect(status).toMatchObject({ product: "do_requests", limit: 100_000 });
    expect(status.loopSince).toBe(NOW - 2.55 * HOUR_MS);
    const dos = tab.products.find((p) => p.key === "do_requests");
    expect(dos?.allowance).toEqual({ share: expect.closeTo(1, 2), daily: true });
    expect(dos?.overageUsd).toBeNull();
  });

  it("busy: well above its normal without a loop", () => {
    const tab = usageTabFixture("busy", { now: NOW });
    const status = tab.status;
    if (status.kind !== "busy") throw new Error(`not busy: ${status.kind}`);
    expect(["workers_requests", "kv_reads"]).toContain(status.product);
    expect(status.ratio).toBeGreaterThanOrEqual(3);
    expect(tab.headline).toBe(status.product);
  });

  it("paused past its cap: who, why, and that Resume must set the cap aside", () => {
    const tab = usageTabFixture("paused", { now: NOW });
    const status = tab.status;
    if (status.kind !== "paused") throw new Error(`not paused: ${status.kind}`);
    expect(status.product).toBe("do_requests");
    expect(status.pause).toMatchObject({
      by: null,
      cause: { reason: "cap", amount: 2, period: "day" },
      stillPastCap: { amount: 2, period: "day", spent: 2.31, resetsAt: Date.UTC(2026, 9, 13) },
    });
    expect(tab.pause).toEqual(status.pause);
  });

  it("projects a paused app as using nothing more: the month, the rules and the cap", () => {
    const tab = usageTabFixture("paused", { now: NOW });
    for (const p of tab.products) expect(p.projectedMonth).toBe(p.month);
    for (const r of tab.rules) expect(r.projected).toBe(r.spent);
    expect(tab.rules.map((r) => r.state)).toEqual(["watching", "watching"]);
    expect(tab.spend.periods.day.projected).toBe(tab.spend.periods.day.spent);
  });

  it("says an alert was sent only when it was: on pace past the amount without a record is on pace", () => {
    const unsent = usageTabFixture("runaway", { now: NOW, alertsUnsent: true });
    expect(unsent.rules.find((r) => r.id === "rule-pace")?.state).toBe("on_pace");
    expect(unsent.spend.alertsSent).toBe(0);
    const sent = usageTabFixture("runaway", { now: NOW });
    expect(sent.rules.find((r) => r.id === "rule-pace")?.state).toBe("fired");
    expect(sent.spend.alertsSent).toBe(sent.rules.filter((r) => r.state === "fired").length);
  });

  it("takes a firing of the rule's current period as sent, and one of an earlier period as not", () => {
    const rule = (periodStartSeconds: number) => ({
      id: "r",
      installId: "app",
      kind: "spent" as const,
      unit: "usd" as const,
      amount: 100,
      period: "day" as const,
      createdAt: 0,
      createdBy: "u",
      lastFiring: { periodStart: periodStartSeconds, firedAt: 0, value: 101 },
    });
    const today = s(periodStart("day", NOW));
    expect(buildUsageTab(bare({ rules: [rule(today)] })).rules[0]?.state).toBe("fired");
    expect(buildUsageTab(bare({ rules: [rule(today - 86_400)] })).rules[0]?.state).toBe("watching");
  });

  it("without a normal yet, marks nothing and never divides by zero", () => {
    const hour = hourStart(NOW);
    const tab = buildUsageTab(
      bare({
        installedAt: NOW - 3 * HOUR_MS,
        appHourly: [
          { installId: "app", product: "workers_requests", t: s(hour - HOUR_MS), value: 50_000 },
          { installId: "app", product: "workers_requests", t: s(hour), value: 40_000 },
        ],
        appDaily: [
          {
            installId: "app",
            product: "workers_requests",
            t: s(NOW - (NOW % DAY_MS)),
            value: 90_000,
          },
        ],
      }),
    );
    const [p] = tab.products;
    expect(p?.normal).toBeNull();
    expect(p?.ratio).toBeNull();
    expect(p?.hot).toBe(false);
    expect(tab.status.kind).toBe("normal");
    expect(JSON.stringify(tab)).not.toMatch(/Infinity|NaN|null,"hot":true/);
    for (const [, v] of p?.hours ?? []) expect(Number.isFinite(v)).toBe(true);
  });

  it("projects from the install time, so the hours before the app existed are not idle ones", () => {
    const hour = hourStart(NOW);
    const rows = [
      { installId: "app", product: "workers_requests", t: s(hour - 2 * HOUR_MS), value: 100 },
      { installId: "app", product: "workers_requests", t: s(hour - HOUR_MS), value: 100 },
      { installId: "app", product: "workers_requests", t: s(hour), value: 50 },
    ];
    const daily = [
      { installId: "app", product: "workers_requests", t: s(NOW - (NOW % DAY_MS)), value: 250 },
    ];
    const young = buildUsageTab(
      bare({ installedAt: hour - 2 * HOUR_MS, appHourly: rows, appDaily: daily }),
    );
    const old = buildUsageTab(bare({ appHourly: rows, appDaily: daily }));
    // From install, the pace is the 100 an hour it has used; counting idle hours before it, less.
    expect(young.products[0]?.projectedMonth).toBeGreaterThan(old.products[0]?.projectedMonth ?? 0);
  });

  it("does not offer to set the cap aside once it is set aside, or with auto-pause off", () => {
    const aside = usageTabFixture("paused", {
      now: NOW,
      own: { autoPause: "on", capSetAsideUntil: NOW + HOUR_MS },
    });
    expect(aside.pause?.stillPastCap).toBeNull();
    const off = usageTabFixture("paused", { now: NOW, own: { autoPause: "off" } });
    expect(off.pause?.stillPastCap).toBeNull();
  });

  it("fresh: installed minutes ago, nothing reported yet", () => {
    const tab = usageTabFixture("fresh", { now: NOW });
    expect(tab.status).toEqual({ kind: "fresh", installedAt: NOW - 6 * 60_000 });
    expect(tab.products).toEqual([]);
    expect(tab.headline).toBeNull();
  });

  it("an old app with nothing reported is empty, not fresh", () => {
    expect(buildUsageTab(bare()).status).toEqual({ kind: "empty" });
  });

  it("reconnect: the connection lacks the usage permissions", () => {
    const oauth = usageTabFixture("reconnect", { now: NOW });
    expect(oauth.status).toEqual({ kind: "reconnect", via: "oauth" });
    expect(oauth.missingScopes).toEqual(["account-analytics.read"]);
    expect(usageTabFixture("reconnect", { now: NOW, via: "token" }).status).toEqual({
      kind: "reconnect",
      via: "token",
    });
    // A grant lacking the scopes asks for a reconnect before the watcher has run.
    expect(buildUsageTab(bare({ missingScopes: ["workers-observability.read"] })).status).toEqual({
      kind: "reconnect",
      via: "oauth",
    });
    // Watching or failed: the numbers show as they are.
    expect(
      buildUsageTab(bare({ watch: { state: "failed", at: NOW, error: "x" } })).status.kind,
    ).toBe("empty");
  });

  it("holds a level between hours, leaves its month out, and measures it against what is included", () => {
    const day = s(NOW - (NOW % DAY_MS));
    const tab = buildUsageTab(
      bare({
        appHourly: [
          { installId: "app", product: "r2_storage", t: s(hourStart(NOW) - 5 * HOUR_MS), value: 4 },
          { installId: "app", product: "r2_storage", t: s(hourStart(NOW) - 2 * HOUR_MS), value: 5 },
        ],
        appDaily: [{ installId: "app", product: "r2_storage", t: day, value: 5 }],
        accountDaily: [
          { installId: "app", product: "r2_storage", t: day, value: 5 },
          { installId: "other", product: "r2_storage", t: day - 86_400, value: 3 },
        ],
      }),
    );
    const [r2] = tab.products;
    expect(r2?.key).toBe("r2_storage");
    expect(r2?.lastHour).toBe(5);
    expect(r2?.today).toBe(5);
    expect(r2?.month).toBeNull();
    expect(r2?.projectedMonth).toBeNull();
    expect(r2?.hours.at(-1)).toEqual([hourStart(NOW), 5]);
    expect(r2?.hours.at(-4)).toEqual([hourStart(NOW) - 3 * HOUR_MS, 4]);
    // 5 GB here and 3 GB held by another app, of 10 GB included.
    expect(r2?.allowance).toEqual({ share: 0.8, daily: false });
  });

  it("shows a count's day on the 30-day chart as its average hour, today's over the hours so far", () => {
    const today = NOW - (NOW % DAY_MS);
    const tab = buildUsageTab(
      bare({
        appDaily: [
          { installId: "app", product: "workers_requests", t: s(today - DAY_MS), value: 2400 },
          { installId: "app", product: "workers_requests", t: s(today), value: 1550 },
        ],
      }),
    );
    const days = tab.products[0]?.days ?? [];
    expect(days.at(-2)).toEqual([today - DAY_MS, 100]);
    expect(days.at(-1)).toEqual([today, 100]);
  });

  it("counts the alerts sent in their rules' current periods only", () => {
    const rule = (id: string, period: "day" | "month") => ({
      id,
      installId: "app",
      kind: "spent" as const,
      unit: "usd" as const,
      amount: 1,
      period,
      createdAt: 0,
      createdBy: "u",
      lastFiring: null,
    });
    const tab = buildUsageTab(
      bare({
        rules: [rule("daily", "day"), rule("monthly", "month")],
        alertsSent: [
          { ruleId: "daily", periodStart: s(periodStart("day", NOW)) },
          { ruleId: "daily", periodStart: s(periodStart("day", NOW) - DAY_MS) },
          { ruleId: "monthly", periodStart: s(periodStart("month", NOW)) },
          { ruleId: "removed", periodStart: s(periodStart("month", NOW)) },
        ],
      }),
    );
    expect(tab.spend.alertsSent).toBe(2);
  });

  it("reads the account's rows from yesterday and the app's from 8 days back", () => {
    expect(accountHourlyFrom(NOW)).toBe(Date.UTC(2026, 9, 11));
    expect(appHourlyFrom(NOW)).toBe(Date.UTC(2026, 9, 4));
  });
});

describe("capPassedAt", () => {
  it("is the hour the period's spend reached the cap, or null", () => {
    const start = Date.UTC(2026, 9, 12);
    const hours: [number, number][] = [
      [start - HOUR_MS, 5],
      [start, 0.5],
      [start + HOUR_MS, 1],
      [start + 2 * HOUR_MS, 1],
    ];
    expect(capPassedAt(hours, 1.5, start)).toBe(start + HOUR_MS);
    expect(capPassedAt(hours, 10, start)).toBeNull();
    expect(capPassedAt(hours, 0, start)).toBeNull();
  });
});
