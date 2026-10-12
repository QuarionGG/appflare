import { describe, expect, it } from "vitest";
import { accountOverage, spendInPeriod } from "./cost";
import {
  alarmLoop,
  budgetReached,
  capStatus,
  freeDailyShare,
  type LoopLevel,
  loopCheck,
  nextLoopStreak,
  nextToPauseForBudget,
  shareOfAllowance,
  type UsageAlertRule,
  unusualUsage,
  usageAlertStatus,
} from "./rules";
import type { Usage } from "./series";
import { held, hourly, NOW } from "./test-series";

const MONTH = 30 * 24;
/** `before` per hour, then `after` per hour for the last 2.5 hours (09:30 onward is 3). */
const jump = (before: number, after: number) => hourly(MONTH, (ago) => (ago <= 2 ? after : before));

const trips = (usage: Usage, level: LoopLevel, plan: "free" | "paid" = "paid") =>
  loopCheck({ plan, level, usage, now: NOW }).trips;

describe("loopCheck on Paid", () => {
  // A status page app: one Durable Object alarm a few seconds apart, two rows
  // written per alarm, until an update makes the alarm fire in a tight loop.
  const calm = { do_requests: 1_440, do_rows_written: 2_880, workers_requests: 250 };

  it("trips every level for an alarm loop: ~5M requests and ~10M rows an hour", () => {
    const usage = {
      do_requests: jump(calm.do_requests, 5e6),
      do_rows_written: jump(calm.do_rows_written, 10e6),
      workers_requests: hourly(MONTH, calm.workers_requests),
    };
    const check = loopCheck({ plan: "paid", level: "relaxed", usage, now: NOW });
    // $0.75 of requests and $10 of rows written an hour.
    expect(check.burn).toBeCloseTo(10.75, 1);
    // Its normal hour is about $0.003: this is some 3,400× it.
    expect(check.ratio).toBeGreaterThan(3_000);
    for (const level of ["relaxed", "standard", "strict"] as const) {
      expect(trips(usage, level), level).toBe(true);
    }
  });

  it("needs the money: 5M Durable Objects requests alone ($0.75/h) trip only Strict", () => {
    const usage = { do_requests: jump(calm.do_requests, 5e6) };
    const check = loopCheck({ plan: "paid", level: "standard", usage, now: NOW });
    expect(check.burn).toBeCloseTo(0.75);
    expect(check.abnormal).toBe(true);
    expect(check.money).toBe(false);
    expect(trips(usage, "strict")).toBe(true);
    expect(trips(usage, "standard")).toBe(false);
    expect(trips(usage, "relaxed")).toBe(false);
  });

  it("does not trip for a tiny app at 100× its normal", () => {
    // 100 requests an hour jumping to 10,000: $0.003 an hour.
    const usage = { workers_requests: jump(100, 10_000) };
    for (const level of ["relaxed", "standard", "strict"] as const) {
      const check = loopCheck({ plan: "paid", level, usage, now: NOW });
      expect(check.ratio).toBeCloseTo(100);
      expect(check.trips, level).toBe(false);
    }
  });

  it("does not trip for a busy app at its usual level", () => {
    // 10M requests an hour, $3 an hour, every hour.
    expect(trips({ workers_requests: hourly(MONTH, 10e6) }, "strict")).toBe(false);
  });

  it("applies each level's factor", () => {
    // Normal $0.05/h of KV writes.
    const at40x = { kv_writes: jump(10_000, 400_000) }; // $2/h
    expect(trips(at40x, "strict")).toBe(true);
    expect(trips(at40x, "standard")).toBe(false);
    const at60x = { kv_writes: jump(10_000, 600_000) }; // $3/h
    expect(trips(at60x, "standard")).toBe(true);
    expect(trips(at60x, "relaxed")).toBe(false);
    const at120x = { kv_writes: jump(10_000, 1_200_000) }; // $6/h
    expect(trips(at120x, "relaxed")).toBe(true);
  });

  it("leaves storage out of the comparison", () => {
    const usage = {
      kv_writes: jump(10_000, 600_000),
      r2_storage: hourly(MONTH, 50_000).map((p) => ({ ...p, value: 50_000 })),
    };
    expect(loopCheck({ plan: "paid", level: "standard", usage, now: NOW }).burn).toBeCloseTo(3);
  });

  it("lets the money decide for an app with no normal yet: pauses on two checks", () => {
    // Installed 5 hours ago, writing $3 of KV an hour since.
    const at = (now: number) => ({
      plan: "paid" as const,
      level: "standard" as const,
      usage: { kv_writes: hourly(5, 600_000, now) },
      now,
    });
    const first = loopCheck(at(NOW));
    expect(first.normal).toBeNull();
    expect(first.ratio).toBeNull();
    expect(first.trips).toBe(true);
    const second = loopCheck(at(NOW + 5 * 60_000));
    expect(second.ratio).toBeNull();
    const streak = nextLoopStreak(nextLoopStreak(0, first.trips).streak, second.trips);
    expect(streak).toEqual({ streak: 2, pause: true });
    // Under the money bar, a new app does not trip.
    const small = { ...at(NOW), usage: { kv_writes: hourly(5, 100_000) } };
    expect(loopCheck(small).trips).toBe(false);
  });

  it("leaves a daily batch job alone at its usual size", () => {
    // One batch a day at 12:00, $5 of KV writes, idle the other 23 hours.
    const now = Date.parse("2026-10-14T13:00:00Z");
    const batch = (today: number) => ({
      kv_writes: hourly(MONTH, (ago) => (ago === 1 ? today : ago % 24 === 1 ? 1e6 : 0), now),
    });
    const usual = batch(1e6);
    const check = loopCheck({ plan: "paid", level: "strict", usage: usual, now });
    expect(check.normal).toBeCloseTo(5);
    expect(check.ratio).toBeCloseTo(1);
    expect(check.trips).toBe(false);
    expect(unusualUsage({ plan: "paid", setting: 5, usage: usual, now })).toBeNull();
    // Ten times its usual batch is unusual.
    const tenfold = batch(1e7);
    expect(unusualUsage({ plan: "paid", setting: 5, usage: tenfold, now })?.ratio).toBeCloseTo(10);
  });

  it("takes one Durable Object past 3,600 alarms an hour as abnormal", () => {
    // $2 an hour, every hour: busy but normal.
    const busy = { kv_writes: hourly(MONTH, 400_000) };
    const looping = [
      { object: "a", alarms: 200 },
      { object: "b", alarms: 5_000 },
    ];
    const base = { plan: "paid" as const, level: "standard" as const, now: NOW };
    expect(loopCheck({ ...base, usage: busy }).trips).toBe(false);
    const check = loopCheck({ ...base, usage: busy, objectAlarms: looping });
    expect(check.alarmLoop).toEqual({ object: "b", alarms: 5_000 });
    expect(check.trips).toBe(true);
    // Still needs the money.
    const tiny = { kv_writes: hourly(MONTH, 10) };
    expect(loopCheck({ ...base, usage: tiny, objectAlarms: looping }).trips).toBe(false);
  });
});

