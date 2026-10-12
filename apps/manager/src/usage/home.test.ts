import { describe, expect, it } from "vitest";
import type { UsageAttention } from "./attention";
import {
  appSlots,
  type HomeUsageApp,
  type HomeUsageData,
  type HomeUsageSeries,
  homeUsageView,
  MAX_PRODUCT_TABS,
} from "./home";
import { DAY_MS, HOUR_MS, type ProductKey } from "./math";

// Oct 12, 15:30 UTC: the month began Oct 1, 11 days before today; the chart
// shows Oct 6 to 11, and today has 16 hours, the last half done.
const NOW = Date.UTC(2026, 9, 12, 15, 30);
const WINDOW_START = Date.UTC(2026, 9, 6);
const DAYS = 11;
const HOURS = 16;

function app(installId: string, over: Partial<HomeUsageApp> = {}): HomeUsageApp {
  return {
    installId,
    installedAt: NOW - 30 * DAY_MS,
    paused: false,
    burnPerHour: 0.01,
    ratio: 1,
    ...over,
  };
}

/** A product used evenly: `perDay` on every day, `perHour` in every hour of today (daily totals). */
function series(
  installId: string,
  product: ProductKey,
  perDay: number,
  perHour = perDay / 24,
  ratio: number | null = null,
): HomeUsageSeries {
  return {
    installId,
    product,
    past: new Array<number>(6).fill(perDay),
    hours: new Array<number>(HOURS).fill(perHour),
    ratio,
  };
}

/** The account's use as the server adds it up: each series' every day this month and today. */
function accountOf(all: readonly HomeUsageSeries[]): HomeUsageData["account"] {
  const out: HomeUsageData["account"] = {};
  for (const s of all) {
    const today = s.hours.reduce((t, v) => t + v, 0);
    const use = out[s.product] ?? { today: 0, month: 0 };
    use.today += today;
    use.month += (s.past[0] ?? 0) * DAYS + today;
    out[s.product] = use;
  }
  return out;
}

function data(over: Partial<HomeUsageData> = {}): HomeUsageData {
  const merged: HomeUsageData = {
    plan: "paid",
    now: NOW,
    needsAccess: null,
    bill: { now: 7.85, projected: 66.45 },
    apps: [app("a"), app("b")],
    windowStart: WINDOW_START,
    grain: "day",
    series: [series("a", "workers_requests", 24_000), series("b", "workers_requests", 72_000)],
    account: {},
    ...over,
  };
  return { ...merged, account: over.account ?? accountOf(merged.series) };
}

const NAMES = [
  { id: "a", label: "Bookmarks" },
  { id: "b", label: "Service status" },
];

function view(d: HomeUsageData, attention: UsageAttention[] = [], apps = NAMES) {
  return homeUsageView({ data: d, apps, attention });
}

const unusual = (installId: string, product: string | null = "do_requests"): UsageAttention => ({
  kind: "unusual",
  installId,
  plan: "paid",
  since: NOW - HOUR_MS,
  product,
  perHour: 4_000_000,
  times: 3000,
  burnPerHour: 1.02,
  spentToday: 3.03,
  freeShare: null,
  sentTo: [],
});

