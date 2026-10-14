import { describe, expect, it } from "vitest";
import { CloudflareApiError } from "./errors";
import type { CapturedRequest } from "./fake-fetch";
import { CloudflareGraphQLError } from "./graphql";
import { createHttpApi } from "./http";
import {
  createUsage,
  USAGE_BATCH_FIELDS,
  USAGE_MAX_ROWS,
  USAGE_TOTAL_DATASETS,
  type UsageReads,
  UsageRowLimitError,
} from "./namespaces/usage";

const ACCOUNT = "acc-123";
/** 2026-10-12T10:30:00.000Z */
const NOW_MS = Date.UTC(2026, 9, 12, 10, 30);
const NOW = NOW_MS / 1000;
const H = 3600;
const hourIso = (unix: number) => new Date(unix * 1000).toISOString().replace(".000Z", "Z");

interface Sent {
  dataset: string;
  query: string;
  variables: { accountTag: string; filter: Record<string, unknown> };
}

async function sent(call: CapturedRequest): Promise<Sent> {
  const body = (await call.request.clone().json()) as {
    query: string;
    variables: Sent["variables"];
  };
  const dataset = /rows: (\w+)\(/.exec(body.query)?.[1] ?? "";
  return { dataset, query: body.query, variables: body.variables };
}

/** A usage client whose GraphQL answers come from `answer(dataset, sent)`. */
function make(answer: (s: Sent) => unknown[] | Promise<unknown[]>, now = () => NOW_MS) {
  const log: Sent[] = [];
  const fetch = async (input: string, init?: RequestInit) => {
    const request = new Request(input, init);
    const s = await sent({ request } as CapturedRequest);
    log.push(s);
    const rows = await answer(s);
    return new Response(
      JSON.stringify({ data: { viewer: { accounts: [{ rows }] } }, errors: null }),
      { status: 200, headers: { "Content-Type": "application/json" } },
    );
  };
  const http = createHttpApi({ accountId: ACCOUNT, token: "t", fetch });
  return { usage: createUsage(http, { now }), log };
}

describe("usage: requests", () => {
  it("asks one dataset for the ids and the hour-aligned range, with now as a unique bound", async () => {
    const { usage, log } = make(() => [
      // Real row shape from workersInvocationsAdaptive.
      {
        dimensions: { scriptName: "cut", datetimeHour: "2026-10-12T09:00:00Z" },
        sum: { requests: 3763, subrequests: 4576, errors: 129, cpuTimeUs: 709364 },
      },
      {
        dimensions: { scriptName: "__unknown__", datetimeHour: "2026-10-12T09:00:00Z" },
        sum: { requests: 5, subrequests: 0, errors: 0, cpuTimeUs: 1 },
      },
    ]);
    const rows = await usage.workers({ ids: ["cut", "open-seo"], from: NOW - 2 * H + 600 });

    expect(log).toHaveLength(1);
    const [s] = log;
    expect(s?.dataset).toBe("workersInvocationsAdaptive");
    expect(s?.query).toContain("$filter: AccountWorkersInvocationsAdaptiveFilter_InputObject!");
    expect(s?.query).toContain(`limit: ${USAGE_MAX_ROWS}`);
    expect(s?.query).toContain("dimensions { scriptName datetimeHour }");
    expect(s?.variables.accountTag).toBe(ACCOUNT);
    expect(s?.variables.filter).toEqual({
      scriptName_in: ["cut", "open-seo"],
      datetime_geq: "2026-10-12T08:00:00.000Z",
      datetime_lt: "2026-10-12T10:30:00.000Z",
      datetime_leq: "2026-10-12T10:30:00.000Z",
    });
    expect(rows).toEqual([
      {
        dataset: "workersInvocationsAdaptive",
        metric: "requests",
        resourceId: "cut",
        hour: NOW - 1.5 * H,
        value: 3763,
      },
      {
        dataset: "workersInvocationsAdaptive",
        metric: "subrequests",
        resourceId: "cut",
        hour: NOW - 1.5 * H,
        value: 4576,
      },
      {
        dataset: "workersInvocationsAdaptive",
        metric: "errors",
        resourceId: "cut",
        hour: NOW - 1.5 * H,
        value: 129,
      },
      {
        dataset: "workersInvocationsAdaptive",
        metric: "cpuTimeUs",
        resourceId: "cut",
        hour: NOW - 1.5 * H,
        value: 709364,
      },
    ]);
  });

  it("never sends the same variables twice, even within one millisecond", async () => {
    const { usage, log } = make(() => []);
    await usage.workers({ ids: ["cut"], from: NOW - H });
    await usage.workers({ ids: ["cut"], from: NOW - H });
    const [a, b] = log.map((s) => s.variables.filter.datetime_leq);
    expect(a).not.toBe(b);
    expect(JSON.stringify(log[0]?.variables)).not.toBe(JSON.stringify(log[1]?.variables));
  });

  it("keeps a past end as the window's end and still bounds by now", async () => {
    const { usage, log } = make(() => []);
    await usage.d1({ ids: ["db"], from: NOW - 5 * H, to: NOW - 3 * H - 1800 });
    expect(log[0]?.variables.filter).toMatchObject({
      datetime_geq: "2026-10-12T05:00:00.000Z",
      datetime_lt: "2026-10-12T07:00:00.000Z",
      datetime_leq: "2026-10-12T10:30:00.000Z",
    });
  });

  it("reads nothing for no ids or an empty range", async () => {
    const { usage, log } = make(() => []);
    expect(await usage.workers({ ids: [], from: NOW - H })).toEqual([]);
    expect(await usage.workers({ ids: ["cut"], from: NOW + H })).toEqual([]);
    expect(log).toHaveLength(0);
  });

  it("asks for at most 100 ids at a time", async () => {
    const { usage, log } = make(() => []);
    const ids = Array.from({ length: 150 }, (_, i) => `w${i}`);
    await usage.workers({ ids, from: NOW - H });
    expect(log.map((s) => (s.variables.filter.scriptName_in as string[]).length)).toEqual([
      100, 50,
    ]);
  });

  it("starts no earlier than each dataset still answers for", async () => {
    const { usage, log } = make(() => []);
    // Analytics Engine keeps 31 days: 31 days before 10:30, plus a minute, rounded up to the hour.
    await usage.analyticsEngine({ ids: ["events"], from: NOW - 60 * 24 * H });
    expect(log[0]?.variables.filter.datetime_geq).toBe("2026-09-11T11:00:00.000Z");
    // Queues keep 90 days (read in 30-day windows, the first from the oldest hour).
    const queuesFrom = log.length;
    await usage.queues({ ids: ["q"], from: NOW - 120 * 24 * H });
    expect(log[queuesFrom]?.variables.filter.datetime_geq).toBe("2026-07-14T11:00:00.000Z");
    // A range the dataset no longer has reads nothing instead of failing.
    const before = log.length;
    expect(
      await usage.containers({ ids: ["c"], from: NOW - 60 * 24 * H, to: NOW - 40 * 24 * H }),
    ).toEqual([]);
    expect(log).toHaveLength(before);
    // A recent start is left alone.
    await usage.analyticsEngine({ ids: ["events"], from: NOW - 2 * H });
    expect(log.at(-1)?.variables.filter.datetime_geq).toBe("2026-10-12T08:00:00.000Z");
  });

  it("splits a range longer than 30 days into windows", async () => {
    const { usage, log } = make(() => []);
    await usage.queues({ ids: ["q"], from: NOW - 45 * 24 * H });
    expect(log).toHaveLength(2);
    expect(log[0]?.variables.filter.datetime_lt).toBe(log[1]?.variables.filter.datetime_geq);
  });

  it("splits a full answer by time, then by ids, until it fits", async () => {
    const full = (id: string, hour: string) =>
      Array.from({ length: USAGE_MAX_ROWS }, () => ({
        dimensions: { queueId: id, datetimeHour: hour },
        sum: { billableOperations: 1 },
      }));
    const { usage, log } = make((s) => {
      const f = s.variables.filter;
      const ids = f.queueId_in as string[];
      const hours =
        (Date.parse(f.datetime_lt as string) - Date.parse(f.datetime_geq as string)) / 3_600_000;
      if (hours > 1 || ids.length > 1) return full("x", "2026-10-12T08:00:00Z");
      return [
        {
          dimensions: { queueId: ids[0], datetimeHour: f.datetime_geq },
          sum: { billableOperations: 7 },
        },
      ];
    });
    const rows = await usage.queues({ ids: ["a", "b"], from: NOW - 2 * H, to: NOW - 0.5 * H });
    // Full for 2 h and both ids, then each hour is still full for both ids, then each id alone fits.
    expect(log).toHaveLength(1 + 2 + 4);
    expect(rows.map((r) => [r.resourceId, r.hour, r.value]).sort()).toEqual(
      [
        ["a", NOW - 2.5 * H, 7],
        ["a", NOW - 1.5 * H, 7],
        ["b", NOW - 2.5 * H, 7],
        ["b", NOW - 1.5 * H, 7],
      ].sort(),
    );
  });

  it("refuses to undercount when one resource's hour does not fit in one answer", async () => {
    const { usage } = make(() =>
      Array.from({ length: USAGE_MAX_ROWS }, (_, i) => ({
        dimensions: { bucketName: "b", datetimeHour: "2026-10-12T10:00:00Z", actionType: `Op${i}` },
        sum: { requests: 1 },
      })),
    );
    await expect(usage.r2({ ids: ["b"], from: NOW - 0.5 * H })).rejects.toBeInstanceOf(
      UsageRowLimitError,
    );
  });

  it("passes GraphQL errors on", async () => {
    const http = createHttpApi({
      accountId: ACCOUNT,
      token: "t",
      fetch: async () =>
        new Response(
          JSON.stringify({
            data: null,
            errors: [{ message: "not authorized", extensions: { code: "authz" } }],
          }),
        ),
    });
    const error = await createUsage(http, { now: () => NOW_MS })
      .kv({ ids: ["k"], from: NOW - H })
      .catch((e: unknown) => e);
    expect(error).toBeInstanceOf(CloudflareGraphQLError);
    expect((error as CloudflareGraphQLError).codes).toEqual(["authz"]);
  });
});

describe("usage: products", () => {
  const at = hourIso(NOW - 1.5 * H);
  const hour = NOW - 1.5 * H;

  it("Durable Objects: invocations, periodic metrics and SQLite storage by namespace id", async () => {
    const ns = "aaaabbbbccccddddeeeeffff00001111";
    const { usage, log } = make((s) => {
      if (s.dataset === "durableObjectsInvocationsAdaptiveGroups") {
        return [{ dimensions: { namespaceId: ns, datetimeHour: at }, sum: { requests: 2 } }];
      }
      if (s.dataset === "durableObjectsPeriodicGroups") {
        return [
          {
            dimensions: { namespaceId: ns, datetimeHour: at },
            sum: {
              activeTime: 338007,
              duration: 0.043264896,
              rowsRead: 3,
              rowsWritten: 0,
              inboundWebsocketMsgCount: 4,
              outboundWebsocketMsgCount: 5,
              storageReadUnits: 0,
              storageWriteUnits: 0,
              storageDeletes: 0,
            },
          },
        ];
      }
      return [{ dimensions: { namespaceId: ns, datetimeHour: at }, max: { storedBytes: 12288 } }];
    });
    const rows = await usage.durableObjects({ ids: [ns.toUpperCase()], from: NOW - 2 * H });
    expect(log.map((s) => s.dataset).sort()).toEqual([
      "durableObjectsInvocationsAdaptiveGroups",
      "durableObjectsPeriodicGroups",
      "durableObjectsSqlStorageGroups",
    ]);
    const value = (metric: string) => rows.find((r) => r.metric === metric)?.value;
    expect(rows.every((r) => r.resourceId === ns.toUpperCase() && r.hour === hour)).toBe(true);
    expect(value("requests")).toBe(2);
    expect(value("activeTimeUs")).toBe(338007);
    expect(value("durationGbs")).toBe(0.043264896);
    expect(value("rowsRead")).toBe(3);
    expect(value("inboundWebsocketMessages")).toBe(4);
    expect(value("outboundWebsocketMessages")).toBe(5);
    expect(value("storedBytes")).toBe(12288);
    // Counts of 0 are left out.
    expect(value("rowsWritten")).toBeUndefined();
    expect(value("storageDeletes")).toBeUndefined();
  });

  it("keeps a stored size of 0, which says the storage was emptied", async () => {
    const { usage } = make((s) =>
      s.dataset === "kvStorageAdaptiveGroups"
        ? [{ dimensions: { namespaceId: "k", datetimeHour: at }, max: { byteCount: 0 } }]
        : [
            {
              dimensions: { namespaceId: "k", datetimeHour: at, actionType: "read" },
              sum: { requests: 0 },
            },
          ],
    );
    expect(await usage.kv({ ids: ["k"], from: NOW - 2 * H })).toEqual([
      {
        dataset: "kvStorageAdaptiveGroups",
        metric: "storedBytes",
        resourceId: "k",
        hour,
        value: 0,
      },
    ]);
  });

  it("Durable Object alarm peaks: the busiest object per namespace and hour", async () => {
    const { usage, log } = make(() => [
      {
        dimensions: { namespaceId: "ns", datetimeHour: at, objectId: "o1" },
        sum: { requests: 4000 },
      },
      {
        dimensions: { namespaceId: "ns", datetimeHour: at, objectId: "o2" },
        sum: { requests: 12 },
      },
    ]);
    const rows = await usage.durableObjectAlarmPeaks({ ids: ["ns"], from: NOW - 2 * H });
    expect(log[0]?.variables.filter.type).toBe("alarm");
    expect(log[0]?.query).toContain("orderBy: [sum_requests_DESC]");
    expect(rows).toEqual([
      {
        dataset: "durableObjectsInvocationsAdaptiveGroups",
        metric: "busiestObjectAlarms",
        resourceId: "ns",
        hour,
        value: 4000,
      },
    ]);
  });

  it("Durable Object alarm peaks: a full sorted answer for one namespace and hour is kept", async () => {
    const { usage } = make(() =>
      Array.from({ length: USAGE_MAX_ROWS }, (_, i) => ({
        dimensions: { namespaceId: "ns", datetimeHour: "2026-10-12T10:00:00Z", objectId: `o${i}` },
        sum: { requests: USAGE_MAX_ROWS - i },
      })),
    );
    const rows = await usage.durableObjectAlarmPeaks({ ids: ["ns"], from: NOW - 0.5 * H });
    expect(rows.map((r) => r.value)).toEqual([USAGE_MAX_ROWS]);
  });

  it("D1: rows read and written, and the database size", async () => {
    const db = "11112222-3333-4444-5555-666677778888";
    const { usage } = make((s) =>
      s.dataset === "d1AnalyticsAdaptiveGroups"
        ? [
            {
              dimensions: { databaseId: db, datetimeHour: at },
              sum: { rowsRead: 62566, rowsWritten: 1127 },
            },
          ]
        : [
            {
              dimensions: { databaseId: db, datetimeHour: at },
              max: { databaseSizeBytes: 286720 },
            },
          ],
    );
    const rows = await usage.d1({ ids: [db], from: NOW - 2 * H });
    expect(rows.map((r) => [r.dataset, r.metric, r.value])).toEqual([
      ["d1AnalyticsAdaptiveGroups", "rowsRead", 62566],
      ["d1AnalyticsAdaptiveGroups", "rowsWritten", 1127],
      ["d1StorageAdaptiveGroups", "storedBytes", 286720],
    ]);
  });

  it("KV: sends ids without dashes, names operations, and maps dashed storage ids back", async () => {
    const given = "01234567-89ab-cdef-0123-456789abcdef";
    const { usage, log } = make((s) =>
      s.dataset === "kvOperationsAdaptiveGroups"
        ? [
            {
              dimensions: {
                namespaceId: "0123456789abcdef0123456789abcdef",
                datetimeHour: at,
                actionType: "read",
              },
              sum: { requests: 18 },
            },
            {
              dimensions: {
                namespaceId: "0123456789abcdef0123456789abcdef",
                datetimeHour: at,
                actionType: "write",
              },
              sum: { requests: 3 },
            },
            {
              dimensions: {
                namespaceId: "0123456789abcdef0123456789abcdef",
                datetimeHour: at,
                actionType: "list",
              },
              sum: { requests: 1 },
            },
            {
              dimensions: {
                namespaceId: "0123456789abcdef0123456789abcdef",
                datetimeHour: at,
                actionType: "delete",
              },
              sum: { requests: 2 },
            },
          ]
        : [{ dimensions: { namespaceId: given, datetimeHour: at }, max: { byteCount: 423669 } }],
    );
    const rows = await usage.kv({ ids: [given], from: NOW - 2 * H });
    for (const s of log) {
      expect(s.variables.filter.namespaceId_in).toEqual(["0123456789abcdef0123456789abcdef"]);
    }
    expect(rows.every((r) => r.resourceId === given)).toBe(true);
    expect(Object.fromEntries(rows.map((r) => [r.metric, r.value]))).toEqual({
      reads: 18,
      writes: 3,
      lists: 1,
      deletes: 2,
      storedBytes: 423669,
    });
  });

  it("R2: one metric per operation, storage over every storage class", async () => {
    const { usage } = make((s) =>
      s.dataset === "r2OperationsAdaptiveGroups"
        ? [
            {
              dimensions: { bucketName: "files", datetimeHour: at, actionType: "PutObject" },
              sum: { requests: 308 },
            },
            {
              dimensions: { bucketName: "files", datetimeHour: at, actionType: "HeadBucket" },
              sum: { requests: 2 },
            },
            {
              dimensions: { bucketName: "", datetimeHour: at, actionType: "ListBuckets" },
              sum: { requests: 58 },
            },
          ]
        : [
            {
              dimensions: { bucketName: "files", datetimeHour: at, storageClass: "Standard" },
              max: { payloadSize: 1000, metadataSize: 20 },
            },
            {
              dimensions: {
                bucketName: "files",
                datetimeHour: at,
                storageClass: "InfrequentAccess",
              },
              max: { payloadSize: 500, metadataSize: 5 },
            },
          ],
    );
    const rows = await usage.r2({ ids: ["files"], from: NOW - 2 * H });
    expect(rows.map((r) => [r.metric, r.value])).toEqual([
      ["PutObject", 308],
      ["HeadBucket", 2],
      ["storedBytes", 1525],
    ]);
  });

  it("Queues: billable operations by queue id", async () => {
    const q = "fedcba9876543210fedcba9876543210";
    const { usage } = make(() => [
      { dimensions: { queueId: q, datetimeHour: at }, sum: { billableOperations: 31 } },
      { dimensions: { queueId: q, datetimeHour: at }, sum: { billableOperations: 42 } },
    ]);
    expect(await usage.queues({ ids: [q], from: NOW - 2 * H })).toEqual([
      {
        dataset: "queueMessageOperationsAdaptiveGroups",
        metric: "operations",
        resourceId: q,
        hour,
        value: 73,
      },
    ]);
  });

  it("Workflows: instance starts, steps and CPU time by Workflow name", async () => {
    const { usage } = make(() => [
      {
        count: 1,
        dimensions: { workflowName: "flow", datetimeHour: at, eventType: "WORKFLOW_START" },
        sum: { stepCount: 0, cpuTime: 0 },
      },
      {
        count: 54,
        dimensions: { workflowName: "flow", datetimeHour: at, eventType: "WORKFLOW_RUNNING" },
        sum: { stepCount: 53, cpuTime: 39 },
      },
    ]);
    const rows = await usage.workflows({ ids: ["flow"], from: NOW - 2 * H });
    expect(Object.fromEntries(rows.map((r) => [r.metric, r.value]))).toEqual({
      instanceStarts: 1,
      steps: 53,
      cpuTimeMs: 39,
    });
  });

  it("Workers AI: the whole account, by model", async () => {
    const { usage, log } = make(() => [
      {
        count: 773,
        dimensions: { modelId: "@cf/meta/llama-3.2-1b-instruct", datetimeHour: at },
        sum: { totalNeurons: 149.76576511282474 },
      },
    ]);
    const rows = await usage.workersAi({ from: NOW - 2 * H });
    expect(Object.keys(log[0]?.variables.filter ?? {}).sort()).toEqual([
      "datetime_geq",
      "datetime_leq",
      "datetime_lt",
    ]);
    expect(rows).toEqual([
      {
        dataset: "aiInferenceAdaptiveGroups",
        metric: "neurons",
        resourceId: "@cf/meta/llama-3.2-1b-instruct",
        hour,
        value: 149.76576511282474,
      },
      {
        dataset: "aiInferenceAdaptiveGroups",
        metric: "requests",
        resourceId: "@cf/meta/llama-3.2-1b-instruct",
        hour,
        value: 773,
      },
    ]);
  });

  it("Vectorize: queries, queried and stored dimensions by index name", async () => {
    const { usage } = make((s) =>
      s.dataset === "vectorizeV2QueriesAdaptiveGroups"
        ? [
            {
              count: 215,
              dimensions: { indexName: "vec", datetimeHour: at },
              sum: { queriedVectorDimensions: 7072 },
            },
          ]
        : [
            {
              dimensions: { indexName: "vec", datetimeHour: at },
              max: { storedVectorDimensions: 6400 },
            },
          ],
    );
    const rows = await usage.vectorize({ ids: ["vec"], from: NOW - 2 * H });
    expect(Object.fromEntries(rows.map((r) => [r.metric, r.value]))).toEqual({
      queries: 215,
      queriedVectorDimensions: 7072,
      storedVectorDimensions: 6400,
    });
  });

  it("Analytics Engine: data points by dataset", async () => {
    const { usage } = make(() => [
      { count: 250, dimensions: { dataset: "events", datetimeHour: at } },
    ]);
    expect(await usage.analyticsEngine({ ids: ["events"], from: NOW - 2 * H })).toEqual([
      {
        dataset: "workersAnalyticsEngineAdaptiveGroups",
        metric: "dataPoints",
        resourceId: "events",
        hour,
        value: 250,
      },
    ]);
  });

  it("Browser Rendering: sessions by Worker, with browser time joined through the session ids", async () => {
    const { usage, log } = make((s) =>
      s.dataset === "browserRenderingEventsAdaptiveGroups"
        ? [
            { count: 3, dimensions: { scriptName: "shots", datetimeHour: at, sessionId: "s1" } },
            { count: 3, dimensions: { scriptName: "shots", datetimeHour: at, sessionId: "s2" } },
          ]
        : [
            {
              count: 1,
              dimensions: { sessionId: "s1", datetimeHour: at },
              sum: { totalSessionDurationMs: 21400 },
            },
            {
              count: 1,
              dimensions: { sessionId: "s2", datetimeHour: at },
              sum: { totalSessionDurationMs: 21214 },
            },
          ],
    );
    const rows = await usage.browserRendering({ ids: ["shots"], from: NOW - 2 * H });
    expect(log[1]?.variables.filter.sessionId_in).toEqual(["s1", "s2"]);
    expect(rows).toEqual([
      {
        dataset: "browserRenderingEventsAdaptiveGroups",
        metric: "sessions",
        resourceId: "shots",
        hour,
        value: 2,
      },
      {
        dataset: "browserRenderingBrowserTimeUsageAdaptiveGroups",
        metric: "sessionDurationMs",
        resourceId: "shots",
        hour,
        value: 42614,
      },
    ]);
  });

  it("Containers: allocated memory and disk in byte-seconds, CPU seconds and bytes sent", async () => {
    const app = "99998888-7777-6666-5555-444433332222";
    const { usage } = make(() => [
      {
        dimensions: { applicationId: app, datetimeHour: at },
        sum: {
          allocatedDisk: 1020003087302,
          allocatedMemory: 136902496930.66008,
          cpuTimeSec: 9.45,
          txBytes: 4656,
        },
      },
    ]);
    const rows = await usage.containers({ ids: [app], from: NOW - 2 * H });
    expect(Object.fromEntries(rows.map((r) => [r.metric, r.value]))).toEqual({
      allocatedMemoryByteSeconds: 136902496930.66008,
      allocatedDiskByteSeconds: 1020003087302,
      cpuTimeSec: 9.45,
      txBytes: 4656,
    });
  });
});

describe("usage: batched", () => {
  const workerRow = (script: string, hour: number, requests: number) => ({
    dimensions: { scriptName: script, datetimeHour: hourIso(hour) },
    sum: { requests, subrequests: 0, errors: 0, cpuTimeUs: 0 },
  });
  const DB = "11111111-1111-4111-8111-111111111111";
  const ROWS: Record<string, unknown[]> = {
    workersInvocationsAdaptive: [workerRow("a", NOW - 2 * H, 5), workerRow("b", NOW - H, 7)],
    d1AnalyticsAdaptiveGroups: [
      {
        dimensions: { databaseId: DB, datetimeHour: hourIso(NOW - H) },
        sum: { rowsRead: 10, rowsWritten: 2 },
      },
    ],
    d1StorageAdaptiveGroups: [],
  };

  interface FakeOptions {
    /** A dataset Cloudflare refuses, alone or combined. */
    refuse?: string;
    /** The refusal names no field. */
    noPath?: boolean;
    /** The answer keeps the other fields' data (Cloudflare drops it all). */
    withData?: boolean;
    /** Combined queries fail at the HTTP level. */
    httpError?: boolean;
    /** Combined queries are answered with errors Cloudflare never sends. */
    malformed?: boolean;
    /** Combined queries are answered with no errors and a null account. */
    nullAccount?: boolean;
  }

  /** Answers one-dataset and combined queries as Cloudflare does, or as `options` say. */
  function combined(options: FakeOptions = {}) {
    const bodies: Array<{ query: string; fields: string[] }> = [];
    const fetch = async (input: string, init?: RequestInit) => {
      const body = (await new Request(input, init).json()) as { query: string };
      const fields = [...body.query.matchAll(/(\w+): (\w+)\(limit/g)].map(([, alias, dataset]) => ({
        alias: alias ?? "",
        dataset: dataset ?? "",
      }));
      bodies.push({ query: body.query, fields: fields.map((f) => f.dataset) });
      const json = (value: unknown, status = 200) =>
        new Response(JSON.stringify(value), {
          status,
          headers: { "Content-Type": "application/json" },
        });
      if (fields.length > 1 && options.httpError) {
        return json({ success: false, errors: [{ code: 10000, message: "busy" }] }, 503);
      }
      if (fields.length > 1 && options.nullAccount) {
        return json({ data: { viewer: { accounts: [null] } }, errors: null });
      }
      if (fields.length > 1 && options.malformed) {
        return json({ data: null, errors: [null, { message: "odd", path: "r1" }] });
      }
      const bad = fields.find((f) => f.dataset === options.refuse);
      const account = Object.fromEntries(fields.map((f) => [f.alias, ROWS[f.dataset] ?? []]));
      const errors =
        bad === undefined
          ? null
          : [
              {
                message: "too wide",
                path: options.noPath ? null : ["Usage", "viewer", "accounts", "0", bad.alias],
                extensions: { code: "quota" },
              },
            ];
      const data =
        bad !== undefined && !options.withData ? null : { viewer: { accounts: [account] } };
      return json({ data, errors });
    };
    const http = createHttpApi({ accountId: ACCOUNT, token: "t", fetch });
    return { usage: createUsage(http, { now: () => NOW_MS }), bodies };
  }

  const readBoth = (usage: UsageReads) =>
    Promise.allSettled([
      usage.workers({ ids: ["a", "b"], from: NOW - 3 * H }),
      usage.d1({ ids: [DB], from: NOW - 3 * H }),
    ]);
  const fieldsSent = (bodies: Array<{ fields: string[] }>) =>
    bodies.map((b) => b.fields.join(",")).sort();

  it("sends the reads started together as one query, with the same answers", async () => {
    const separate = combined();
    const together = combined();
    const one = await readBoth(separate.usage);
    const two = await readBoth(together.usage.batched());
    expect(separate.bodies).toHaveLength(3);
    expect(together.bodies).toHaveLength(1);
    expect(together.bodies[0]?.fields).toEqual([
      "workersInvocationsAdaptive",
      "d1AnalyticsAdaptiveGroups",
      "d1StorageAdaptiveGroups",
    ]);
    expect(together.bodies[0]?.query).toContain(
      "$f1: AccountD1AnalyticsAdaptiveGroupsFilter_InputObject!",
    );
    expect(two).toEqual(one);
    expect(two.every((r) => r.status === "fulfilled")).toBe(true);
  });

  it("sends a field an error names on its own, and the others together again", async () => {
    const { usage, bodies } = combined({ refuse: "d1StorageAdaptiveGroups" });
    const [workers, d1] = await readBoth(usage.batched());
    expect(fieldsSent(bodies)).toEqual(
      [
        "workersInvocationsAdaptive,d1AnalyticsAdaptiveGroups,d1StorageAdaptiveGroups",
        "d1StorageAdaptiveGroups",
        "workersInvocationsAdaptive,d1AnalyticsAdaptiveGroups",
      ].sort(),
    );
    expect(workers.status).toBe("fulfilled");
    expect(d1.status === "rejected" && (d1.reason as CloudflareGraphQLError).codes).toEqual([
      "quota",
    ]);
  });

  it("sends each read on its own when an error names no field", async () => {
    const { usage, bodies } = combined({ refuse: "d1StorageAdaptiveGroups", noPath: true });
    const [workers, d1] = await readBoth(usage.batched());
    expect(bodies).toHaveLength(1 + 3);
    expect(workers.status).toBe("fulfilled");
    expect(d1.status === "rejected" && d1.reason).toBeInstanceOf(CloudflareGraphQLError);
  });

  it("fails only the field named by an error when the answer has data", async () => {
    const { usage, bodies } = combined({ refuse: "d1StorageAdaptiveGroups", withData: true });
    const [workers, d1] = await readBoth(usage.batched());
    expect(bodies).toHaveLength(1);
    expect(workers.status).toBe("fulfilled");
    expect(d1.status === "rejected" && (d1.reason as CloudflareGraphQLError).codes).toEqual([
      "quota",
    ]);
  });

  it("fails every read of a combined query refused at the HTTP level", async () => {
    const { usage, bodies } = combined({ httpError: true });
    const results = await readBoth(usage.batched());
    expect(bodies).toHaveLength(1);
    expect(results.map((r) => r.status)).toEqual(["rejected", "rejected"]);
    expect(results[0]?.status === "rejected" && results[0].reason).toBeInstanceOf(
      CloudflareApiError,
    );
  });

  it("settles every read when the errors are not what Cloudflare sends", async () => {
    const { usage, bodies } = combined({ malformed: true });
    const results = await readBoth(usage.batched());
    // The errors name no field it can tell: each read on its own, which answers.
    expect(bodies).toHaveLength(1 + 3);
    expect(results.map((r) => r.status)).toEqual(["fulfilled", "fulfilled"]);
  });

  it("sends each read on its own when a combined answer has no errors and no account", async () => {
    const { usage, bodies } = combined({ nullAccount: true });
    const results = await readBoth(usage.batched());
    // Not the same combined query again, which would get the same answer.
    expect(bodies).toHaveLength(1 + 3);
    expect(results.map((r) => r.status)).toEqual(["fulfilled", "fulfilled"]);
  });

  it(`asks for at most ${USAGE_BATCH_FIELDS} fields in one query`, async () => {
    const { usage, bodies } = combined();
    const batched = usage.batched();
    const reads = Array.from({ length: USAGE_BATCH_FIELDS * 2 + 1 }, (_, i) =>
      batched.workers({ ids: [`w${i}`], from: NOW - 3 * H }),
    );
    const results = await Promise.allSettled(reads);
    expect(results.every((r) => r.status === "fulfilled")).toBe(true);
    expect(bodies.map((b) => b.fields.length)).toEqual([USAGE_BATCH_FIELDS, USAGE_BATCH_FIELDS, 1]);
  });
});

describe("usage: account totals", () => {
  /** 00:00 UTC of NOW's day. */
  const DAY = Date.UTC(2026, 9, 12) / 1000;
  /** Answers as Cloudflare gave on a Workers Free account: one row per dataset, KV one per operation. */
  const TOTAL_ROWS: Record<string, unknown[]> = {
    workersInvocationsAdaptive: [{ sum: { requests: 5731 } }],
    durableObjectsInvocationsAdaptiveGroups: [],
    durableObjectsPeriodicGroups: [{ sum: { duration: 12.5, rowsRead: 0, rowsWritten: 40 } }],
    d1AnalyticsAdaptiveGroups: [{ sum: { rowsRead: 723090, rowsWritten: 90152 } }],
    kvOperationsAdaptiveGroups: [
      { dimensions: { actionType: "delete" }, sum: { requests: 97 } },
      { dimensions: { actionType: "read" }, sum: { requests: 2441 } },
      { dimensions: { actionType: "write" }, sum: { requests: 430 } },
      { dimensions: { actionType: "list" }, sum: { requests: 24 } },
    ],
    queueMessageOperationsAdaptiveGroups: [],
    workflowsAdaptiveGroups: [{ sum: { stepCount: 128 } }],
    aiInferenceAdaptiveGroups: [],
    workersAnalyticsEngineAdaptiveGroups: [{ count: 2 }],
    browserRenderingBrowserTimeUsageAdaptiveGroups: [{ sum: { totalSessionDurationMs: null } }],
  };

  it("reads each dataset once for the whole account, with no resource or hour", async () => {
    const { usage, log } = make((s) => TOTAL_ROWS[s.dataset] ?? []);
    const { totals, failed } = await usage.accountTotals({ from: DAY });
    expect(failed).toEqual([]);

    expect(log.map((s) => s.dataset).sort()).toEqual(Object.keys(TOTAL_ROWS).sort());
    expect(log).toHaveLength(USAGE_TOTAL_DATASETS);
    for (const s of log) {
      expect(s.query).not.toContain("datetimeHour");
      expect(Object.keys(s.variables.filter).sort()).toEqual([
        "datetime_geq",
        "datetime_leq",
        "datetime_lt",
      ]);
      expect(s.variables.filter.datetime_geq).toBe("2026-10-12T00:00:00.000Z");
      expect(s.variables.filter.datetime_lt).toBe("2026-10-12T10:30:00.000Z");
    }
    const kv = log.find((s) => s.dataset === "kvOperationsAdaptiveGroups");
    expect(kv?.query).toContain("dimensions { actionType }");
    expect(log.find((s) => s.dataset === "d1AnalyticsAdaptiveGroups")?.query).not.toContain(
      "dimensions",
    );
    // Every request is unique, so no answer comes from Cloudflare's cache.
    expect(new Set(log.map((s) => s.variables.filter.datetime_leq)).size).toBe(log.length);

    const by = (dataset: string, metric: string) =>
      totals.find((t) => t.dataset === dataset && t.metric === metric)?.value;
    expect(by("workersInvocationsAdaptive", "requests")).toBe(5731);
    expect(by("d1AnalyticsAdaptiveGroups", "rowsWritten")).toBe(90152);
    expect(by("d1AnalyticsAdaptiveGroups", "rowsRead")).toBe(723090);
    expect(by("kvOperationsAdaptiveGroups", "reads")).toBe(2441);
    expect(by("kvOperationsAdaptiveGroups", "writes")).toBe(430);
    expect(by("kvOperationsAdaptiveGroups", "deletes")).toBe(97);
    expect(by("kvOperationsAdaptiveGroups", "lists")).toBe(24);
    expect(by("durableObjectsPeriodicGroups", "durationGbs")).toBe(12.5);
    expect(by("durableObjectsPeriodicGroups", "rowsWritten")).toBe(40);
    expect(by("workflowsAdaptiveGroups", "steps")).toBe(128);
    expect(by("workersAnalyticsEngineAdaptiveGroups", "dataPoints")).toBe(2);
    // No use, no total: an empty answer, a zero, a null.
    expect(by("durableObjectsPeriodicGroups", "rowsRead")).toBeUndefined();
    expect(by("durableObjectsInvocationsAdaptiveGroups", "requests")).toBeUndefined();
    expect(
      by("browserRenderingBrowserTimeUsageAdaptiveGroups", "sessionDurationMs"),
    ).toBeUndefined();
    expect(totals).toHaveLength(11);
  });

  it("adds up several rows of one metric", async () => {
    const { usage } = make((s) =>
      s.dataset === "d1AnalyticsAdaptiveGroups"
        ? [{ sum: { rowsRead: 1, rowsWritten: 2 } }, { sum: { rowsRead: 3, rowsWritten: 4 } }]
        : [],
    );
    expect((await usage.accountTotals({ from: DAY })).totals).toEqual([
      { dataset: "d1AnalyticsAdaptiveGroups", metric: "rowsRead", value: 4 },
      { dataset: "d1AnalyticsAdaptiveGroups", metric: "rowsWritten", value: 6 },
    ]);
  });

  it("reads nothing for an empty range", async () => {
    const { usage, log } = make(() => []);
    expect(await usage.accountTotals({ from: NOW, to: NOW })).toEqual({ totals: [], failed: [] });
    expect(log).toHaveLength(0);
  });

  it("reads only the datasets asked for", async () => {
    const { usage, log } = make((s) => TOTAL_ROWS[s.dataset] ?? []);
    const { totals } = await usage.accountTotals({
      from: DAY,
      datasets: ["d1AnalyticsAdaptiveGroups", "workersInvocationsAdaptive"],
    });
    expect(log.map((s) => s.dataset).sort()).toEqual([
      "d1AnalyticsAdaptiveGroups",
      "workersInvocationsAdaptive",
    ]);
    expect(totals.map((t) => t.metric).sort()).toEqual(["requests", "rowsRead", "rowsWritten"]);
    expect(await usage.accountTotals({ from: DAY, datasets: [] })).toEqual({
      totals: [],
      failed: [],
    });
  });

  it("leaves out a dataset that fails and keeps the others", async () => {
    const { usage } = make((s) => {
      if (s.dataset === "aiInferenceAdaptiveGroups") throw new Error("no AI here");
      return TOTAL_ROWS[s.dataset] ?? [];
    });
    const { totals, failed } = await usage.accountTotals({ from: DAY });
    expect(failed.map((f) => f.dataset)).toEqual(["aiInferenceAdaptiveGroups"]);
    expect(totals.find((t) => t.metric === "rowsWritten" && t.value === 90152)).toBeDefined();
  });

  it("fails when every dataset's request fails", async () => {
    const http = createHttpApi({
      accountId: ACCOUNT,
      token: "t",
      fetch: async () =>
        new Response(
          JSON.stringify({
            data: null,
            errors: [{ message: "not authorized", extensions: { code: "authz" } }],
          }),
        ),
    });
    const error = await createUsage(http, { now: () => NOW_MS })
      .accountTotals({ from: DAY })
      .catch((e: unknown) => e);
    expect(error).toBeInstanceOf(CloudflareGraphQLError);
  });

  it("goes out in the same combined query as the reads started with it", async () => {
    const bodies: Array<{ query: string; variables: Record<string, Record<string, unknown>> }> = [];
    const fetch = async (input: string, init?: RequestInit) => {
      const body = (await new Request(input, init).json()) as (typeof bodies)[number];
      bodies.push(body);
      const fields = [...body.query.matchAll(/(\w+): (\w+)\(limit/g)];
      const account = Object.fromEntries(
        fields.map(([, alias, dataset]) => [alias, TOTAL_ROWS[dataset ?? ""] ?? []]),
      );
      return new Response(JSON.stringify({ data: { viewer: { accounts: [account] } } }), {
        headers: { "Content-Type": "application/json" },
      });
    };
    const http = createHttpApi({ accountId: ACCOUNT, token: "t", fetch });
    const usage = createUsage(http, { now: () => NOW_MS }).batched();
    const [workers, totals] = await Promise.all([
      usage.workers({ ids: ["a"], from: NOW - 3 * H }),
      usage.accountTotals({ from: DAY }),
    ]);
    expect(bodies).toHaveLength(1);
    const query = bodies[0]?.query ?? "";
    // The app's read by resource and hour, then one field per dataset of the totals.
    expect(query).toContain(
      "r0: workersInvocationsAdaptive(limit: 10000, filter: $f0) {\n        dimensions { scriptName datetimeHour }\n        sum { requests subrequests errors cpuTimeUs }",
    );
    expect(query).toContain(
      "r1: workersInvocationsAdaptive(limit: 10000, filter: $f1) {\n        sum { requests }\n      }",
    );
    expect(query).toContain(
      "r4: d1AnalyticsAdaptiveGroups(limit: 10000, filter: $f4) {\n        sum { rowsRead rowsWritten }\n      }",
    );
    expect(query).toContain("dimensions { actionType }");
    expect([...query.matchAll(/ r\d+: /g)]).toHaveLength(11);
    expect(bodies[0]?.variables.f0?.scriptName_in).toEqual(["a"]);
    expect(bodies[0]?.variables.f4?.datetime_geq).toBe("2026-10-12T00:00:00.000Z");
    expect(workers).toEqual([]);
    expect(
      totals.totals.find((t) => t.metric === "rowsWritten" && t.value === 90152),
    ).toBeDefined();
  });
});
