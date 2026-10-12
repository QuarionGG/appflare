import { describe, expect, it } from "vitest";
import type { AccountPlan } from "../account/plan";
import {
  alertRuleSentence,
  type Decisions,
  type EvaluateInput,
  evaluate,
  type WatchedAppInput,
} from "./evaluate";
import { DAY_MS, dayStart, HOUR_MS, periodStart, type Usage } from "./math";
import { hourly, NOW } from "./math/test-series";
import type { AlertRule } from "./store/alert-rules.server";
import {
  type AppSpendSettings,
  DEFAULT_SPEND_DEFAULTS,
  defaultAppSpendSettings,
  resolveSpendSettings,
  type SpendDefaults,
} from "./store/spend-settings";
import { initialUsageState, type UsageState } from "./store/usage-state.server";

const TEN_DAYS = 10 * 24;
const INSTALLED = NOW - 30 * DAY_MS;

/** Calm for ten days, then `loud` an hour for the last `loudHours` hours. */
function jump(calm: number, loud: number, loudHours = 2) {
  return hourly(TEN_DAYS, (ago) => (ago < loudHours ? loud : calm));
}

/** An alarm loop on Paid: about $10.75 an hour where the normal is a fraction of a cent. */
const LOOPING: Usage = {
  do_requests: jump(1_440, 5e6),
  do_rows_written: jump(2_880, 10e6),
};
const CALM: Usage = {
  do_requests: hourly(TEN_DAYS, 1_440),
  do_rows_written: hourly(TEN_DAYS, 2_880),
};

function settings(
  installId: string,
  app: Partial<AppSpendSettings> = {},
  defaults: Partial<SpendDefaults> = {},
) {
  return resolveSpendSettings(
    { ...DEFAULT_SPEND_DEFAULTS, ...defaults },
    { ...defaultAppSpendSettings(installId), ...app },
  );
}

function app(installId: string, over: Partial<WatchedAppInput> = {}): WatchedAppInput {
  return {
    installId,
    installedAt: INSTALLED,
    usage: CALM,
    settings: settings(installId),
    state: initialUsageState(installId),
    paused: false,
    objectAlarms: [],
    rules: [],
    ...over,
  };
}

function run(
  apps: WatchedAppInput[],
  over: Partial<Omit<EvaluateInput, "apps">> & { plan?: AccountPlan } = {},
): Decisions {
  return evaluate({
    now: NOW,
    plan: "paid",
    apps,
    accountUsage: new Map(apps.map((a) => [a.installId, a.usage])),
    budget: null,
    budgetToldThisMonth: false,
    limitSharesToday: new Map(),
    ...over,
  });
}

/** The state a check left, as the next check reads it. */
function stateAfter(d: Decisions, installId: string): UsageState {
  const s = d.states.find((x) => x.installId === installId);
  if (s === undefined) throw new Error(`no state for ${installId}`);
  return { ...s, lastCheckedAt: NOW };
}

const onAuto = (id: string, app: Partial<AppSpendSettings> = {}) =>
  settings(id, { autoPause: "on", ...app });