describe("loopCheck on Free", () => {
  it("measures the money as the share of a free daily limit on pace for today", () => {
    // 50 requests an hour, then 3,000 an hour since 09:30: on pace for ~37%
    // of the 100,000 free daily requests.
    const usage = { workers_requests: jump(50, 3_000) };
    const check = loopCheck({ plan: "free", level: "standard", usage, now: NOW });
    expect(check.freeShare?.product).toBe("workers_requests");
    expect(check.freeShare?.share).toBeCloseTo(0.37, 1);
    expect(check.trips).toBe(true);
    expect(trips(usage, "relaxed", "free")).toBe(false);
  });

  it("trips every level for a Durable Object loop that would use up the day", () => {
    const usage = { do_requests: jump(100, 20_000) };
    for (const level of ["relaxed", "standard", "strict"] as const) {
      expect(trips(usage, level, "free"), level).toBe(true);
    }
  });

  it("does not trip for a tiny app at 100× its normal", () => {
    // 1 request an hour, then 100: on pace for about 1% of the free limit.
    expect(trips({ workers_requests: jump(1, 100) }, "strict", "free")).toBe(false);
  });

  it("counts R2's dollars, which bill even on Free", () => {
    const usage = { r2_class_a: jump(10, 1e6) }; // $4.50 an hour
    expect(trips(usage, "standard", "free")).toBe(true);
    expect(trips(usage, "relaxed", "free")).toBe(false);
  });
});

