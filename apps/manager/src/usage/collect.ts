import type { CloudflareClient, UsageDataset, UsageRow, UsageTotals } from "@appflare/cf-api";
import { ACCOUNT_DAY_PRODUCTS, type AccountDay } from "./account-day";
import { dayStart, PRODUCTS, type ProductKey } from "./math";

/**
 * The spend watcher's collector: what each installed app used of each
 * product, hour by hour, read from Cloudflare's GraphQL Analytics through
 * cf-api's `usage` and turned into the usage math's products.
 *
 * Every dataset is read once per check for all apps together (the resource
 * ids of every app in one request), never once per app. Usage is attributed
 * by resource id: Worker names, Durable Object namespace ids, D1 and KV ids,
 * bucket, queue, index and dataset names, container application ids. Workers
 * AI cannot be attributed by any API, so the account's AI use is split
 * evenly across the apps that bind AI.
 *
 * Pure apart from the reads: no storage here. Times are unix seconds, like
 * the usage tables; `hour` is the start of a UTC hour.
 */

export const HOUR = 3_600;

/** The resources of one app, from its install record. */
export interface AppResources {
  installId: string;
  /** Worker script names. */
  workers: string[];
  /** Durable Object namespace ids. */
  durableObjects: string[];
  d1: string[];
  kv: string[];
  /** Bucket names. */
  r2: string[];
  queues: string[];
  /** Workflow names. */
  workflows: string[];
  /** Index names. */
  vectorize: string[];
  /** Analytics Engine dataset names. */
  analyticsEngine: string[];
  /** Container application ids. */
  containers: string[];
  /** The app binds Workers AI. */
  ai: boolean;
  /** The app binds Browser Rendering. */
  browser: boolean;
}

/** An app and the first hour the check reads for it. */
export interface CollectTarget extends AppResources {
  /** Unix second of the first hour to read (an hour start). */
  from: number;
  /**
   * The level of each storage product in the hour before `from`, from what
   * is stored: carried forward when Cloudflare has no newer sample.
   */
  levelsBefore?: Partial<Record<ProductKey, number>>;
  /**
   * Sources the check could not prepare for this app (the account's Durable
   * Object namespaces could not be listed, say): their products are left
   * out for it, as if their read had failed.
   */
  unread?: readonly CollectSource[];
}

/**
 * The reads a check makes, each settled on its own: a read that fails
 * leaves out only the products it covers, for the apps it covers.
 */
export type CollectSource =
  | "workers"
  | "durableObjects"
  | "d1"
  | "kv"
  | "r2"
  | "queues"
  | "workflows"
  | "vectorize"
  | "analyticsEngine"
  | "containers"
  | "browser"
  | "ai"
  | "alarms"
  | "account";

/**
 * The products each source gives to apps (the alarm read is a signal; the
 * account's totals are no app's).
 */
export const SOURCE_PRODUCTS: Readonly<Record<CollectSource, readonly ProductKey[]>> = {
  workers: ["workers_requests", "workers_cpu_ms"],
  durableObjects: ["do_requests", "do_duration", "do_rows_read", "do_rows_written", "do_storage"],
  d1: ["d1_rows_read", "d1_rows_written", "d1_storage"],
  kv: ["kv_reads", "kv_writes", "kv_deletes", "kv_lists", "kv_storage"],
  r2: ["r2_class_a", "r2_class_b", "r2_storage"],
  queues: ["queues_operations"],
  workflows: ["workflow_steps"],
  vectorize: ["vectorize_queried_dimensions", "vectorize_stored_dimensions"],
  analyticsEngine: ["analytics_engine_data_points"],
  containers: ["containers_memory", "containers_cpu", "containers_disk"],
  browser: ["browser_hours"],
  ai: ["ai_neurons"],
  alarms: [],
  account: [],
};

/** A read that failed: which, for which apps, and why. */
export interface CollectFailure {
  source: CollectSource;
  installIds: string[];
  error: unknown;
}

/**
 * The usage reads the collector makes (cf-api `client.usage`), and
 * optionally a reader that sends the reads started together as one request
 * (`batched`), which the collector uses when there is one.
 */