describe("unusual usage", () => {
  it("opens an episode once, with the facts Home and the message need", () => {
    const first = run([app("a", { usage: LOOPING })]);
    expect(first.activities).toEqual([
      {
        installId: "a",
        kind: "unusual_started",
        facts: expect.objectContaining({
          factor: 20,
          times: expect.any(Number),
          product: "do_requests",
          perHour: expect.any(Number),
          burnPerHour: expect.any(Number),
          spentToday: expect.any(Number),
        }),
      },
    ]);
    expect(first.activities[0]?.facts).not.toHaveProperty("freeShare");
    expect(first.events).toEqual([
      expect.objectContaining({ type: "usage_unusual", installId: "a", since: NOW, factor: 20 }),
    ]);
    expect(stateAfter(first, "a").unusualSince).toBe(NOW);

    const second = run([app("a", { usage: LOOPING, state: stateAfter(first, "a") })]);
    expect(second.activities).toEqual([]);
    expect(second.events).toEqual([]);
    expect(stateAfter(second, "a").unusualSince).toBe(NOW);
  });

  it("closes the episode once usage is back near normal", () => {
    const open = { ...initialUsageState("a"), unusualSince: NOW - HOUR_MS };
    const d = run([app("a", { state: open })]);
    expect(d.activities).toEqual([
      { installId: "a", kind: "unusual_ended", facts: { startedAt: NOW - HOUR_MS } },
    ]);
    expect(stateAfter(d, "a").unusualSince).toBeNull();
  });

  it("keeps an episode open through a check that could not read everything", () => {
    const open = { ...initialUsageState("a"), unusualSince: NOW - HOUR_MS };
    const d = run([app("a", { state: open, incomplete: true })]);
    expect(d.activities).toEqual([]);
    expect(stateAfter(d, "a").unusualSince).toBe(NOW - HOUR_MS);
  });

  it("keeps an episode open while usage stays above half the factor", () => {
    const open = { ...initialUsageState("a"), unusualSince: NOW - HOUR_MS };
    // 15× its normal: not unusual at 20×, but not back either.
    const d = run([app("a", { state: open, usage: { do_rows_written: jump(1e5, 1.5e6) } })]);
    expect(d.activities).toEqual([]);
    expect(stateAfter(d, "a").unusualSince).toBe(NOW - HOUR_MS);
  });

  it("does not alert when the app's alert is off", () => {
    const d = run([app("a", { usage: LOOPING, settings: settings("a", { unusualFactor: 0 }) })]);
    expect(d.events).toEqual([]);
  });

  it("records the share of the free daily limit on Free", () => {
    const usage = { workers_requests: jump(100, 20_000) };
    const d = run([app("a", { usage })], { plan: "free" });
    const started = d.activities.find((a) => a.kind === "unusual_started");
    expect(started?.facts).toHaveProperty("freeShare");
  });
});

describe("usage alert rules", () => {
  const rule = (over: Partial<AlertRule> = {}): AlertRule => ({
    id: "r1",
    installId: "a",
    kind: "spent",
    unit: "usd",
    amount: 1,
    period: "day",
    createdAt: 0,
    createdBy: "u",
    lastFiring: null,
    ...over,
  });

  it("fires a rule that holds, once per period, with its sentence", () => {
    const d = run([app("a", { usage: LOOPING, rules: [rule()] })]);
    const today = dayStart(NOW) / 1000;
    expect(d.firings).toEqual([
      expect.objectContaining({
        ruleId: "r1",
        periodStart: today,
        activity: expect.objectContaining({
          kind: "alert_sent",
          facts: expect.objectContaining({ sentence: "When it has spent $1.00 today", amount: 1 }),
        }),
        event: expect.objectContaining({ type: "usage_alert", periodStart: today }),
      }),
    ]);
    const fired = rule({ lastFiring: { periodStart: today, firedAt: NOW, value: 2 } });
    expect(run([app("a", { usage: LOOPING, rules: [fired] })]).firings).toEqual([]);
    // Yesterday's firing does not count today.
    const yesterday = rule({ lastFiring: { periodStart: today - 86_400, firedAt: 0, value: 2 } });
    expect(run([app("a", { usage: LOOPING, rules: [yesterday] })]).firings).toHaveLength(1);
  });

  it("does not fire a rule that does not hold", () => {
    expect(run([app("a", { rules: [rule({ amount: 100 })] })]).firings).toEqual([]);
  });

  it("words rules as the settings show them", () => {
    expect(
      alertRuleSentence({ kind: "pace", unit: "usd", amount: 6, period: "month" }, "paid"),
    ).toBe("When it is on pace to spend $6.00 by the end of the month");
    expect(
      alertRuleSentence({ kind: "spent", unit: "pct", amount: 80, period: "day" }, "free"),
    ).toBe("When it has used 80% of a free daily limit today");
    expect(
      alertRuleSentence({ kind: "pace", unit: "pct", amount: 50, period: "week" }, "paid"),
    ).toBe("When it is on pace to use 50% of included usage by the end of the week");
  });
});