describe("nextLoopStreak", () => {
  it("pauses on the second check in a row, and a clean check resets it", () => {
    const first = nextLoopStreak(0, true);
    expect(first).toEqual({ streak: 1, pause: false });
    const second = nextLoopStreak(first.streak, true);
    expect(second).toEqual({ streak: 2, pause: true });
    expect(nextLoopStreak(1, false)).toEqual({ streak: 0, pause: false });
    expect(nextLoopStreak(nextLoopStreak(1, false).streak, true).pause).toBe(false);
  });
});

describe("alarmLoop", () => {
  it("is the busiest object strictly past 3,600 alarms", () => {
    expect(alarmLoop([{ object: "a", alarms: 3_600 }])).toBeNull();
    expect(
      alarmLoop([
        { object: "a", alarms: 4_000 },
        { object: "b", alarms: 9_000 },
      ]),
    ).toEqual({ object: "b", alarms: 9_000 });
    expect(alarmLoop([])).toBeNull();
  });
});

describe("unusualUsage", () => {
  const paid = (usage: Usage, setting: 5 | 20 | 100 | "off") =>
    unusualUsage({ plan: "paid", setting, usage, now: NOW });

  it("alerts on Paid when an hour is past the factor and costs $0.05", () => {
    // KV reads: 1,000 an hour, then 110,000 ($0.055).
    const usage = { kv_reads: jump(1_000, 110_000) };
    const found = paid(usage, 20);
    expect(found?.product).toBe("kv_reads");
    expect(found?.ratio).toBeCloseTo(110);
    expect(found?.usd).toBeCloseTo(0.055);
    expect(paid(usage, 100)).not.toBeNull();
    expect(paid(usage, "off")).toBeNull();
  });

  it("stays quiet on Paid under $0.05 an hour, however far above normal", () => {
    expect(paid({ kv_reads: jump(1_000, 50_000) }, 5)).toBeNull();
    expect(paid({ workers_requests: jump(10, 100_000) }, 5)).toBeNull();
  });

  it("respects the factor", () => {
    // 10× normal at $0.25/h.
    const usage = { kv_reads: jump(50_000, 500_000) };
    expect(paid(usage, 5)?.ratio).toBeCloseTo(10);
    expect(paid(usage, 20)).toBeNull();
  });

  it("on Free needs 5% of a free daily limit in the hour", () => {
    const free = (usage: Usage, setting: 5 | 20 | 100) =>
      unusualUsage({ plan: "free", setting, usage, now: NOW });
    // 100 requests an hour, then 5,000: 5% of 100,000, 50× normal.
    expect(free({ workers_requests: jump(100, 5_000) }, 20)?.product).toBe("workers_requests");
    expect(free({ workers_requests: jump(100, 5_000) }, 100)).toBeNull();
    expect(free({ workers_requests: jump(10, 4_000) }, 5)).toBeNull();
  });

  it("names the product furthest above its normal", () => {
    const usage = {
      kv_reads: jump(1_000, 200_000),
      do_requests: jump(1_440, 5e6),
    };
    expect(paid(usage, 20)?.product).toBe("do_requests");
  });
});

