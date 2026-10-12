import { describe, expect, it } from "vitest";
import {
  accountOverage,
  activityCostSeries,
  burnPerHour,
  costSeries,
  monthBill,
  productMonth,
  spendInPeriod,
} from "./cost";
import { HOUR_MS } from "./periods";
import { held, hourly, NOW, point } from "./test-series";

const MONTH_START = "2026-10-01T00:00:00Z";
const MONTH_HOURS = 30 * 24;

describe("productMonth against Cloudflare's worked examples", () => {
  const once = (value: number) => [point(MONTH_START, value)];

  it("Workers: 100M requests at 7 ms CPU each cost $27.00 + $13.40", () => {
    expect(productMonth("workers_requests", once(100e6), "paid", NOW).usd).toBeCloseTo(27);
    expect(productMonth("workers_cpu_ms", once(700e6), "paid", NOW).usd).toBeCloseTo(13.4);
  });

  it("Queues: a million messages a day for 30 days costs $35.60", () => {
    expect(productMonth("queues_operations", once(90e6), "paid", NOW).usd).toBeCloseTo(35.6);
  });

  it("Browser Run: 50 hours costs $3.60", () => {
    expect(productMonth("browser_hours", once(50), "paid", NOW).usd).toBeCloseTo(3.6);
  });

  it("Containers: memory past 25 GiB-hours bills per GiB-second", () => {
    const usd = productMonth("containers_memory", once(25 * 3_600 + 1e6), "paid", NOW).usd;
    expect(usd).toBeCloseTo(2.5);
  });
});

describe("productMonth", () => {
  it("applies Workers AI's daily allowance day by day", () => {
    const series = [point(MONTH_START, 30_000), point("2026-10-02T00:00:00Z", 5_000)];
    const month = productMonth("ai_neurons", series, "paid", NOW);
    // Only the first day passes 10,000: 20,000 neurons at $0.011 per 1,000.
    expect(month.usd).toBeCloseTo(0.22);
    expect(month.amount).toBe(35_000);
    expect(month.included).toBe(310_000);
  });

  it("projects a daily allowance at the pace for the rest of the month", () => {
    const series = hourly(24 * 14, 1_000);
    const month = productMonth("ai_neurons", series, "paid", NOW, { projected: true });
    // 24,000 a day, 14,000 past the allowance, for all 31 days of October.
    expect(month.usd).toBeCloseTo(31 * 14_000 * (0.011 / 1_000), 2);
  });

  it("turns storage held into GB-months", () => {
    const series = held(24 * 31, 20).filter((p) => p.hour >= Date.parse(MONTH_START));
    const sofar = productMonth("r2_storage", series, "paid", NOW);
    // 20 GB for 324.5 hours of a 720-hour month: under the 10 GB-months included.
    expect(sofar.amount).toBeCloseTo((20 * 324.5) / 720);
    expect(sofar.usd).toBe(0);
    const projected = productMonth("r2_storage", series, "paid", NOW, { projected: true });
    expect(projected.amount).toBeCloseTo((20 * 744) / 720);
    expect(projected.usd).toBeCloseTo(((20 * 744) / 720 - 10) * 0.015);
  });

  it("charges nothing on Free except R2, which bills past its free amount", () => {
    expect(productMonth("workers_requests", [point(MONTH_START, 100e6)], "free", NOW).usd).toBe(0);
    expect(productMonth("r2_class_a", [point(MONTH_START, 2e6)], "free", NOW).usd).toBeCloseTo(4.5);
  });

  it("leaves out last month", () => {
    const series = [point("2026-09-30T23:00:00Z", 50e6), point(MONTH_START, 1)];
    expect(productMonth("workers_requests", series, "paid", NOW).amount).toBe(1);
  });
});

describe("costSeries", () => {
  it("prices counts by value and levels by the part of a month held", () => {
    const series = costSeries(
      {
        kv_writes: [point("2026-10-14T10:00:00Z", 200_000)],
        r2_storage: [point("2026-10-14T10:00:00Z", 720), point("2026-10-14T12:00:00Z", 720)],
      },
      NOW,
    );
    // $1 of writes plus an hour of 720 GB ($0.015); then half an hour of it.
    expect(series[0]?.value).toBeCloseTo(1 + 0.015);
    expect(series[1]?.value).toBeCloseTo(0.0075);
  });

  it("leaves storage out of the activity cost", () => {
    const usage = { r2_storage: held(24, 1_000), kv_reads: hourly(24, 1e6) };
    const activity = activityCostSeries(usage, NOW);
    expect(activity.at(-2)?.value).toBeCloseTo(0.5);
  });
});