export type UsageReader = UsageReads & { batched?: () => UsageReads };

type UsageReads = Pick<
  CloudflareClient["usage"],
  | "workers"
  | "durableObjects"
  | "durableObjectAlarmPeaks"
  | "d1"
  | "kv"
  | "r2"
  | "queues"
  | "workflows"
  | "workersAi"
  | "vectorize"
  | "analyticsEngine"
  | "browserRendering"
  | "containers"
> &
  Partial<Pick<CloudflareClient["usage"], "accountTotals">>;

/** One product of one app in one hour. */
export interface CollectedHour {
  installId: string;
  product: ProductKey;
  hour: number;
  value: number;
}

export interface Collected {
  /** Every hour from each app's `from` through the current hour that has a value. */
  hours: CollectedHour[];
  /**
   * Alarms of the busiest Durable Object of each namespace over the last 60
   * minutes, by app (for the loop check's alarm signal).
   */
  alarms: Map<string, Array<{ object: string; alarms: number }>>;
  /** GraphQL datasets read: one request each, unless an answer had to be split. */
  queries: number;
  /** Reads that failed; their products are missing for the apps they cover. */
  failures: CollectFailure[];
  /** Reads that answered. */
  succeeded: number;
  /**
   * The whole account's totals since 00:00 UTC (account-day.ts), when asked
   * for and some were read; null otherwise.
   */
  accountTotals: UsageTotals | null;
  /**
   * Apps some of whose usage this check could not read (a failed read, or
   * an `unread` source): their missing products keep their stored values,
   * and nothing about them should be concluded from their absence.
   */
  incomplete: Set<string>;
}

/** Hours before the earliest `from` that storage reads look back for a sample to carry. */
export const LEVEL_LOOKBACK_HOURS = 3;

const GB = 1e9;
const GIB = 2 ** 30;

/** R2 operations by class (developers.cloudflare.com/r2/pricing/); the rest are free. */
const R2_CLASS_A = new Set([
  "ListBuckets",
  "PutBucket",
  "ListObjects",
  "PutObject",
  "CopyObject",
  "CompleteMultipartUpload",
  "CreateMultipartUpload",
  "LifecycleStorageTierTransition",
  "ListMultipartUploads",
  "UploadPart",
  "UploadPartCopy",
  "ListParts",
  "PutBucketEncryption",
  "PutBucketCors",
  "PutBucketLifecycleConfiguration",
]);
const R2_CLASS_B = new Set([
  "HeadBucket",
  "HeadObject",
  "GetObject",
  "UsageSummary",
  "GetBucketEncryption",
  "GetBucketLocation",
  "GetBucketCors",
  "GetBucketLifecycleConfiguration",
]);

/**
 * The product and amount a usage row adds to, in the units the usage math
 * uses (GB = 10^9 bytes, GiB = 2^30), or null for a metric no product prices:
 * subrequests and errors, a Workflow's CPU time and starts (counted as its
 * Worker's), WebSocket message counts (part of Durable Object
 * requests), key-value Durable Object storage units, free R2 operations,
 * Vectorize query counts, container egress, Browser Rendering sessions.
 */
