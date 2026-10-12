import { createClient, type UsageRow } from "@appflare/cf-api";
import { describe, expect, it } from "vitest";
import { type CollectedHour, type CollectTarget, collectUsage, HOUR, productOf } from "./collect";
import { changedHours, sameValue, storedIndex } from "./collect.server";
import {
  type AnswerRow,
  answerRow,
  fakeGraphQL,
  RECORDED,
  RECORDED_IDS,
  RECORDED_NOW,
} from "./collect-fixtures";

const HOUR_NOW = Math.floor(RECORDED_NOW / HOUR) * HOUR; // 16:00 UTC

function target(over: Partial<CollectTarget> & { installId: string }): CollectTarget {
  return {
    workers: [],
    durableObjects: [],
    d1: [],
    kv: [],
    r2: [],
    queues: [],
    workflows: [],
    vectorize: [],
    analyticsEngine: [],
    containers: [],
    ai: false,
    browser: false,
    from: HOUR_NOW - 2 * HOUR,
    ...over,
  };
}

function reader(
  answers: Readonly<Record<string, readonly AnswerRow[]>>,
  refuse?: Parameters<typeof fakeGraphQL>[2],
) {
  const graphql = fakeGraphQL(answers, undefined, refuse);
  const api = createClient({ accountId: "acc", token: "t", fetch: graphql.fetch });
  return { usage: api.usage, sent: graphql.sent };
}

const of = (hours: CollectedHour[], product: string) =>
  hours
    .filter((h) => h.product === product)
    .map((h) => [h.installId, h.hour - HOUR_NOW, Math.round(h.value * 1e12) / 1e12]);

const row = (over: Partial<UsageRow>): UsageRow => ({
  dataset: "workersInvocationsAdaptive",
  metric: "requests",
  resourceId: "x",
  hour: 0,
  value: 1,
  ...over,
});

describe("productOf", () => {
  it("maps metrics to products in the math's units", () => {
    expect(productOf(row({ metric: "cpuTimeUs", value: 2500 }))).toEqual(["workers_cpu_ms", 2.5]);
    expect(
      productOf(row({ dataset: "d1StorageAdaptiveGroups", metric: "storedBytes", value: 2e9 })),
    ).toEqual(["d1_storage", 2]);
    expect(
      productOf(row({ dataset: "r2OperationsAdaptiveGroups", metric: "PutObject", value: 3 })),
    ).toEqual(["r2_class_a", 3]);
    expect(
      productOf(row({ dataset: "r2OperationsAdaptiveGroups", metric: "GetObject", value: 3 })),
    ).toEqual(["r2_class_b", 3]);
    expect(
      productOf(row({ dataset: "r2OperationsAdaptiveGroups", metric: "DeleteObject" })),
    ).toBeNull();
    expect(
      productOf(
        row({
          dataset: "containersUsageAdaptiveGroups",
          metric: "allocatedMemoryByteSeconds",
          value: 2 ** 31,
        }),
      ),
    ).toEqual(["containers_memory", 2]);
    expect(
      productOf(
        row({
          dataset: "browserRenderingBrowserTimeUsageAdaptiveGroups",
          metric: "sessionDurationMs",
          value: 1_800_000,
        }),
      ),
    ).toEqual(["browser_hours", 0.5]);
    expect(productOf(row({ metric: "errors" }))).toBeNull();
  });
});