describe("loop check", () => {
  const strict = (id: string, over: Partial<AppSpendSettings> = {}) =>
    onAuto(id, { customTriggers: true, loopOn: true, loopLevel: "strict", ...over });

  it("pauses only on the second check in a row that trips", () => {
    const first = run([app("a", { usage: LOOPING, settings: strict("a") })]);
    expect(stateAfter(first, "a").loopChecks).toBe(1);
    expect(first.pauses).toEqual([]);

    const second = run([
      app("a", { usage: LOOPING, settings: strict("a"), state: stateAfter(first, "a") }),
    ]);
    expect(stateAfter(second, "a").loopChecks).toBe(2);
    expect(second.pauses).toEqual([
      {
        installId: "a",
        reason: "loop",
        detail: expect.objectContaining({ level: "strict", plan: "paid", alarms: null }),
      },
    ]);
    expect(second.pauses[0]?.detail).toHaveProperty(
      "burnPerHour",
      stateAfter(second, "a").lastBurn,
    );
  });

  it("starts the streak over after a calm check", () => {
    const state = { ...initialUsageState("a"), loopChecks: 1 };
    const d = run([app("a", { settings: strict("a"), state })]);
    expect(stateAfter(d, "a").loopChecks).toBe(0);
    expect(d.pauses).toEqual([]);
  });

  it("counts the streak but does not pause with auto-pause off", () => {
    const state = { ...initialUsageState("a"), loopChecks: 1 };
    const d = run([app("a", { usage: LOOPING, state })]);
    expect(stateAfter(d, "a").loopChecks).toBe(2);
    expect(d.pauses).toEqual([]);
  });

  it("trips on one object's alarm loop, naming the alarms", () => {
    // Expensive but not abnormal by cost (no normal history): the alarms make it abnormal.
    const usage = { do_requests: hourly(TEN_DAYS, 2e6) };
    const state = { ...initialUsageState("a"), loopChecks: 1 };
    const d = run([
      app("a", {
        usage,
        state,
        settings: strict("a"),
        objectAlarms: [{ object: "ns1", alarms: 40_000 }],
      }),
    ]);
    expect(d.pauses[0]?.detail).toEqual(expect.objectContaining({ alarms: 40_000 }));
  });

  it("holds off pausing an app whose pause failed within the hour, keeping its streak", () => {
    const state = { ...initialUsageState("a"), loopChecks: 1 };
    const d = run([
      app("a", { usage: LOOPING, settings: strict("a"), state, pauseFailedRecently: true }),
    ]);
    expect(d.pauses).toEqual([]);
    expect(stateAfter(d, "a").loopChecks).toBe(2);
  });

  it("keeps the streak through a check that could not read everything", () => {
    const state = { ...initialUsageState("a"), loopChecks: 1 };
    const d = run([app("a", { settings: strict("a"), state, incomplete: true })]);
    expect(stateAfter(d, "a").loopChecks).toBe(1);
  });

  it("never pauses a paused app, and starts its streak over", () => {
    const state = { ...initialUsageState("a"), loopChecks: 1 };
    const d = run([app("a", { usage: LOOPING, settings: strict("a"), state, paused: true })]);
    expect(d.pauses).toEqual([]);
    expect(stateAfter(d, "a").loopChecks).toBe(0);
  });
});

describe("spending cap", () => {
  const capped = (id: string, over: Partial<AppSpendSettings> = {}) =>
    onAuto(id, {
      customTriggers: true,
      loopOn: false,
      capOn: true,
      capAmount: 5,
      capPeriod: "day",
      ...over,
    });

  it("pauses an app past its cap", () => {
    const d = run([app("a", { usage: LOOPING, settings: capped("a") })]);
    expect(d.pauses).toEqual([
      {
        installId: "a",
        reason: "cap",
        detail: { amount: 5, period: "day", spent: expect.any(Number) },
      },
    ]);
  });

  it("respects a cap set aside until it resets", () => {
    const aside = capped("a", { capSetAsideUntil: NOW + HOUR_MS });
    expect(run([app("a", { usage: LOOPING, settings: aside })]).pauses).toEqual([]);
    const expired = capped("a", { capSetAsideUntil: NOW - HOUR_MS });
    expect(run([app("a", { usage: LOOPING, settings: expired })]).pauses).toHaveLength(1);
  });

  it("has no dollar cap on Free", () => {
    expect(
      run([app("a", { usage: LOOPING, settings: capped("a") })], { plan: "free" }).pauses,
    ).toEqual([]);
  });
});