export function productOf(
  row: Pick<UsageRow, "dataset" | "metric" | "value">,
): [ProductKey, number] | null {
  const v = row.value;
  switch (row.dataset) {
    case "workersInvocationsAdaptive":
      if (row.metric === "requests") return ["workers_requests", v];
      if (row.metric === "cpuTimeUs") return ["workers_cpu_ms", v / 1000];
      return null;
    case "durableObjectsInvocationsAdaptiveGroups":
      return row.metric === "requests" ? ["do_requests", v] : null;
    case "durableObjectsPeriodicGroups":
      if (row.metric === "durationGbs") return ["do_duration", v];
      if (row.metric === "rowsRead") return ["do_rows_read", v];
      if (row.metric === "rowsWritten") return ["do_rows_written", v];
      return null;
    case "durableObjectsSqlStorageGroups":
      return row.metric === "storedBytes" ? ["do_storage", v / GB] : null;
    case "d1AnalyticsAdaptiveGroups":
      if (row.metric === "rowsRead") return ["d1_rows_read", v];
      if (row.metric === "rowsWritten") return ["d1_rows_written", v];
      return null;
    case "d1StorageAdaptiveGroups":
      return row.metric === "storedBytes" ? ["d1_storage", v / GB] : null;
    case "kvOperationsAdaptiveGroups":
      if (row.metric === "reads") return ["kv_reads", v];
      if (row.metric === "writes") return ["kv_writes", v];
      if (row.metric === "deletes") return ["kv_deletes", v];
      if (row.metric === "lists") return ["kv_lists", v];
      return null;
    case "kvStorageAdaptiveGroups":
      return row.metric === "storedBytes" ? ["kv_storage", v / GB] : null;
    case "r2OperationsAdaptiveGroups":
      if (R2_CLASS_A.has(row.metric)) return ["r2_class_a", v];
      if (R2_CLASS_B.has(row.metric)) return ["r2_class_b", v];
      return null;
    case "r2StorageAdaptiveGroups":
      return row.metric === "storedBytes" ? ["r2_storage", v / GB] : null;
    case "queueMessageOperationsAdaptiveGroups":
      return row.metric === "operations" ? ["queues_operations", v] : null;
    // A Workflow's CPU time and starts are billed as its Worker's, which the
    // Workers dataset already counts; only its steps are a meter of their own.
    case "workflowsAdaptiveGroups":
      return row.metric === "steps" ? ["workflow_steps", v] : null;
    case "aiInferenceAdaptiveGroups":
      return row.metric === "neurons" ? ["ai_neurons", v] : null;
    case "vectorizeV2QueriesAdaptiveGroups":
      return row.metric === "queriedVectorDimensions" ? ["vectorize_queried_dimensions", v] : null;
    case "vectorizeV2StorageAdaptiveGroups":
      return row.metric === "storedVectorDimensions" ? ["vectorize_stored_dimensions", v] : null;
    case "workersAnalyticsEngineAdaptiveGroups":
      return row.metric === "dataPoints" ? ["analytics_engine_data_points", v] : null;
    case "browserRenderingBrowserTimeUsageAdaptiveGroups":
      return row.metric === "sessionDurationMs" ? ["browser_hours", v / 3_600_000] : null;
    case "containersUsageAdaptiveGroups":
      if (row.metric === "allocatedMemoryByteSeconds") return ["containers_memory", v / GIB];
      if (row.metric === "allocatedDiskByteSeconds") return ["containers_disk", v / GB];
      if (row.metric === "cpuTimeSec") return ["containers_cpu", v];
      return null;
    default:
      return null;
  }
}

/** The dataset each product of a reading of the account's day comes from. */
export const ACCOUNT_DAY_DATASETS: Readonly<Record<string, UsageDataset>> = {
  workers_requests: "workersInvocationsAdaptive",
  do_requests: "durableObjectsInvocationsAdaptiveGroups",
  do_duration: "durableObjectsPeriodicGroups",
  do_rows_read: "durableObjectsPeriodicGroups",
  do_rows_written: "durableObjectsPeriodicGroups",
  d1_rows_read: "d1AnalyticsAdaptiveGroups",
  d1_rows_written: "d1AnalyticsAdaptiveGroups",
  kv_reads: "kvOperationsAdaptiveGroups",
  kv_writes: "kvOperationsAdaptiveGroups",
  kv_deletes: "kvOperationsAdaptiveGroups",
  kv_lists: "kvOperationsAdaptiveGroups",
  queues_operations: "queueMessageOperationsAdaptiveGroups",
  workflow_steps: "workflowsAdaptiveGroups",
  analytics_engine_data_points: "workersAnalyticsEngineAdaptiveGroups",
  browser_hours: "browserRenderingBrowserTimeUsageAdaptiveGroups",
};

/**
 * The datasets a reading asks for: only those of products with a Free daily
 * limit (`ACCOUNT_DAY_PRODUCTS`), each once. Every field counts against
 * Cloudflare's GraphQL quota.
 */