describe("usageAlertStatus", () => {
  // $0.10 an hour of KV writes: $1.25 by 12:30, on pace for $2.40 today.
  const usage = { kv_writes: hourly(MONTH, 20_000) };
  const status = (rule: UsageAlertRule, plan: "free" | "paid" = "paid", u: Usage = usage) =>
    usageAlertStatus({ plan, rule, usage: u, now: NOW });
  const usd = (kind: "spent" | "pace", amount: number, period: "day" | "week" | "month" = "day") =>
    status({ kind, unit: "usd", amount, period });
  const pct = (kind: "spent" | "pace", amount: number, period: "day" | "week" | "month" = "day") =>
    status({ kind, unit: "pct", amount, period });

  it("compares dollars spent", () => {
    expect(usd("spent", 1).state).toBe("fired");
    expect(usd("spent", 1).value).toBeCloseTo(1.25);
    expect(usd("spent", 1.5).state).toBe("on_pace");
    expect(usd("spent", 3).state).toBe("watching");
  });

  it("compares dollars on pace", () => {
    expect(usd("pace", 2).state).toBe("fired");
    expect(usd("pace", 2).value).toBeCloseTo(2.4);
    // 2.40 is at least 80% of 2.90.
    const close = usd("pace", 2.9);
    expect(close).toMatchObject({ fired: false, onPace: false, near: true, state: "near" });
    expect(usd("pace", 4).state).toBe("watching");
  });

  it("measures each period from its own start", () => {
    // Since Monday 00:00: 60.5 hours; since October 1: 324.5 hours.
    expect(usd("spent", 6, "week").spent).toBeCloseTo(6.05);
    expect(usd("spent", 6, "week").fired).toBe(true);
    expect(usd("spent", 40, "month").spent).toBeCloseTo(32.45);
    expect(usd("pace", 70, "month").projected).toBeCloseTo(74.4);
  });

  it("compares a percent of included usage for the most-used product", () => {
    // 250,000 of the 1M KV writes included a month; 480,000 on pace today.
    const spent = pct("spent", 30);
    expect(spent.product).toBe("kv_writes");
    expect(spent.spent).toBeCloseTo(25);
    expect(spent.projected).toBeCloseTo(48);
    expect(spent.state).toBe("on_pace");
    expect(pct("pace", 40).state).toBe("fired");
    expect(pct("pace", 55).state).toBe("near");
    expect(pct("spent", 50).state).toBe("watching");
    expect(pct("spent", 500, "month").fired).toBe(true);
  });

  it("on Free compares a percent of a free daily limit", () => {
    const requests = { workers_requests: hourly(MONTH, 2_000) };
    const s = status({ kind: "spent", unit: "pct", amount: 20, period: "day" }, "free", requests);
    expect(s.product).toBe("workers_requests");
    expect(s.spent).toBeCloseTo(25);
    expect(s.projected).toBeCloseTo(48);
    expect(s.fired).toBe(true);
  });

  it("never fires without an amount", () => {
    expect(usd("spent", 0)).toMatchObject({ fired: false, onPace: false, near: false });
  });
});

describe("shares", () => {
  it("counts a daily allowance once per day of the period", () => {
    const usage = { ai_neurons: hourly(MONTH, 1_000) };
    // This week: 60,500 neurons of 7 × 10,000.
    expect(shareOfAllowance(usage, "paid", "week", NOW)?.share).toBeCloseTo(60_500 / 70_000);
  });

  it("skips products without an allowance on the plan", () => {
    const usage = { containers_cpu: hourly(MONTH, 100) };
    expect(shareOfAllowance(usage, "free", "day", NOW)).toBeNull();
    expect(freeDailyShare(usage, NOW)).toBeNull();
  });

  it("picks the product closest to its free daily limit", () => {
    const usage = { workers_requests: hourly(MONTH, 2_000), kv_writes: hourly(MONTH, 40) };
    // Requests at 25%, KV writes at 50% of 1,000 a day.
    expect(freeDailyShare(usage, NOW)).toEqual({ product: "kv_writes", share: 0.5 });
  });
});