describe("Home's usage totals", () => {
  it("Paid: usage past included, the projected month with the plan, and what every app burns now", () => {
    const v = view(
      data({ apps: [app("a", { burnPerHour: 0.02 }), app("b", { burnPerHour: 0.1 })] }),
    );
    expect(v.tiles).toEqual([
      {
        label: "Usage this month",
        value: "$2.85",
        note: "Past what the $5 plan includes (estimate)",
        bad: false,
      },
      {
        label: "Projected month",
        value: "$66.45",
        note: "Plan included, if the last day's pace holds",
        bad: false,
      },
      {
        label: "Burning now",
        value: "$0.12/h",
        note: "At list price, before included usage",
        bad: false,
      },
    ]);
  });

  it("Paid: burning now is red and names the app most of it is while one runs away", () => {
    const v = view(data({ apps: [app("a"), app("b", { burnPerHour: 1.02 })] }), [unusual("b")]);
    expect(v.tiles[2]).toMatchObject({
      value: "$1.03/h",
      note: "Mostly Service status",
      bad: true,
    });
  });

  it("Paid: usage this month never reads below zero", () => {
    expect(view(data({ bill: { now: 5, projected: 5.4 } })).tiles[0]?.value).toBe("$0.00");
  });

  it("Free: nothing can be billed, the closest daily limit, and the apps needing a look", () => {
    const v = view(
      data({
        plan: "free",
        bill: { now: 0, projected: 0 },
        series: [
          // 48,000 requests today of 100,000: 48%; 1,600 KV writes past the 1,000: 160%.
          series("a", "workers_requests", 24_000, 1_000),
          series("b", "workers_requests", 72_000, 2_000),
          series("b", "kv_writes", 500, 100),
        ],
      }),
      [
        {
          kind: "limit-near",
          installId: "a",
          product: "workers_requests",
          limit: 100_000,
          runsOutAt: NOW + HOUR_MS,
          appShare: 0.3,
        },
      ],
    );
    expect(v.tiles).toEqual([
      {
        label: "Can be billed",
        value: "$0",
        note: "Free plan: Cloudflare stops apps at the daily limits",
        bad: false,
      },
      {
        label: "Closest daily limit",
        value: "160%",
        note: "KV writes, shared by every app",
        bad: false,
      },
      { label: "Apps needing a look", value: "1", note: "Loops, limits and pauses", bad: false },
    ]);
  });

  it("Free: R2 past its free amount can be billed, even on Free", () => {
    const v = view(data({ plan: "free", bill: { now: 0.42, projected: 1.3 } }));
    expect(v.tiles[0]).toEqual({
      label: "Can be billed",
      value: "$0.42 (R2)",
      note: "R2 bills past its free amount, even on Free: $1.30 by the month's end at this pace",
      bad: false,
    });
  });

  it("Free: R2 on pace to pass its free amount says so before it bills", () => {
    const v = view(data({ plan: "free", bill: { now: 0, projected: 1.3 } }));
    expect(v.tiles[0]).toEqual({
      label: "Can be billed",
      value: "$0 so far",
      note: "On pace for $1.30 (R2): R2 bills past its free amount, even on Free",
      bad: false,
    });
  });

  it("Free: a limit Needs attention calls used up reads as at least 100%", () => {
    const v = view(
      data({
        plan: "free",
        bill: { now: 0, projected: 0 },
        // 90,000 of 100,000 stored so far.
        series: [series("b", "do_requests", 0, 90_000 / HOURS)],
      }),
      [
        {
          kind: "limit-used-up",
          installId: "b",
          product: "do_requests",
          limit: 100_000,
          appShare: 0.97,
          loopSince: null,
        },
      ],
    );
    expect(v.tiles[1]).toMatchObject({
      value: "100%",
      note: "Durable Objects requests, shared by every app",
    });
  });

  it("counts an app removed today toward the account's limits and shares, but does not chart it", () => {
    const v = view(
      data({
        plan: "free",
        bill: { now: 0, projected: 0 },
        series: [
          series("a", "workers_requests", 24_000, 1_000),
          // Removed earlier today: not among the apps, still in the account's use.
          series("gone", "workers_requests", 0, 2_000),
        ],
      }),
    );
    // 16,000 + 32,000 of 100,000.
    expect(v.tiles[1]?.value).toBe("48%");
    expect(v.chart("workers_requests").caption).toBe("Last 7 days · 48% of today's free limit");
    expect(v.chart("workers_requests").series.map((s) => s.installId)).toEqual(["a"]);
    expect(v.cards.get("a")?.line).toBe("33% of today's requests");
  });

  it("Free: a used-up limit makes the apps needing a look red", () => {
    const v = view(data({ plan: "free", bill: { now: 0, projected: 0 } }), [
      {
        kind: "limit-used-up",
        installId: "b",
        product: "do_requests",
        limit: 100_000,
        appShare: 0.97,
        loopSince: NOW - HOUR_MS,
      },
    ]);
    expect(v.tiles[2]).toMatchObject({ value: "1", bad: true });
  });
});