describe("monthly budget", () => {
  const monthHours = (NOW - periodStart("month", NOW)) / HOUR_MS + 1;
  const busy = (perHour: number): Usage => ({ workers_requests: hourly(monthHours, perHour) });

  it("pauses the app with the largest share of the overage, even with auto-pause off", () => {
    const d = run([app("small", { usage: busy(5e5) }), app("big", { usage: busy(1e6) })], {
      budget: 20,
    });
    expect(d.budgetPause).toEqual({
      installId: "big",
      reason: "budget",
      detail: { budget: 20, projected: expect.any(Number) },
    });
    expect(d.activities).toEqual([
      {
        installId: null,
        kind: "budget_reached",
        facts: expect.objectContaining({
          budget: 20,
          monthStart: periodStart("month", NOW) / 1000,
        }),
      },
    ]);
    expect(d.events).toEqual([expect.objectContaining({ type: "budget_reached", budget: 20 })]);
  });

  it("skips exempt and paused apps, and tells the budget once a month", () => {
    const d = run(
      [
        app("big", { usage: busy(1e6), settings: settings("big", { budgetExempt: true }) }),
        app("mid", { usage: busy(8e5), paused: true }),
        app("small", { usage: busy(5e5) }),
      ],
      { budget: 20, budgetToldThisMonth: true },
    );
    expect(d.budgetPause?.installId).toBe("small");
    expect(d.activities).toEqual([]);
    expect(d.events).toEqual([]);
  });

  it("does nothing under the budget, off, or on Free", () => {
    const apps = [app("a", { usage: busy(1e6) })];
    expect(run(apps, { budget: 100_000 }).budgetPause).toBeNull();
    expect(run(apps, { budget: null }).budgetPause).toBeNull();
    expect(run(apps, { budget: 20, plan: "free" }).budgetPause).toBeNull();
  });

  it("goes past an app whose pause failed within the hour", () => {
    const d = run(
      [
        app("big", { usage: busy(1e6), pauseFailedRecently: true }),
        app("small", { usage: busy(5e5) }),
      ],
      { budget: 20 },
    );
    expect(d.budgetPause?.installId).toBe("small");
  });
});

describe("free daily limits", () => {
  // 100,000 Worker requests a day; 6,000 an hour runs out late today.
  const today = dayStart(NOW) / 1000;
  const apps = () => [
    app("a", { usage: { workers_requests: hourly(TEN_DAYS, 4_500) } }),
    app("b", { usage: { workers_requests: hourly(TEN_DAYS, 1_500) } }),
  ];

  it("tells about the app using most of a limit about to run out, once a day", () => {
    const d = run(apps(), { plan: "free" });
    const near = d.activities.filter((a) => a.kind === "limit_near");
    expect(near).toEqual([
      {
        installId: "a",
        kind: "limit_near",
        facts: {
          product: "workers_requests",
          share: expect.any(Number),
          runsOutAt: expect.any(Number),
          appShare: 0.75,
        },
      },
    ]);
    expect(near[0]?.facts.share).toBeLessThan(1);
    expect(d.events.filter((e) => e.type === "usage_limit_near")).toHaveLength(1);
    expect(stateAfter(d, "a").limitWarnedDay).toBe(today);

    const warned = { ...initialUsageState("a"), limitWarnedDay: today };
    const [a, b] = apps();
    if (a === undefined || b === undefined) throw new Error("two apps");
    const again = run([{ ...a, state: warned }, b], { plan: "free" });
    expect(again.activities.filter((a) => a.kind === "limit_near")).toEqual([]);
  });

  it("records once more when the limit actually runs out, without a second message", () => {
    const warned = { ...initialUsageState("a"), limitWarnedDay: today };
    const loud = app("a", { usage: { workers_requests: hourly(TEN_DAYS, 9_000) }, state: warned });
    const d = run([loud], { plan: "free", limitSharesToday: new Map([["a", 0.8]]) });
    expect(d.activities).toEqual([
      expect.objectContaining({
        kind: "limit_near",
        facts: expect.objectContaining({ runsOutAt: null }),
      }),
    ]);
    const usedUp = d.activities[0];
    expect(usedUp?.kind === "limit_near" && usedUp.facts.share).toBeGreaterThanOrEqual(1);
    expect(d.events).toEqual([]);
    // Already recorded as used up today: nothing more.
    expect(
      run([loud], { plan: "free", limitSharesToday: new Map([["a", 1.1]]) }).activities,
    ).toEqual([]);
  });

  it("does not warn on Paid", () => {
    expect(run(apps()).activities).toEqual([]);
  });
});