export const ACCOUNT_DAY_READ: readonly UsageDataset[] = [
  ...new Set(
    ACCOUNT_DAY_PRODUCTS.flatMap((key) => {
      const dataset = ACCOUNT_DAY_DATASETS[key];
      return dataset === undefined ? [] : [dataset];
    }),
  ),
];

/**
 * A reading of the account's day (account-day.ts) from cf-api's
 * `accountTotals`, taken at `at` (epoch ms). A product whose dataset could
 * not be read is left out, so its limit counts Appflare's apps alone.
 */
export function accountDayFrom(read: UsageTotals, at: number): AccountDay {
  const failed = new Set(read.failed.map((f) => f.dataset));
  const used: Record<string, number> = {};
  for (const key of ACCOUNT_DAY_PRODUCTS) {
    const dataset = ACCOUNT_DAY_DATASETS[key];
    if (dataset !== undefined && !failed.has(dataset)) used[key] = 0;
  }
  for (const total of read.totals) {
    const mapped = productOf(total);
    if (mapped === null) continue;
    const [key, value] = mapped;
    const before = used[key];
    if (before !== undefined) used[key] = before + value;
  }
  return { at, used };
}

export function isLevel(product: ProductKey): boolean {
  return PRODUCTS[product].measure === "level";
}

/** The level products, for the store's daily roll-up. */
export const LEVEL_PRODUCTS: readonly ProductKey[] = (Object.keys(PRODUCTS) as ProductKey[]).filter(
  isLevel,
);

type ResourceList = Exclude<keyof AppResources, "installId" | "ai" | "browser">;

/** Which app each resource id of a kind belongs to (the first app that lists it). */
function owners(targets: readonly CollectTarget[], kind: ResourceList): Map<string, string> {
  const out = new Map<string, string>();
  for (const t of targets) {
    for (const id of t[kind]) if (!out.has(id)) out.set(id, t.installId);
  }
  return out;
}

/**
 * Ids are compared as the API lists them, but Cloudflare may answer a UUID
 * with or without dashes; cf-api hands rows back under the id as given, so
 * plain lookup works.
 */
const ids = (m: Map<string, string>) => [...m.keys()];

interface Reading {
  /** By app, product, resource and hour. */
  values: Map<string, Map<ProductKey, Map<string, Map<number, number>>>>;
}

/** The map's value for `key`, made and stored first when missing. */
export function entry<K, V>(map: Map<K, V>, key: K, make: () => V): V {
  const found = map.get(key);
  if (found !== undefined) return found;
  const made = make();
  map.set(key, made);
  return made;
}

function add(
  reading: Reading,
  installId: string,
  product: ProductKey,
  resource: string,
  hour: number,
  value: number,
): void {
  const byProduct = entry(reading.values, installId, () => new Map());
  const byResource = entry(byProduct, product, () => new Map());
  const byHour = entry(byResource, resource, () => new Map<number, number>());
  // A level is the largest size in the hour (several rows of one hour are
  // storage classes already summed by cf-api); counts add up.
  byHour.set(
    hour,
    isLevel(product) ? Math.max(byHour.get(hour) ?? 0, value) : (byHour.get(hour) ?? 0) + value,
  );
}

function attribute(reading: Reading, rows: readonly UsageRow[], owner: Map<string, string>): void {
  for (const row of rows) {
    const installId = owner.get(row.resourceId);
    const mapped = productOf(row);
    if (installId === undefined || mapped === null) continue;
    add(reading, installId, mapped[0], `${row.dataset}:${row.resourceId}`, row.hour, mapped[1]);
  }
}

/**
 * Reads every dataset any app has resources in, for `[from, now]` where
 * `from` is the earliest app's (storage a few hours earlier, to find a
 * sample to carry forward), and returns each app's products per hour from
 * its own `from`. Counts are hours with use; a storage product has a value
 * for every hour from the app's first sample (or `levelsBefore`) on, the
 * latest sample carried into hours without one.
 *
 * With `accountTotals` (Workers Free), it also reads the whole account's
 * totals since 00:00 UTC for the free daily limits, in the same request as
 * the rest: one dataset field each, one summed row each.
 */