describe("Home's usage chart", () => {
  it("draws the watcher's hours for the 6 days when it has them, then today's", () => {
    const past = Array.from({ length: 144 }, (_, i) => i);
    const d = data({
      grain: "hour",
      series: [
        {
          installId: "a",
          product: "workers_requests",
          past,
          hours: new Array<number>(HOURS).fill(7),
          ratio: 1,
        },
      ],
    });
    const points = view(d).chart("workers_requests").series[0]?.points ?? [];
    expect(points).toHaveLength(144 + HOURS);
    expect(points[0]).toEqual({ t: Date.UTC(2026, 9, 6), perHour: 0, day: false });
    expect(points[143]).toEqual({ t: Date.UTC(2026, 9, 11, 23), perHour: 143, day: false });
    expect(points[144]).toEqual({ t: Date.UTC(2026, 9, 12), perHour: 7, day: false });
    expect(view(d).cards.get("a")?.points).toHaveLength(144 + HOURS);
  });

  it("without the watcher's hours, draws 6 days as hourly averages, then today's hours, the running one as a rate", () => {
    const d = data({
      series: [
        {
          installId: "a",
          product: "workers_requests",
          past: [...new Array<number>(5).fill(2_400), 4_800],
          hours: [...new Array<number>(HOURS - 1).fill(100), 50],
          ratio: null,
        },
      ],
    });
    const points = view(d).chart("workers_requests").series[0]?.points ?? [];
    expect(points).toHaveLength(6 + HOURS);
    expect(points[0]).toEqual({ t: Date.UTC(2026, 9, 6, 12), perHour: 100, day: true });
    expect(points[5]).toEqual({ t: Date.UTC(2026, 9, 11, 12), perHour: 200, day: true });
    expect(points[6]).toEqual({ t: Date.UTC(2026, 9, 12), perHour: 100, day: false });
    // 50 in the first half of the hour: 100 an hour.
    expect(points.at(-1)).toEqual({ t: Date.UTC(2026, 9, 12, 15), perHour: 100, day: false });
  });

  it("leaves out the running hour in its first minutes", () => {
    const d = data({ now: Date.UTC(2026, 9, 12, 15, 5) });
    expect(view(d).chart("workers_requests").series[0]?.points).toHaveLength(6 + 15);
  });

  it("gives every app its own colour in card order, with the same colour on its card", () => {
    const v = view(data());
    const chart = v.chart("workers_requests");
    expect(chart.series.map((s) => [s.name, s.tone])).toEqual([
      ["Bookmarks", { kind: "slot", index: 0 }],
      ["Service status", { kind: "slot", index: 1 }],
    ]);
    expect(v.cards.get("b")?.tone).toEqual({ kind: "slot", index: 1 });
  });

  it("past 6 apps, keeps colours for the 5 that used the most and adds up the rest as Other apps", () => {
    const ids = ["a", "b", "c", "d", "e", "f", "g"];
    const apps = ids.map((id) => ({ id, label: id.toUpperCase() }));
    // a and b use the least.
    const used = { a: 10, b: 20, c: 300, d: 400, e: 500, f: 600, g: 700 } as Record<string, number>;
    const d = data({
      apps: ids.map((id) => app(id)),
      series: ids.map((id) => series(id, "workers_requests", (used[id] ?? 0) * 24)),
    });
    const v = view(d, [], apps);
    const chart = v.chart("workers_requests");
    expect(chart.series.map((s) => [s.name, s.tone])).toEqual([
      ["C", { kind: "slot", index: 0 }],
      ["D", { kind: "slot", index: 1 }],
      ["E", { kind: "slot", index: 2 }],
      ["F", { kind: "slot", index: 3 }],
      ["G", { kind: "slot", index: 4 }],
      ["Other apps", { kind: "slot", index: 5 }],
    ]);
    expect(chart.series.at(-1)?.points[0]?.perHour).toBe(30);
    expect(chart.series.at(-1)?.installId).toBeNull();
    expect(v.cards.get("a")?.tone).toEqual({ kind: "slot", index: 5 });
    expect(v.cards.get("c")?.tone).toEqual({ kind: "slot", index: 0 });
  });

  it("keeps 6 apps on their own colours", () => {
    const apps = ["a", "b", "c", "d", "e", "f"].map((id) => ({ id, label: id }));
    expect([...appSlots(apps, new Map()).values()]).toEqual([0, 1, 2, 3, 4, 5]);
  });

  it("opens on the product an app is in trouble with, and says the account's share of it", () => {
    const d = data({
      series: [
        series("a", "workers_requests", 24_000),
        series("b", "workers_requests", 72_000),
        // 4M an hour today, 1M a day before.
        series("b", "do_requests", 1_000_000, 4_000_000),
      ],
    });
    const v = view(d, [unusual("b")]);
    expect(v.initialProduct).toBe("do_requests");
    expect(v.products).toEqual(["workers_requests", "do_requests"]);
    // 11 days of 1M and 16 hours of 4M this month, of 1M included.
    expect(v.chart("do_requests").caption).toBe("Last 7 days · 7,500% of this month's included");
  });

  it("opens on Worker requests when every app is calm, measured on Free against today's free limit", () => {
    const v = view(
      data({
        plan: "free",
        series: [series("a", "workers_requests", 24_000, 1_000)],
      }),
    );
    expect(v.initialProduct).toBe("workers_requests");
    expect(v.chart("workers_requests").caption).toBe("Last 7 days · 16% of today's free limit");
  });

  it("shows at most 6 product tabs, the ones closest to their allowance, in the usual order", () => {
    const products: ProductKey[] = [
      "workers_requests",
      "workers_cpu_ms",
      "do_requests",
      "d1_rows_read",
      "d1_rows_written",
      "kv_reads",
      "kv_writes",
      "queues_operations",
    ];
    const v = view(data({ series: products.map((p, i) => series("a", p, 1_000 * (i + 1))) }));
    expect(v.products).toHaveLength(MAX_PRODUCT_TABS);
    // CPU time and D1 rows read come nowhere near what is included.
    expect(v.products).toEqual([
      "workers_requests",
      "do_requests",
      "d1_rows_written",
      "kv_reads",
      "kv_writes",
      "queues_operations",
    ]);
  });

  it("has no product when nothing was used", () => {
    const v = view(data({ series: [] }));
    expect(v.initialProduct).toBeNull();
    expect(v.products).toEqual([]);
  });
});

