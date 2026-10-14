import { describe, expect, it } from "vitest";
import { DAY_MS } from "./math";
import { hourly, NOW } from "./math/test-series";
import {
  type SpendSnapshot,
  snapshotText,
  spendSnapshot,
  spendSnapshotSchema,
} from "./overview.server";
import { checkInputSchema, parseCheckInput } from "./watcher-check.server";
import { parseShardInput, shardInputSchema } from "./watcher-shard.server";
import {
  type SpendWatchStatus,
  spendWatchStatusSchema,
  statusText,
  storedAccountDay,
} from "./watcher-status";

/**
 * The scheduled check validates what it builds itself without Zod (whose
 * first parse in an isolate costs milliseconds of a Workers Free run); these
 * hold each check to the schema the readers use.
 */

const throws = (f: () => unknown) => {
  try {
    f();
    return false;
  } catch {
    return true;
  }
};

describe("snapshotText", () => {
  const snapshot = spendSnapshot({
    plan: "paid",
    now: NOW,
    usage: new Map([
      ["a", { workers_requests: hourly(20 * 24, (ago) => (ago < 2 ? 4e7 : 3e5)) }],
      ["b", { r2_class_a: hourly(3 * 24, 9e4), d1_storage: hourly(3 * 24, 2) }],
    ]),
    installs: [
      { installId: "a", installedAt: NOW - 30 * DAY_MS },
      { installId: "b", installedAt: NOW - DAY_MS },
      { installId: "c", installedAt: NOW - 60_000 },
    ],
    paused: new Set(["b"]),
  });

  it("stores what the schema stores", () => {
    expect(snapshot.apps.some((a) => a.ratio === null)).toBe(true);
    expect(snapshotText(snapshot)).toBe(JSON.stringify(spendSnapshotSchema.parse(snapshot)));
    const { stopped: _, ...older } = snapshot;
    expect(snapshotText(older)).toBe(JSON.stringify(spendSnapshotSchema.parse(older)));
  });

  it("leaves out keys the schema does not know", () => {
    const extra = {
      ...snapshot,
      extra: 1,
      apps: snapshot.apps.map((a) => ({ ...a, label: "x" })),
    } as SpendSnapshot;
    expect(snapshotText(extra)).toBe(JSON.stringify(spendSnapshotSchema.parse(extra)));
  });

  it("refuses what the schema refuses", () => {
    const [first, ...rest] = snapshot.apps;
    if (first === undefined) throw new Error("no app");
    const bad: SpendSnapshot[] = [
      { ...snapshot, bill: { now: Number.NaN, projected: 1 } },
      { ...snapshot, apps: [{ ...first, burnPerHour: Number.POSITIVE_INFINITY }, ...rest] },
      { ...snapshot, apps: [{ ...first, installId: "" }, ...rest] },
      {
        ...snapshot,
        apps: [
          { ...first, spend: { ...first.spend, week: { ...first.spend.week, spent: Number.NaN } } },
        ],
      },
      { ...snapshot, plan: "team" as never },
    ];
    for (const b of bad) {
      expect(spendSnapshotSchema.safeParse(b).success).toBe(false);
      expect(throws(() => snapshotText(b))).toBe(true);
    }
  });
});

describe("parseShardInput", () => {
  const input = {
    now: NOW,
    plan: "free",
    part: 2,
    fresh: true,
    apps: [
      { installId: "a", installedAt: NOW - DAY_MS, extra: "left out" },
      { installId: "b", installedAt: 0 },
    ],
    judge: ["a"],
    incomplete: [],
    alarms: { a: [{ object: "ns", alarms: 4000 }] },
    limitWarnings: {
      a: { product: "kv_writes", used: 900, share: 0.9, runsOutAt: null, appShare: 1 },
      b: {
        product: "d1_rows_read",
        used: 9,
        share: 0.1,
        runsOutAt: NOW + 1,
        appShare: 0.5,
        otherShare: 0.4,
      },
    },
    resumes: { a: { at: NOW - 60_000, base: { workers_requests: 12 } } },
    unknown: true,
  };

  it("reads what the schema reads, defaults included", () => {
    expect(parseShardInput(input)).toEqual(shardInputSchema.parse(input));
    const { fresh: _f, resumes: _r, ...minimal } = input;
    expect(parseShardInput(minimal)).toEqual(shardInputSchema.parse(minimal));
  });

  it("refuses what the schema refuses", () => {
    const bad: unknown[] = [
      null,
      [],
      { ...input, now: 0 },
      { ...input, now: 1.5 },
      { ...input, plan: "team" },
      { ...input, part: -1 },
      { ...input, fresh: "yes" },
      { ...input, apps: [{ installId: "", installedAt: 1 }] },
      {
        ...input,
        apps: Array.from({ length: 65 }, (_, i) => ({ installId: `x${i}`, installedAt: 1 })),
      },
      { ...input, judge: [1] },
      { ...input, alarms: { a: [{ object: "ns", alarms: "many" }] } },
      { ...input, limitWarnings: { a: { product: "kv_writes", used: 1, share: 1, appShare: 1 } } },
      {
        ...input,
        limitWarnings: {
          a: {
            product: "kv_writes",
            used: 1,
            share: 1,
            runsOutAt: null,
            appShare: 1,
            otherShare: "most",
          },
        },
      },
      { ...input, resumes: { a: { at: 1, base: { workers_requests: "1" } } } },
    ];
    for (const b of bad) {
      expect(shardInputSchema.safeParse(b).success).toBe(false);
      expect(throws(() => parseShardInput(b))).toBe(true);
    }
  });
});