describe("collectUsage (recorded answers)", () => {
  const app = target({
    installId: "notes",
    workers: [RECORDED_IDS.worker],
    d1: [RECORDED_IDS.d1],
    kv: [RECORDED_IDS.kv],
    durableObjects: [RECORDED_IDS.durableObject],
  });

  it("reads each dataset once and maps the hours from the app's first hour on", async () => {
    const { usage, sent } = reader(RECORDED);
    const collected = await collectUsage(usage, [app], RECORDED_NOW);

    expect(sent.map((s) => s.dataset).sort()).toEqual(
      [
        "alarms",
        "d1AnalyticsAdaptiveGroups",
        "d1StorageAdaptiveGroups",
        "durableObjectsInvocationsAdaptiveGroups",
        "durableObjectsPeriodicGroups",
        "durableObjectsSqlStorageGroups",
        "kvOperationsAdaptiveGroups",
        "kvStorageAdaptiveGroups",
        "workersInvocationsAdaptive",
      ].sort(),
    );
    // Every request carries now as a unique bound (Cloudflare caches answers otherwise).
    expect(sent.every((s) => typeof s.filter.datetime_leq === "string")).toBe(true);

    expect(of(collected.hours, "workers_requests")).toEqual([
      ["notes", -2 * HOUR, 2],
      ["notes", -HOUR, 2],
      ["notes", 0, 1],
    ]);
    expect(of(collected.hours, "workers_cpu_ms")).toEqual([
      ["notes", -2 * HOUR, 262.806],
      ["notes", -HOUR, 262.411],
      ["notes", 0, 136.516],
    ]);
    expect(of(collected.hours, "d1_rows_read")).toContainEqual(["notes", 0, 138]);
    expect(of(collected.hours, "d1_storage")).toEqual([
      ["notes", -2 * HOUR, 0.000679936],
      ["notes", -HOUR, 0.000679936],
      ["notes", 0, 0.000679936],
    ]);
    // Storage has a point for every hour held.
    expect(of(collected.hours, "do_storage")).toHaveLength(3);
    expect(of(collected.hours, "kv_storage")).toHaveLength(3);
    // No hour before the app's first hour.
    expect(collected.hours.every((h) => h.hour >= app.from)).toBe(true);
    expect(collected.alarms.size).toBe(0);
  });

  it("reads every app's ids in the same request", async () => {
    const { usage, sent } = reader(RECORDED);
    const other = target({ installId: "other", workers: ["other"], d1: ["other-db"] });
    await collectUsage(usage, [app, other], RECORDED_NOW);
    const workers = sent.filter((s) => s.dataset === "workersInvocationsAdaptive");
    expect(workers).toHaveLength(1);
    expect(workers[0]?.filter.scriptName_in).toEqual(["notes", "other"]);
    expect(sent.filter((s) => s.dataset === "d1AnalyticsAdaptiveGroups")).toHaveLength(1);
  });

  it("reads nothing for an app without resources of a kind", async () => {
    const { usage, sent } = reader(RECORDED);
    await collectUsage(usage, [target({ installId: "w", workers: ["notes"] })], RECORDED_NOW);
    expect(sent.map((s) => s.dataset)).toEqual(["workersInvocationsAdaptive"]);
  });
});

describe("collectUsage (shaped answers)", () => {
  it("splits the account's Workers AI evenly across the apps that bind it", async () => {
    const { usage } = reader({
      aiInferenceAdaptiveGroups: [
        answerRow("modelId", "@cf/meta/llama", HOUR_NOW, { count: 4, sum: { totalNeurons: 100 } }),
      ],
    });
    const collected = await collectUsage(
      usage,
      [
        target({ installId: "a", ai: true }),
        target({ installId: "b", ai: true }),
        target({ installId: "c" }),
      ],
      RECORDED_NOW,
    );
    expect(of(collected.hours, "ai_neurons")).toEqual([
      ["a", 0, 50],
      ["b", 0, 50],
    ]);
  });

  it("attributes Analytics Engine by dataset and R2 by bucket", async () => {
    const { usage } = reader({
      workersAnalyticsEngineAdaptiveGroups: [
        answerRow("dataset", "events", HOUR_NOW, { count: 1200 }),
      ],
      r2OperationsAdaptiveGroups: [
        answerRow(
          "bucketName",
          "media",
          HOUR_NOW,
          { sum: { requests: 7 } },
          { actionType: "PutObject" },
        ),
        answerRow(
          "bucketName",
          "media",
          HOUR_NOW,
          { sum: { requests: 9 } },
          { actionType: "GetObject" },
        ),
      ],
    });
    const collected = await collectUsage(
      usage,
      [
        target({ installId: "a", analyticsEngine: ["events"] }),
        target({ installId: "b", r2: ["media"] }),
      ],
      RECORDED_NOW,
    );
    expect(of(collected.hours, "analytics_engine_data_points")).toEqual([["a", 0, 1200]]);
    expect(of(collected.hours, "r2_class_a")).toEqual([["b", 0, 7]]);
    expect(of(collected.hours, "r2_class_b")).toEqual([["b", 0, 9]]);
  });

  it("counts a Workflow's steps, not its CPU time or starts (billed as its Worker's)", async () => {
    const { usage, sent } = reader({
      workflowsAdaptiveGroups: [
        answerRow(
          "workflowName",
          "sync-flow",
          HOUR_NOW,
          { count: 3, sum: { stepCount: 120, cpuTime: 900 } },
          { eventType: "WORKFLOW_START" },
        ),
        answerRow(
          "workflowName",
          "sync-flow",
          HOUR_NOW,
          { count: 9, sum: { stepCount: 30, cpuTime: 100 } },
          { eventType: "STEP_SUCCESS" },
        ),
      ],
    });
    const collected = await collectUsage(
      usage,
      [target({ installId: "a", workflows: ["sync-flow"] })],
      RECORDED_NOW,
    );
    expect(sent.map((s) => s.dataset)).toEqual(["workflowsAdaptiveGroups"]);
    expect(collected.hours).toEqual([
      { installId: "a", product: "workflow_steps", hour: HOUR_NOW, value: 150 },
    ]);
  });

  it("carries a storage sample into later hours, and the stored level when there is none", async () => {
    const { usage } = reader({
      // Only one sample, an hour before the app's first hour (within the look-back).
      d1StorageAdaptiveGroups: [
        answerRow("databaseId", "db", HOUR_NOW - 3 * HOUR, { max: { databaseSizeBytes: 5e9 } }),
      ],
    });
    const collected = await collectUsage(
      usage,
      [
        target({ installId: "a", d1: ["db"] }),
        target({ installId: "b", kv: ["kv-b"], levelsBefore: { kv_storage: 0.25 } }),
      ],
      RECORDED_NOW,
    );
    expect(of(collected.hours, "d1_storage")).toEqual([
      ["a", -2 * HOUR, 5],
      ["a", -HOUR, 5],
      ["a", 0, 5],
    ]);
    expect(of(collected.hours, "kv_storage")).toEqual([
      ["b", -2 * HOUR, 0.25],
      ["b", -HOUR, 0.25],
      ["b", 0, 0.25],
    ]);
  });

  it("estimates each namespace's busiest object over the last 60 minutes", async () => {
    const into = RECORDED_NOW - HOUR_NOW; // seconds into the current hour
    const { usage, sent } = reader({
      alarms: [
        answerRow(
          "namespaceId",
          "ns1",
          HOUR_NOW - HOUR,
          { sum: { requests: 6000 } },
          { objectId: "o1" },
        ),
        answerRow("namespaceId", "ns1", HOUR_NOW, { sum: { requests: 2000 } }, { objectId: "o1" }),
      ],
    });
    const collected = await collectUsage(
      usage,
      [target({ installId: "a", durableObjects: ["ns1"] })],
      RECORDED_NOW,
    );
    expect(sent.find((s) => s.dataset === "alarms")?.filter.type).toBe("alarm");
    expect(collected.alarms.get("a")).toEqual([
      { object: "ns1", alarms: Math.round(2000 + 6000 * (1 - into / HOUR)) },
    ]);
  });
});