describe("spend", () => {
  // 20,000 KV writes an hour: $0.10 an hour at list price.
  const usage = { kv_writes: hourly(30 * 24, 20_000) };

  it("burns the last 60 minutes' cost", () => {
    expect(burnPerHour(usage, NOW)).toBeCloseTo(0.1);
  });

  it("spends since the period began and projects to its end", () => {
    const day = spendInPeriod(usage, "day", NOW);
    expect(day.spent).toBeCloseTo(1.25);
    expect(day.projected).toBeCloseTo(2.4);
    expect(day.resetsAt).toBe(Date.parse("2026-10-15T00:00:00Z"));
    const week = spendInPeriod(usage, "week", NOW);
    // Since Monday 00:00: 60.5 hours.
    expect(week.spent).toBeCloseTo(6.05);
  });

  it("leaves storage out of spend and burn, but not out of the bill", () => {
    // 1 TB in R2 all month: $15.36 a month, which a pause cannot stop.
    const stored = { r2_storage: held(30 * 24, 1_024) };
    expect(spendInPeriod(stored, "day", NOW).spent).toBe(0);
    expect(spendInPeriod(stored, "month", NOW).projected).toBe(0);
    expect(burnPerHour(stored, NOW)).toBe(0);
    expect(accountOverage({ a: stored }, "paid", NOW, { projected: true }).usd).toBeGreaterThan(0);
  });
});

describe("accountOverage", () => {
  it("splits each product's overage across apps by their share", () => {
    const apps = {
      a: { workers_requests: [point("2026-10-02T00:00:00Z", 9e6)] },
      b: {
        workers_requests: [point("2026-10-02T00:00:00Z", 3e6)],
        kv_reads: [point(MONTH_START, 1)],
      },
    };
    const o = accountOverage(apps, "paid", NOW);
    // 12M requests, 2M past included, $0.60.
    expect(o.usd).toBeCloseTo(0.6);
    expect(o.byProduct.workers_requests?.amount).toBe(12e6);
    expect(o.byApp.a?.usd).toBeCloseTo(0.45);
    expect(o.byApp.b?.usd).toBeCloseTo(0.15);
    expect(o.byApp.b?.byProduct.kv_reads).toBeUndefined();
  });

  it("splits so the apps add up to the total, even when their paces do not", () => {
    // A writes only in the last 3 hours, B only earlier today, C steadily: the
    // account's pace is not the sum of the apps' paces.
    const apps = {
      a: { kv_writes: hourly(MONTH_HOURS, (ago) => (ago <= 2 ? 1e6 : 0)) },
      b: { kv_writes: hourly(MONTH_HOURS, (ago) => (ago >= 6 && ago <= 10 ? 1e6 : 0)) },
      c: { kv_writes: hourly(MONTH_HOURS, 10_000) },
    };
    const o = accountOverage(apps, "paid", NOW, { projected: true });
    const parts = Object.values(o.byApp).reduce((t, app) => t + app.usd, 0);
    expect(o.usd).toBeGreaterThan(0);
    expect(parts).toBeCloseTo(o.usd, 9);
  });

  it("is zero while the account stays within included usage", () => {
    const apps = { a: { workers_requests: hourly(24, 1_000) } };
    expect(accountOverage(apps, "paid", NOW).usd).toBe(0);
    expect(accountOverage(apps, "paid", NOW).byApp.a?.usd).toBe(0);
  });

  it("projects a paused app as stopped", () => {
    // A looped at 2M requests an hour until it was paused half an hour ago.
    const looped = hourly(30 * 24, (ago) => (ago <= 0 ? 0 : ago <= 6 ? 2e6 : 1_000));
    const apps = {
      a: { workers_requests: looped },
      b: { workers_requests: hourly(30 * 24, 1_000) },
    };
    const running = accountOverage(apps, "paid", NOW, { projected: true });
    const stopped = accountOverage(apps, "paid", NOW, { projected: true, stopped: new Set(["a"]) });
    expect(stopped.usd).toBeLessThan(running.usd);
    // A: 6 loop hours and 318 normal ones. B: 1,000 an hour all month.
    expect(stopped.usd).toBeCloseTo((12e6 + 318_000 + 744 * 1_000 - 10e6) * 0.3e-6, 3);
    expect(stopped.byApp.a?.usd).toBeGreaterThan(stopped.byApp.b?.usd ?? 0);
  });
});

describe("monthBill", () => {
  it("is $5 plus usage past included on Paid, only what bills on Free", () => {
    expect(monthBill("paid", 0)).toBe(5);
    expect(monthBill("paid", 2.5)).toBe(7.5);
    expect(monthBill("free", 0)).toBe(0);
    expect(monthBill("free", 1)).toBe(1);
  });
});

it("ignores hours after now", () => {
  const usage = { kv_writes: [point("2026-10-14T14:00:00Z", 1e6)] };
  expect(spendInPeriod(usage, "day", NOW).spent).toBe(0);
  // At 15:30, the last 60 minutes hold the second half of 14:00's $5.
  expect(burnPerHour(usage, NOW + 3 * HOUR_MS)).toBeCloseTo(2.5);
});