export async function collectUsage(
  reader: UsageReader,
  targets: readonly CollectTarget[],
  now: number,
  options: { accountTotals?: boolean } = {},
): Promise<Collected> {
  const collected: Collected = {
    hours: [],
    alarms: new Map(),
    queries: 0,
    failures: [],
    succeeded: 0,
    incomplete: new Set(),
    accountTotals: null,
  };
  if (targets.length === 0) return collected;
  // Every read below starts in this turn: batched, they go out as one request.
  const usage = reader.batched?.() ?? reader;
  const earliest = Math.min(...targets.map((t) => t.from));
  const range = { from: earliest - LEVEL_LOOKBACK_HOURS * HOUR, to: now };
  const reading: Reading = { values: new Map() };

  const workers = owners(targets, "workers");
  const durableObjects = owners(targets, "durableObjects");
  const plain: Array<
    [ResourceList, (q: { ids: string[]; from: number; to: number }) => Promise<UsageRow[]>, number]
  > = [
    ["workers", (q) => usage.workers(q), 1],
    ["durableObjects", (q) => usage.durableObjects(q), 3],
    ["d1", (q) => usage.d1(q), 2],
    ["kv", (q) => usage.kv(q), 2],
    ["r2", (q) => usage.r2(q), 2],
    ["queues", (q) => usage.queues(q), 1],
    ["workflows", (q) => usage.workflows(q), 1],
    ["vectorize", (q) => usage.vectorize(q), 2],
    ["analyticsEngine", (q) => usage.analyticsEngine(q), 1],
    ["containers", (q) => usage.containers(q), 1],
  ];
  const reads: Array<Promise<void>> = [];
  /** Products left out per app: those of the sources that failed for it. */
  const missing = new Map<string, Set<ProductKey>>();
  const leaveOut = (installId: string, source: CollectSource) => {
    collected.incomplete.add(installId);
    const set = missing.get(installId) ?? new Set<ProductKey>();
    for (const product of SOURCE_PRODUCTS[source]) set.add(product);
    missing.set(installId, set);
  };
  for (const t of targets) for (const source of t.unread ?? []) leaveOut(t.installId, source);
  /** Runs one read; a failure is recorded against the apps it covers. */
  const settle = (source: CollectSource, installIds: Iterable<string>, read: Promise<void>) => {
    const covered = [...new Set(installIds)];
    reads.push(
      read.then(
        () => {
          collected.succeeded += 1;
        },
        (error: unknown) => {
          collected.failures.push({ source, installIds: covered, error });
          for (const id of covered) leaveOut(id, source);
        },
      ),
    );
  };
  for (const [kind, read, datasets] of plain) {
    const owner =
      kind === "workers"
        ? workers
        : kind === "durableObjects"
          ? durableObjects
          : owners(targets, kind);
    if (owner.size === 0) continue;
    collected.queries += datasets;
    settle(
      kind as CollectSource,
      owner.values(),
      read({ ids: ids(owner), ...range }).then((rows) => attribute(reading, rows, owner)),
    );
  }

  // Browser Rendering is read by Worker name, for the apps that bind it.
  const browserOwners = new Map<string, string>();
  for (const t of targets) {
    if (!t.browser) continue;
    for (const w of t.workers) if (!browserOwners.has(w)) browserOwners.set(w, t.installId);
  }
  if (browserOwners.size > 0) {
    collected.queries += 2;
    settle(
      "browser",
      browserOwners.values(),
      usage
        .browserRendering({ ids: ids(browserOwners), ...range })
        .then((rows) => attribute(reading, rows, browserOwners)),
    );
  }

  // Workers AI: the account's use, split evenly across the apps that bind it.
  const aiApps = targets.filter((t) => t.ai).map((t) => t.installId);
  if (aiApps.length > 0) {
    collected.queries += 1;
    settle(
      "ai",
      aiApps,
      usage.workersAi(range).then((rows) => {
        for (const row of rows) {
          const mapped = productOf(row);
          if (mapped === null) continue;
          for (const installId of aiApps) {
            add(
              reading,
              installId,
              mapped[0],
              `ai:${row.resourceId}`,
              row.hour,
              mapped[1] / aiApps.length,
            );
          }
        }
      }),
    );
  }

  // The loop check's alarm signal: the busiest object per namespace, this
  // hour and the one before.
  const hourNow = Math.floor(now / HOUR) * HOUR;
  if (durableObjects.size > 0) {
    collected.queries += 1;
    settle(
      "alarms",
      durableObjects.values(),
      usage
        .durableObjectAlarmPeaks({ ids: ids(durableObjects), from: hourNow - HOUR, to: now })
        .then((rows) => {
          const into = (now - hourNow) / HOUR;
          const perNamespace = new Map<string, number>();
          for (const row of rows) {
            if (row.metric !== "busiestObjectAlarms") continue;
            // The last 60 minutes: this hour so far, and the part of the
            // previous hour still inside them (as if spread evenly).
            const weight = row.hour === hourNow ? 1 : row.hour === hourNow - HOUR ? 1 - into : 0;
            perNamespace.set(
              row.resourceId,
              (perNamespace.get(row.resourceId) ?? 0) + row.value * weight,
            );
          }
          for (const [namespace, alarms] of perNamespace) {
            const installId = durableObjects.get(namespace);
            if (installId === undefined) continue;
            const list = collected.alarms.get(installId) ?? [];
            list.push({ object: namespace, alarms: Math.round(alarms) });
            collected.alarms.set(installId, list);
          }
        }),
    );
  }

  // The account's totals for the free daily limits: no app's, so a failure
  // leaves every app's usage complete.
  if (options.accountTotals && usage.accountTotals !== undefined) {
    collected.queries += ACCOUNT_DAY_READ.length;
    settle(
      "account",
      [],
      usage
        .accountTotals({ from: dayStart(now * 1000) / 1000, to: now, datasets: ACCOUNT_DAY_READ })
        .then((read) => {
          collected.accountTotals = read;
          // Some datasets answered: the reading leaves the others' products out.
          const [first] = read.failed;
          if (first !== undefined) {
            collected.failures.push({ source: "account", installIds: [], error: first.error });
          }
        }),
    );
  }
  await Promise.all(reads);

  for (const t of targets) {
    const byProduct = reading.values.get(t.installId) ?? new Map();
    const products = new Set<ProductKey>([
      ...byProduct.keys(),
      ...(Object.keys(t.levelsBefore ?? {}) as ProductKey[]),
    ]);
    const left = missing.get(t.installId);
    for (const product of products) {
      if (left?.has(product)) continue;
      const byResource = byProduct.get(product) ?? new Map<string, Map<number, number>>();
      if (!isLevel(product)) {
        const sums = new Map<number, number>();
        for (const byHour of byResource.values()) {
          for (const [hour, value] of byHour) {
            if (hour < t.from || hour > hourNow) continue;
            sums.set(hour, (sums.get(hour) ?? 0) + value);
          }
        }
        for (const [hour, value] of sums) {
          if (value > 0) collected.hours.push({ installId: t.installId, product, hour, value });
        }
        continue;
      }
      // Storage: each resource's latest sample at or before the hour; the
      // stored level before `from` when no resource has one.
      const resources = [...byResource.values()].map((byHour) =>
        [...byHour].sort(([a], [b]) => a - b),
      );
      const before = t.levelsBefore?.[product];
      for (let hour = t.from; hour <= hourNow; hour += HOUR) {
        let total = 0;
        let seen = false;
        for (const samples of resources) {
          let latest: number | undefined;
          for (const [h, v] of samples) {
            if (h > hour) break;
            latest = v;
          }
          if (latest !== undefined) {
            total += latest;
            seen = true;
          }
        }
        if (!seen) {
          if (before === undefined) continue;
          total = before;
        }
        collected.hours.push({ installId: t.installId, product, hour, value: total });
      }
    }
  }
  return collected;
}