describe("collectUsage (a read that fails)", () => {
  const app = target({
    installId: "notes",
    workers: [RECORDED_IDS.worker],
    d1: [RECORDED_IDS.d1],
    kv: [RECORDED_IDS.kv],
    levelsBefore: { d1_storage: 0.5 },
  });

  it("leaves out only the products of the read that failed, for the apps it covers", async () => {
    const other = target({ installId: "other", workers: ["other"] });
    const { usage } = reader(RECORDED, {
      message: "timeout",
      datasets: ["d1StorageAdaptiveGroups"],
    });
    const collected = await collectUsage(usage, [app, other], RECORDED_NOW);
    expect(collected.failures.map((f) => [f.source, f.installIds])).toEqual([["d1", ["notes"]]]);
    expect(collected.incomplete).toEqual(new Set(["notes"]));
    expect(collected.succeeded).toBe(2);
    const products = new Set(collected.hours.map((h) => h.product));
    expect(products.has("workers_requests")).toBe(true);
    expect(products.has("kv_storage")).toBe(true);
    // Neither the read's counts nor its storage, not even the level carried from before.
    expect(products.has("d1_rows_read")).toBe(false);
    expect(products.has("d1_storage")).toBe(false);
  });

  it("leaves out the products of a source the check could not prepare", async () => {
    const { usage } = reader(RECORDED);
    const collected = await collectUsage(usage, [{ ...app, unread: ["d1"] }], RECORDED_NOW);
    expect(collected.incomplete).toEqual(new Set(["notes"]));
    expect(collected.failures).toEqual([]);
    expect(collected.hours.some((h) => h.product.startsWith("d1_"))).toBe(false);
  });
});

describe("changedHours", () => {
  const stored = storedIndex([
    { installId: "a", product: "workers_requests", t: 0, value: 10 },
    { installId: "a", product: "workers_requests", t: HOUR, value: 4 },
    { installId: "a", product: "d1_storage", t: 0, value: 0.1 },
  ]);

  it("writes only hours whose value changed, never a new zero", () => {
    expect(
      changedHours(
        [
          { installId: "a", product: "workers_requests", hour: 0, value: 10 },
          { installId: "a", product: "workers_requests", hour: HOUR, value: 6 },
          { installId: "a", product: "workers_requests", hour: 2 * HOUR, value: 1 },
          { installId: "a", product: "d1_storage", hour: 0, value: 0.1 + 1e-15 },
          { installId: "a", product: "kv_storage", hour: 0, value: 0 },
        ],
        stored,
      ),
    ).toEqual([
      { installId: "a", product: "workers_requests", hour: HOUR, value: 6 },
      { installId: "a", product: "workers_requests", hour: 2 * HOUR, value: 1 },
    ]);
  });

  it("compares readings that went through floating point", () => {
    expect(sameValue(0.1 + 0.2, 0.3)).toBe(true);
    expect(sameValue(1, 1.001)).toBe(false);
  });
});