describe("Home's usage on an app card", () => {
  it("a calm app: its share of today's requests, in its colour, with nothing to press", () => {
    const card = view(data()).cards.get("a");
    expect(card).toMatchObject({
      state: "normal",
      product: "workers_requests",
      tone: { kind: "slot", index: 0 },
      line: "25% of today's requests",
      action: null,
    });
    expect(card?.points).toHaveLength(6 + HOURS);
  });

  it("a busier app says so", () => {
    const d = data({ apps: [app("a", { ratio: 4 }), app("b")] });
    expect(view(d).cards.get("a")?.line).toBe("25% of today's requests · busier than usual");
  });

  it("an app running away: red, its burn and product, and Pause", () => {
    const d = data({
      apps: [app("a"), app("b", { burnPerHour: 1.02 })],
      series: [...data().series, series("b", "do_requests", 0, 4_000_000)],
    });
    expect(view(d, [unusual("b")]).cards.get("b")).toMatchObject({
      state: "runaway",
      product: "do_requests",
      tone: { kind: "alert" },
      line: "$1.02/h · Durable Objects requests far above normal",
      action: "pause",
    });
  });

  it("shows the product furthest above its own normal, else Worker requests", () => {
    const d = data({
      series: [
        series("a", "workers_requests", 24_000, 1_000, 1.2),
        series("a", "kv_reads", 2_400, 100, 4),
        series("a", "d1_rows_read", 2_400, 100, 12),
        series("b", "workers_requests", 72_000, 3_000, 1),
        // Above its normal, but not by enough to be the story.
        series("b", "kv_reads", 2_400, 100, 2.5),
      ],
    });
    const v = view(d);
    expect(v.cards.get("a")?.product).toBe("d1_rows_read");
    expect(v.cards.get("b")?.product).toBe("workers_requests");
  });

  it("an app running away without a product named: its costliest product", () => {
    const d = data({
      series: [...data().series, series("b", "do_requests", 0, 4_000_000)],
    });
    expect(view(d, [unusual("b", null)]).cards.get("b")?.product).toBe("do_requests");
  });

  it("an app that used up a free limit: red, the limit, and Pause", () => {
    const d = data({ plan: "free", bill: { now: 0, projected: 0 } });
    const card = view(d, [
      {
        kind: "limit-used-up",
        installId: "b",
        product: "do_requests",
        limit: 100_000,
        appShare: 0.97,
        loopSince: null,
      },
    ]).cards.get("b");
    expect(card).toMatchObject({
      state: "capped",
      tone: { kind: "alert" },
      line: "Durable Objects requests: today's free limit used up",
      action: "pause",
    });
  });

  it("a paused app: grey, and Resume", () => {
    const d = data({
      apps: [app("a"), app("b", { paused: true })],
      series: [...data().series, series("b", "do_requests", 2_000_000, 0)],
    });
    expect(view(d).cards.get("b")).toMatchObject({
      state: "paused",
      product: "do_requests",
      tone: { kind: "muted" },
      line: "Paused · no usage since",
      action: "resume",
    });
  });

  it("a brand-new app: no chart yet, and nothing to press", () => {
    const d = data({ apps: [app("a", { installedAt: NOW - 6 * 60_000 }), app("b")] });
    expect(view(d).cards.get("a")).toMatchObject({
      state: "fresh",
      points: [],
      line: "Just installed",
      action: null,
    });
  });

  it("an app with no requests today says so", () => {
    const d = data({ series: [] });
    expect(view(d).cards.get("a")?.line).toBe("No requests today");
  });
});