describe("statusText", () => {
  it("stores what the schema stores", () => {
    const statuses: SpendWatchStatus[] = [
      { state: "watching", at: NOW },
      { state: "needs_access", at: NOW, via: "oauth", missing: ["account-analytics.read"] },
      { state: "needs_access", at: NOW, via: "token", missing: [] },
      { state: "failed", at: NOW, error: "D1 is down" },
      // Workers Free: the account's totals today, read with the check.
      { state: "watching", at: NOW, account: { at: NOW, used: { d1_rows_written: 90_152 } } },
      {
        state: "needs_access",
        at: NOW,
        via: "token",
        missing: [],
        account: { at: NOW - 300_000, used: {} },
      },
      {
        state: "failed",
        at: NOW,
        error: "x",
        account: { at: NOW, used: { workers_requests: 5_731, kv_writes: 0 } },
      },
    ];
    for (const s of statuses) {
      expect(statusText(s)).toBe(JSON.stringify(spendWatchStatusSchema.parse(s)));
      // What the watcher reads back of it, by hand, is what the pages read.
      expect(storedAccountDay(statusText(s))).toEqual(
        spendWatchStatusSchema.parse(s).account ?? null,
      );
    }
  });

  it("refuses what the schema refuses", () => {
    const bad = [
      { state: "watching", at: 1.5 },
      { state: "needs_access", at: NOW, via: "email", missing: [] },
      { state: "failed", at: NOW },
      { state: "sleeping", at: NOW },
      { state: "watching", at: NOW, account: { at: 1.5, used: {} } },
      { state: "watching", at: NOW, account: { at: NOW, used: { kv_writes: -1 } } },
      { state: "watching", at: NOW, account: { at: NOW, used: { kv_writes: "1" } } },
      { state: "watching", at: NOW, account: { at: NOW } },
    ] as unknown as SpendWatchStatus[];
    for (const s of bad) {
      expect(spendWatchStatusSchema.safeParse(s).success).toBe(false);
      expect(throws(() => statusText(s))).toBe(true);
    }
  });
});

describe("parseCheckInput", () => {
  const input = {
    now: NOW,
    plan: "paid",
    all: [
      { installId: "a", installedAt: NOW - DAY_MS, label: "left out" },
      { installId: "b", installedAt: 0 },
    ],
    judge: ["a", "b"],
    incomplete: ["b"],
    alarms: { a: [{ object: "ns", alarms: 12 }] },
    fresh: ["a"],
    budget: 41,
    resumes: { b: { at: NOW - 60_000, base: { do_requests: 3 } } },
    extra: 1,
  };

  it("reads what the schema reads", () => {
    expect(parseCheckInput(input)).toEqual(checkInputSchema.parse(input));
    const free = { ...input, plan: "free", accountToday: { d1_rows_written: 90_152 } };
    expect(parseCheckInput(free)).toEqual(checkInputSchema.parse(free));
  });

  it("refuses what the schema refuses", () => {
    const bad: unknown[] = [
      undefined,
      { ...input, now: -1 },
      { ...input, plan: "" },
      { ...input, all: [{ installId: "a" }] },
      { ...input, judge: "a" },
      { ...input, fresh: [null] },
      { ...input, budget: "41" },
      { ...input, alarms: { a: {} } },
      { ...input, resumes: undefined },
      { ...input, accountToday: { d1_rows_written: "many" } },
      { ...input, accountToday: [] },
    ];
    for (const b of bad) {
      expect(checkInputSchema.safeParse(b).success).toBe(false);
      expect(throws(() => parseCheckInput(b))).toBe(true);
    }
  });
});