describe("capStatus", () => {
  // $0.125 an hour.
  const usage = { kv_writes: hourly(MONTH, 25_000) };

  it("passes the cap in the hour the spend reaches it", () => {
    const cap = capStatus({ usage, cap: 1.01, period: "day", now: NOW });
    expect(cap.passed).toBe(true);
    expect(cap.passedAt).toBe(Date.parse("2026-10-14T08:00:00Z"));
    expect(cap.resetsAt).toBe(Date.parse("2026-10-15T00:00:00Z"));
  });

  it("reports the pace toward a cap not passed yet", () => {
    const cap = capStatus({ usage, cap: 2, period: "day", now: NOW });
    expect(cap).toMatchObject({ passed: false, passedAt: null, cap: 2 });
    expect(cap.projected).toBeCloseTo(3);
  });

  it("is never passed with no cap", () => {
    expect(capStatus({ usage, cap: 0, period: "day", now: NOW }).passed).toBe(false);
  });

  it("leaves storage out, or a resume would be paused again at once", () => {
    // 1 TB in R2 (about $0.51 a day) under a $0.20 daily cap, no activity.
    const stored = { r2_storage: held(MONTH, 1_024) };
    const cap = capStatus({ usage: stored, cap: 0.2, period: "day", now: NOW });
    expect(cap).toMatchObject({ passed: false, passedAt: null, spent: 0, projected: 0 });
  });
});

describe("budget", () => {
  it("is reached when the projected bill meets it", () => {
    expect(budgetReached(50, 50)).toBe(true);
    expect(budgetReached(49.99, 50)).toBe(false);
    expect(budgetReached(500, 0)).toBe(false);
  });

  it("pauses the largest part of the overage that is neither exempt nor paused", () => {
    const apps = [
      { id: "files", overageUsd: 4, exempt: false, paused: false },
      { id: "journal", overageUsd: 30, exempt: true, paused: false },
      { id: "status", overageUsd: 20, exempt: false, paused: true },
      { id: "links", overageUsd: 8, exempt: false, paused: false },
      { id: "forms", overageUsd: 8, exempt: false, paused: false },
    ];
    expect(nextToPauseForBudget(apps)).toBe("forms");
    expect(nextToPauseForBudget(apps.filter((a) => a.id !== "forms"))).toBe("links");
  });

  it("ranks by overage, not list price, so a pause lowers the bill", () => {
    // A: $20 at list price, all D1 reads within the 25B included.
    // B: $15 at list price, 3M KV writes, $10 past the 1M included.
    // C: exempt, $25 past included KV reads; counts toward the bill.
    const at = "2026-10-02T00:00:00Z";
    const usage: Record<string, Usage> = {
      a: { d1_rows_read: [{ hour: Date.parse(at), value: 20e9 }] },
      b: { kv_writes: [{ hour: Date.parse(at), value: 3e6 }] },
      c: { kv_reads: [{ hour: Date.parse(at), value: 60e6 }] },
    };
    expect(spendInPeriod(usage.a ?? {}, "month", NOW).spent).toBeCloseTo(20);
    expect(spendInPeriod(usage.b ?? {}, "month", NOW).spent).toBeCloseTo(15);
    const overage = accountOverage(usage, "paid", NOW, { projected: true });
    expect(overage.usd).toBeCloseTo(35);
    const candidates = Object.keys(usage).map((id) => ({
      id,
      overageUsd: overage.byApp[id]?.usd ?? 0,
      exempt: id === "c",
      paused: false,
    }));
    expect(nextToPauseForBudget(candidates)).toBe("b");
  });

  it("has no one left to pause when every app is exempt or within included usage", () => {
    expect(
      nextToPauseForBudget([
        { id: "journal", overageUsd: 30, exempt: true, paused: false },
        { id: "idle", overageUsd: 0, exempt: false, paused: false },
      ]),
    ).toBeNull();
  });
});
