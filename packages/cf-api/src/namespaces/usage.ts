import {
  CloudflareGraphQLError,
  createGraphQL,
  GRAPHQL_PATH,
  type GraphQLClient,
  type GraphQLErrorItem,
} from "../graphql";
import type { HttpApi } from "../http";

/**
 * Usage of an account's resources, hour by hour, from Cloudflare's GraphQL
 * Analytics API. Each function reads one product for a list of resource ids
 * and returns {@link UsageRow}s: one value per metric, resource and UTC hour.
 *
 * Dataset and field names, units, and the id formats each dataset answers
 * with were checked by introspection and live queries on a Workers Free and a
 * Workers Paid account (2026-10-12). Things every caller should know:
 *
 * - Cloudflare caches an answer per query and variables for 20 minutes or
 *   more. Every request here carries the current time as `datetime_leq`, so
 *   no two requests are the same and every answer is fresh.
 * - Usage is attributed by resource id, never by Worker name alone: the
 *   analytics show a brand-new Worker as `__unknown__` (name and tag) for its
 *   first minutes, and a brand-new Durable Object namespace is absent for
 *   10 to 20 minutes before its rows are filled in.
 * - The analytics of a Durable Object namespace disappear when the
 *   namespace or its Worker is deleted. Keep your own copy of what you read.
 * - Rows arrive about a minute late, so the latest hour is incomplete; a
 *   later read of the same hour returns the larger, settled number.
 * - Each dataset answers only for its last 31 to 90 days
 *   ({@link USAGE_RETENTION_DAYS}); a range starting earlier is read from
 *   the oldest hour it still has. It answers at most 10,000 rows per
 *   request; ranges are split into windows of at most 30 days and split
 *   again until each answer fits.
 */

/** The GraphQL datasets the rows come from (the `dataset` of a {@link UsageRow}). */
export type UsageDataset =
  | "workersInvocationsAdaptive"
  | "durableObjectsInvocationsAdaptiveGroups"
  | "durableObjectsPeriodicGroups"
  | "durableObjectsSqlStorageGroups"
  | "d1AnalyticsAdaptiveGroups"
  | "d1StorageAdaptiveGroups"
  | "kvOperationsAdaptiveGroups"
  | "kvStorageAdaptiveGroups"
  | "r2OperationsAdaptiveGroups"
  | "r2StorageAdaptiveGroups"
  | "queueMessageOperationsAdaptiveGroups"
  | "workflowsAdaptiveGroups"
  | "aiInferenceAdaptiveGroups"
  | "vectorizeV2QueriesAdaptiveGroups"
  | "vectorizeV2StorageAdaptiveGroups"
  | "workersAnalyticsEngineAdaptiveGroups"
  | "browserRenderingEventsAdaptiveGroups"
  | "browserRenderingBrowserTimeUsageAdaptiveGroups"
  | "containersUsageAdaptiveGroups";

/** One metric of one resource in one UTC hour. */
export interface UsageRow {
  dataset: UsageDataset;
  /** What `value` counts; each function lists its metrics and their units. */
  metric: string;
  /** The id (or name) the caller asked about, exactly as it was given. */
  resourceId: string;
  /** Start of the UTC hour, in Unix seconds. */
  hour: number;
  /**
   * A count or total for the hour (never 0: an hour without any has no
   * row), or for a stored-size metric (0 included) the largest
   * size seen in the hour.
   */
  value: number;
}

/** The resources to read and the time range. */
export interface UsageQuery {
  /** The resources' ids or names, as each function describes. Empty reads nothing. */
  ids: readonly string[];
  /** Start, in Unix seconds; rounded down to the start of its UTC hour. */
  from: number;
  /** End (exclusive), in Unix seconds; defaults to now and never passes it. */
  to?: number;
}

/** A time range alone, for products the analytics cannot split by resource. */
export type UsageRange = Omit<UsageQuery, "ids">;

/**
 * Thrown when one resource has more rows in one hour than one answer can
 * hold (10,000), so the hour cannot be read completely. No product read here
 * comes near that unless a dimension other than the hour multiplies rows.
 */
export class UsageRowLimitError extends Error {
  constructor(dataset: UsageDataset) {
    super(`${dataset}: one resource has more rows in one hour than one answer can hold`);
    this.name = "UsageRowLimitError";
  }
}

/** The most rows a dataset answers with per request (`maxPageSize`, read on both plans). */
export const USAGE_MAX_ROWS = 10_000;
/** Resource ids per request (`_in` filter); Cloudflare accepted 5,000 when tried. */
export const USAGE_ID_BATCH = 100;
/** Longest window per request, in hours; datasets allow 31 or 32 days. */
export const USAGE_MAX_WINDOW_HOURS = 30 * 24;

const HOUR = 3600;

/**
 * How far back each dataset answers, in days (its `notOlderThan`, read on a
 * Workers Free and a Workers Paid account: the same on both). A request
 * reaching further back is refused as a whole, so reads start no earlier.
 */
export const USAGE_RETENTION_DAYS: Readonly<Record<UsageDataset, number>> = {
  workersInvocationsAdaptive: 90,
  durableObjectsInvocationsAdaptiveGroups: 90,
  durableObjectsPeriodicGroups: 90,
  durableObjectsSqlStorageGroups: 90,
  d1AnalyticsAdaptiveGroups: 90,
  d1StorageAdaptiveGroups: 90,
  kvOperationsAdaptiveGroups: 90,
  kvStorageAdaptiveGroups: 90,
  r2OperationsAdaptiveGroups: 90,
  r2StorageAdaptiveGroups: 90,
  queueMessageOperationsAdaptiveGroups: 90,
  workflowsAdaptiveGroups: 32,
  aiInferenceAdaptiveGroups: 32,
  vectorizeV2QueriesAdaptiveGroups: 32,
  vectorizeV2StorageAdaptiveGroups: 32,
  workersAnalyticsEngineAdaptiveGroups: 31,
  browserRenderingEventsAdaptiveGroups: 32,
  browserRenderingBrowserTimeUsageAdaptiveGroups: 32,
  containersUsageAdaptiveGroups: 32,
};

/**
 * The earliest hour start a dataset still answers for: its retention back
 * from now, rounded up to the next hour, with a minute to spare for the
 * time the request takes to arrive.
 */
function oldestHour(dataset: UsageDataset, now: number): number {
  const oldest = now - USAGE_RETENTION_DAYS[dataset] * 24 * HOUR + 60;
  return Math.ceil(oldest / HOUR) * HOUR;
}

/** A raw answer row: the requested dimensions and aggregates. */
interface RawRow {
  dimensions: Record<string, string | number | null | undefined>;
  sum?: Record<string, number | null | undefined>;
  max?: Record<string, number | null | undefined>;
  count?: number | null;
}

interface DatasetSpec {
  dataset: UsageDataset;
  /** The dimension (and `<idField>_in` filter) that names the resource. */
  idField: string;
  /** Ids are UUIDs or hex: compare them without dashes, in lower case. */
  idsAreUuids?: boolean;
  /** Send ids without dashes (KV operations match only that form). */
  sendWithoutDashes?: boolean;
  /** More dimensions to group by. */
  dimensions?: readonly string[];
  /** The aggregates to select, such as `sum { requests }`. */
  select: string;
  /** Fixed filter conditions added to every request. */
  filter?: Record<string, unknown>;
  /** Sorting, for reads where a cut-off answer still holds what is needed. */
  orderBy?: string;
  /** The metrics are stored sizes: a size of 0 is kept, a count of 0 is not. */
  sizes?: boolean;
  /** How rows for the same metric, resource and hour combine. Default `sum`. */
  combine?: "sum" | "max";
  /** The metrics of one raw row. */
  metrics(row: RawRow): Array<[metric: string, value: number]>;
}

const num = (value: unknown): number =>
  typeof value === "number" && Number.isFinite(value) ? value : 0;

const uuidKey = (id: string): string => id.replaceAll("-", "").toLowerCase();

const filterType = (dataset: string): string =>
  `Account${dataset.charAt(0).toUpperCase()}${dataset.slice(1)}Filter_InputObject`;

/**
 * What one request asks a dataset for: the dimensions its rows are grouped
 * by (none for one total row) and the aggregates.
 */
interface FieldSpec {
  dataset: UsageDataset;
  groupBy: readonly string[];
  select: string;
  orderBy?: string;
}

/** A read by resource and hour: grouped by the resource's id, the hour and its own dimensions. */
function byResource(spec: DatasetSpec): FieldSpec {
  return {
    dataset: spec.dataset,
    groupBy: [spec.idField, "datetimeHour", ...(spec.dimensions ?? [])],
    select: spec.select,
    ...(spec.orderBy === undefined ? {} : { orderBy: spec.orderBy }),
  };
}

function selection(field: FieldSpec): string {
  const dims =
    field.groupBy.length > 0 ? `dimensions { ${field.groupBy.join(" ")} }\n        ` : "";
  return `${dims}${field.select}`;
}

function queryText(field: FieldSpec): string {
  const order = field.orderBy ? `, orderBy: ${field.orderBy}` : "";
  return `query Usage($accountTag: string!, $filter: ${filterType(field.dataset)}!) {
  viewer {
    accounts(filter: { accountTag: $accountTag }) {
      rows: ${field.dataset}(limit: ${USAGE_MAX_ROWS}, filter: $filter${order}) {
        ${selection(field)}
      }
    }
  }
}`;
}

interface Answer {
  viewer: { accounts: Array<{ rows: RawRow[] }> };
}

/** One dataset's field in a combined query, as alias `r<i>` with filter `$f<i>`. */
function fieldText(field: FieldSpec, i: number): string {
  const order = field.orderBy ? `, orderBy: ${field.orderBy}` : "";
  return `r${i}: ${field.dataset}(limit: ${USAGE_MAX_ROWS}, filter: $f${i}${order}) {
        ${selection(field)}
      }`;
}

/** Several datasets' requests as one query: each its own aliased field and filter variable. */
function combinedQueryText(fields: readonly FieldSpec[]): string {
  const vars = fields.map((f, i) => `$f${i}: ${filterType(f.dataset)}!`).join(", ");
  return `query Usage($accountTag: string!, ${vars}) {
  viewer {
    accounts(filter: { accountTag: $accountTag }) {
      ${fields.map((f, i) => fieldText(f, i)).join("\n      ")}
    }
  }
}`;
}

/**
 * Requests in one combined query at most; more go in further queries. A
 * check of every product an app can use, with the account's daily totals,
 * is about 30 fields. Cloudflare limits the fields ("nodes") per request
 * without publishing the number, and answered 32 in one query on a Workers
 * Free account (2026-10-13).
 */
export const USAGE_BATCH_FIELDS = 32;

/** A raw row with the caller's id for it and its hour. */
interface Located {
  resourceId: string;
  hour: number;
  row: RawRow;
}

export interface UsageOptions {
  /** Clock in milliseconds; tests pass a fixed one. Defaults to `Date.now`. */
  now?: () => number;
  /**
   * Send the requests made in the same turn as one combined query (see
   * `batched()` on the returned object). Off by default: one request per
   * dataset read.
   */
  batch?: boolean;
}

/** A request waiting for the combined query it goes out in. */
interface Pending {
  field: FieldSpec;
  filter: Record<string, unknown>;
  resolve(rows: RawRow[]): void;
  reject(error: unknown): void;
}

/**
 * Usage analytics: one function per product, each returning hourly
 * {@link UsageRow}s; and `batched()`, the same reads sending the requests
 * started together as one GraphQL query (an aliased field per dataset)
 * instead of one request each: a caller that reads many datasets at once
 * (the spend watcher) makes one subrequest, and pays the CPU time of one
 * request, instead of many. Answers are the same; a field that fails fails
 * only its read, and a whole query refused for a reason that names no field
 * is sent again as separate requests.
 */
export function createUsage(http: HttpApi, options: UsageOptions = {}) {
  return {
    ...usageReads(http, options),
    batched: () => usageReads(http, { ...options, batch: true }),
  };
}

export type UsageReads = ReturnType<typeof usageReads>;

function usageReads(http: HttpApi, options: UsageOptions) {
  const gql: GraphQLClient = createGraphQL(http);
  const clock = options.now ?? Date.now;
  let lastStamp = 0;

  /** The current time, made unique per request so Cloudflare's cache never answers. */
  function stamp(): number {
    lastStamp = Math.max(clock(), lastStamp + 1);
    return lastStamp;
  }

  async function single(field: FieldSpec, filter: Record<string, unknown>): Promise<RawRow[]> {
    const data = await gql.query<Answer>(queryText(field), {
      accountTag: http.accountId,
      filter,
    });
    return data.viewer?.accounts?.[0]?.rows ?? [];
  }

  let queue: Pending[] = [];

  /**
   * Sends the waiting requests as combined queries of at most
   * {@link USAGE_BATCH_FIELDS} fields. Every request settles, whatever the
   * answer looks like.
   */
  async function flush(): Promise<void> {
    const waiting = queue;
    queue = [];
    for (let at = 0; at < waiting.length; at += USAGE_BATCH_FIELDS) {
      const group = waiting.slice(at, at + USAGE_BATCH_FIELDS);
      void sendGroup(group).catch((error: unknown) => {
        for (const p of group) p.reject(error);
      });
    }
  }

  /** The field (`r<i>`) an error's path names, or null when it names none of `count`. */
  function fieldOf(error: unknown, count: number): number | null {
    if (typeof error !== "object" || error === null) return null;
    const path = (error as { path?: unknown }).path;
    if (!Array.isArray(path)) return null;
    const name = path.find((part) => typeof part === "string" && /^r\d+$/.test(part));
    if (typeof name !== "string") return null;
    const i = Number(name.slice(1));
    return i < count ? i : null;
  }

  /**
   * One combined query. Cloudflare answers a combined query in which a
   * field fails with errors and no data at all (seen on 2026-10-13: a
   * `quota` error whose path named one field, `data` null), and a query it
   * cannot validate with an error naming no field. So the fields the errors
   * name are sent again on their own (each fails or answers as it would
   * alone) and the others again as one combined query; when an error names
   * no field (or the answer is not one Cloudflare gives), each request is
   * sent on its own. Errors naming their fields in an answer with data fail
   * only those requests. A refused HTTP request fails them all, as each
   * would have been refused alike. Anything unexpected fails them all too,
   * so no request is left waiting.
   */
  async function sendGroup(group: Pending[]): Promise<void> {
    const alone = (p: Pending) => single(p.field, p.filter).then(p.resolve, p.reject);
    if (group.length === 1) {
      const [only] = group;
      if (only !== undefined) await alone(only);
      return;
    }
    try {
      const variables: Record<string, unknown> = { accountTag: http.accountId };
      group.forEach((p, i) => {
        variables[`f${i}`] = p.filter;
      });
      const answer = (await http.send("POST", GRAPHQL_PATH, {
        json: { query: combinedQueryText(group.map((p) => p.field)), variables },
      })) as unknown as {
        data?: { viewer?: { accounts?: Array<Record<string, RawRow[] | null>> } } | null;
        errors?: unknown;
      } | null;
      const errors: unknown[] = Array.isArray(answer?.errors) ? answer.errors : [];
      const account = answer?.data?.viewer?.accounts?.[0];
      const fields = errors.map((e) => fieldOf(e, group.length));
      if (
        fields.some((f) => f === null) ||
        (errors.length === 0 && (account === undefined || account === null))
      ) {
        await Promise.all(group.map(alone));
        return;
      }
      const named = new Set(fields as number[]);
      if (account !== undefined && account !== null) {
        group.forEach((p, i) => {
          const own = errors.filter((_, k) => fields[k] === i) as GraphQLErrorItem[];
          if (own.length > 0) p.reject(new CloudflareGraphQLError(own));
          else p.resolve(account[`r${i}`] ?? []);
        });
        return;
      }
      const rest = group.filter((_, i) => !named.has(i));
      await Promise.all([
        ...group.filter((_, i) => named.has(i)).map(alone),
        rest.length > 0 ? sendGroup(rest) : Promise.resolve(),
      ]);
    } catch (error) {
      // Settling a settled request does nothing: only those still waiting fail.
      for (const p of group) p.reject(error);
    }
  }

  /** The time part of a filter for `[start, end)`, unique to this request. */
  function window(start: number, end: number): Record<string, unknown> {
    return {
      datetime_geq: new Date(start * 1000).toISOString(),
      datetime_lt: new Date(end * 1000).toISOString(),
      datetime_leq: new Date(stamp()).toISOString(),
    };
  }

  /** Sends one request, alone or (batched) with the others started in the same turn. */
  function send(field: FieldSpec, filter: Record<string, unknown>): Promise<RawRow[]> {
    if (!options.batch) return single(field, filter);
    return new Promise<RawRow[]>((resolve, reject) => {
      // The reads a caller starts together make their first requests in the
      // same turn: they go out together once it ends.
      if (queue.length === 0) setTimeout(() => void flush(), 0);
      queue.push({ field, filter, resolve, reject });
    });
  }

  async function request(
    spec: DatasetSpec,
    ids: readonly string[] | null,
    start: number,
    end: number,
  ): Promise<RawRow[]> {
    const filter: Record<string, unknown> = { ...spec.filter, ...window(start, end) };
    if (ids !== null) {
      filter[`${spec.idField}_in`] = spec.sendWithoutDashes ? ids.map(uuidKey) : [...ids];
    }
    return send(byResource(spec), filter);
  }

  /** Reads `[start, end)` for `ids`, splitting the window, then the ids, while an answer is full. */
  async function readWindow(
    spec: DatasetSpec,
    ids: readonly string[] | null,
    start: number,
    end: number,
  ): Promise<RawRow[]> {
    const rows = await request(spec, ids, start, end);
    if (rows.length < USAGE_MAX_ROWS) return rows;
    const hours = Math.ceil((end - start) / HOUR);
    if (hours > 1) {
      const mid = start + Math.floor(hours / 2) * HOUR;
      return [
        ...(await readWindow(spec, ids, start, mid)),
        ...(await readWindow(spec, ids, mid, end)),
      ];
    }
    if (ids !== null && ids.length > 1) {
      const half = Math.ceil(ids.length / 2);
      return [
        ...(await readWindow(spec, ids.slice(0, half), start, end)),
        ...(await readWindow(spec, ids.slice(half), start, end)),
      ];
    }
    // Sorted reads keep their first rows, which are the ones asked for.
    if (spec.orderBy !== undefined) return rows;
    throw new UsageRowLimitError(spec.dataset);
  }

  /**
   * Every raw row for `ids` (or, with `null`, for every resource) in the
   * range, each with the caller's id and its hour. Rows of resources not
   * asked about, and rows without an hour, are dropped.
   */
  async function readRaw(
    spec: DatasetSpec,
    ids: readonly string[] | null,
    range: UsageRange,
  ): Promise<Located[]> {
    if (ids !== null && ids.length === 0) return [];
    const now = Math.floor(clock() / 1000);
    const start = Math.max(Math.floor(range.from / HOUR) * HOUR, oldestHour(spec.dataset, now));
    const end = Math.min(range.to ?? now, now);
    if (!(start < end)) return [];

    const key = spec.idsAreUuids ? uuidKey : (id: string) => id;
    const callerIds = new Map<string, string>();
    for (const id of ids ?? []) callerIds.set(key(id), id);
    const batches: Array<readonly string[] | null> = [];
    if (ids === null) batches.push(null);
    else {
      const unique = [...callerIds.values()];
      for (let i = 0; i < unique.length; i += USAGE_ID_BATCH) {
        batches.push(unique.slice(i, i + USAGE_ID_BATCH));
      }
    }

    const located: Located[] = [];
    for (const batch of batches) {
      for (let ws = start; ws < end; ws += USAGE_MAX_WINDOW_HOURS * HOUR) {
        const we = Math.min(ws + USAGE_MAX_WINDOW_HOURS * HOUR, end);
        for (const row of await readWindow(spec, batch, ws, we)) {
          const raw = row.dimensions?.[spec.idField];
          const hourText = row.dimensions?.datetimeHour;
          if (typeof hourText !== "string") continue;
          const hourMs = Date.parse(hourText);
          if (Number.isNaN(hourMs)) continue;
          const answered = typeof raw === "string" ? raw : String(raw ?? "");
          const resourceId = ids === null ? answered : callerIds.get(key(answered));
          if (resourceId === undefined) continue;
          located.push({ resourceId, hour: Math.floor(hourMs / 1000), row });
        }
      }
    }
    return located;
  }

  /** Combines rows for the same metric, resource and hour (several dimension values, or windows). */
  function toUsageRows(spec: DatasetSpec, located: Located[]): UsageRow[] {
    const out = new Map<string, UsageRow>();
    for (const { resourceId, hour, row } of located) {
      for (const [metric, value] of spec.metrics(row)) {
        const k = `${metric}\u0000${resourceId}\u0000${hour}`;
        const seen = out.get(k);
        if (seen === undefined) {
          out.set(k, { dataset: spec.dataset, metric, resourceId, hour, value });
        } else {
          seen.value = spec.combine === "max" ? Math.max(seen.value, value) : seen.value + value;
        }
      }
    }
    const rows = [...out.values()];
    return spec.sizes ? rows : rows.filter((row) => row.value !== 0);
  }

  async function read(spec: DatasetSpec, query: UsageQuery): Promise<UsageRow[]> {
    return toUsageRows(spec, await readRaw(spec, query.ids, query));
  }

  async function readAll(specs: DatasetSpec[], query: UsageQuery): Promise<UsageRow[]> {
    const parts = await Promise.all(specs.map((spec) => read(spec, query)));
    return parts.flat();
  }

  return {
    /**
     * Workers invocations by Worker name (`ids` are script names), from
     * `workersInvocationsAdaptive`: `requests`, `subrequests`, `errors`,
     * `cpuTimeUs` (CPU time, microseconds). A brand-new Worker counts as
     * `__unknown__` until Cloudflare resolves its name, and is missing here
     * until then.
     */
    workers(query: UsageQuery): Promise<UsageRow[]> {
      return read(SPECS.workers, query);
    },

    /**
     * Durable Objects by namespace id (`ids`, 32 hex characters as the API
     * lists them). From `durableObjectsInvocationsAdaptiveGroups`:
     * `requests` (invocations of every kind). From
     * `durableObjectsPeriodicGroups`: `activeTimeUs` (microseconds),
     * `durationGbs` (GB-seconds, what Cloudflare bills), `rowsRead`,
     * `rowsWritten` (SQLite-backed objects), `inboundWebsocketMessages`,
     * `outboundWebsocketMessages`, and for key-value-backed objects
     * `storageReadUnits`, `storageWriteUnits` (4 KB units) and
     * `storageDeletes`. From `durableObjectsSqlStorageGroups`: `storedBytes`
     * (SQLite-backed objects; the key-value-backed storage dataset reports
     * whole groups of namespaces, so it cannot be split per namespace).
     */
    durableObjects(query: UsageQuery): Promise<UsageRow[]> {
      return readAll([SPECS.doInvocations, SPECS.doPeriodic, SPECS.doSqlStorage], query);
    },

    /**
     * The busiest single Durable Object's alarm count per namespace and hour
     * (`ids` are namespace ids), from `durableObjectsInvocationsAdaptiveGroups`
     * with `type` `alarm`: metric `busiestObjectAlarms`. One object running
     * thousands of alarms an hour is the shape of an alarm loop.
     */
    durableObjectAlarmPeaks(query: UsageQuery): Promise<UsageRow[]> {
      return read(SPECS.doAlarmPeaks, query);
    },

    /**
     * D1 by database id (`ids`, the UUID): `rowsRead`, `rowsWritten` from
     * `d1AnalyticsAdaptiveGroups`; `storedBytes` (database size) from
     * `d1StorageAdaptiveGroups`.
     */
    d1(query: UsageQuery): Promise<UsageRow[]> {
      return readAll([SPECS.d1, SPECS.d1Storage], query);
    },

    /**
     * Workers KV by namespace id (`ids`, with or without dashes):
     * `reads`, `writes`, `deletes`, `lists` from `kvOperationsAdaptiveGroups`
     * (another operation type keeps its own name); `storedBytes` from
     * `kvStorageAdaptiveGroups`. The operations dataset matches ids only
     * without dashes and the storage one answers with dashes; both come
     * back under the id as given.
     */
    kv(query: UsageQuery): Promise<UsageRow[]> {
      return readAll([SPECS.kvOperations, SPECS.kvStorage], query);
    },

    /**
     * R2 by bucket name (`ids`). From `r2OperationsAdaptiveGroups`, one
     * metric per operation, named as R2 names it (`PutObject`,
     * `GetObject`, `ListObjects`, `HeadBucket`…), so a caller sorts them
     * into class A, class B and free operations. From
     * `r2StorageAdaptiveGroups`: `storedBytes` (payload and metadata, over
     * every storage class).
     */
    r2(query: UsageQuery): Promise<UsageRow[]> {
      return readAll([SPECS.r2Operations, SPECS.r2Storage], query);
    },

    /**
     * Queues by queue id (`ids`): `operations` (billable operations: each
     * write, read and delete of up to 64 KB) from
     * `queueMessageOperationsAdaptiveGroups`.
     */
    queues(query: UsageQuery): Promise<UsageRow[]> {
      return read(SPECS.queues, query);
    },

    /**
     * Workflows by Workflow name (`ids`), from `workflowsAdaptiveGroups`:
     * `instanceStarts`, `steps` (`step.do` calls), `cpuTimeMs`
     * (milliseconds).
     */
    workflows(query: UsageQuery): Promise<UsageRow[]> {
      return read(SPECS.workflows, query);
    },

    /**
     * Workers AI for the whole account, by model (`resourceId` is the model
     * id, such as `@cf/meta/llama-3.2-1b-instruct`), from
     * `aiInferenceAdaptiveGroups`: `neurons`, `requests`. Cloudflare does
     * not say which Worker made a call (its source reads `unknown`), so the
     * account's AI usage cannot be split by app here.
     */
    async workersAi(range: UsageRange): Promise<UsageRow[]> {
      return toUsageRows(SPECS.workersAi, await readRaw(SPECS.workersAi, null, range));
    },

    /**
     * Vectorize by index name (`ids`): `queries` and
     * `queriedVectorDimensions` from `vectorizeV2QueriesAdaptiveGroups`;
     * `storedVectorDimensions` from `vectorizeV2StorageAdaptiveGroups`.
     */
    vectorize(query: UsageQuery): Promise<UsageRow[]> {
      return readAll([SPECS.vectorizeQueries, SPECS.vectorizeStorage], query);
    },

    /**
     * Workers Analytics Engine by dataset name (`ids`), from
     * `workersAnalyticsEngineAdaptiveGroups`: `dataPoints` written.
     */
    analyticsEngine(query: UsageQuery): Promise<UsageRow[]> {
      return read(SPECS.analyticsEngine, query);
    },

    /**
     * Browser Rendering by Worker name (`ids` are script names): `sessions`
     * (browser sessions the Worker opened) from
     * `browserRenderingEventsAdaptiveGroups`, and `sessionDurationMs`
     * (browser time, milliseconds) from
     * `browserRenderingBrowserTimeUsageAdaptiveGroups`, which knows only
     * session ids and is joined to the Worker through the events. A
     * brand-new Worker's events can carry no name; those sessions are
     * missing.
     */
    async browserRendering(query: UsageQuery): Promise<UsageRow[]> {
      const events = await readRaw(SPECS.browserEvents, query.ids, query);
      const scriptBySession = new Map<string, string>();
      for (const { resourceId, row } of events) {
        const session = row.dimensions.sessionId;
        if (typeof session === "string" && session !== "") {
          scriptBySession.set(session, resourceId);
        }
      }
      const sessions = toUsageRows(SPECS.browserEvents, events);
      const time = await readRaw(SPECS.browserTime, [...scriptBySession.keys()], query);
      const byScript = time.flatMap((located) => {
        const script = scriptBySession.get(located.resourceId);
        return script === undefined ? [] : [{ ...located, resourceId: script }];
      });
      return [...sessions, ...toUsageRows(SPECS.browserTime, byScript)];
    },

    /**
     * Containers by application id (`ids`), from
     * `containersUsageAdaptiveGroups`: `allocatedMemoryByteSeconds`,
     * `allocatedDiskByteSeconds` (byte-seconds), `cpuTimeSec` (seconds),
     * `txBytes` (bytes sent).
     */
    containers(query: UsageQuery): Promise<UsageRow[]> {
      return read(SPECS.containers, query);
    },

    /**
     * The whole account's use over a range (the current UTC day, say) of
     * what the Workers Free plan limits per day, every resource counted,
     * whoever made it: Worker `requests`; Durable Objects `requests`,
     * `durationGbs`, `rowsRead`, `rowsWritten`; D1 `rowsRead`,
     * `rowsWritten`; KV `reads`, `writes`, `deletes`, `lists`; Queues
     * `operations`; Workflow `steps`; Workers AI `neurons`; Analytics
     * Engine `dataPoints`; Browser Rendering `sessionDurationMs`. Metrics
     * are named and counted as the per-product reads name them, so a total
     * matches the sum of those reads over every resource.
     *
     * One request per dataset (one field each, batched), each grouped by
     * nothing (KV by operation type): an answer is a row or a few, however
     * much the account holds. A metric with no use is left out. Each
     * dataset settles on its own: one that fails is listed in `failed` and
     * the others still answer. Rejects only when every dataset fails (with
     * the first one's error), as when the token may not read analytics. The
     * range should lie within the last 31 days, which every dataset read
     * here answers for. `datasets` limits the read to those datasets (each
     * field counts against Cloudflare's GraphQL quota); all of them by
     * default. A dataset the account has never used answers with no rows,
     * not an error (checked on a Workers Free and a Workers Paid account,
     * 2026-10-13).
     */
    async accountTotals(
      range: UsageRange & { datasets?: readonly UsageDataset[] },
    ): Promise<UsageTotals> {
      const now = Math.floor(clock() / 1000);
      const end = Math.min(range.to ?? now, now);
      const wanted = range.datasets === undefined ? null : new Set(range.datasets);
      const specs = TOTALS.filter((t) => wanted === null || wanted.has(t.dataset));
      if (!(range.from < end) || specs.length === 0) return { totals: [], failed: [] };
      const settled = await Promise.allSettled(
        specs.map(async (total) => {
          const sums = new Map<string, number>();
          for (const row of await send(total, window(range.from, end))) {
            for (const [metric, value] of total.metrics(row)) {
              sums.set(metric, (sums.get(metric) ?? 0) + value);
            }
          }
          return [...sums].flatMap(([metric, value]) =>
            value === 0 ? [] : [{ dataset: total.dataset, metric, value }],
          );
        }),
      );
      const out: UsageTotals = { totals: [], failed: [] };
      settled.forEach((result, i) => {
        if (result.status === "fulfilled") out.totals.push(...result.value);
        else out.failed.push({ dataset: specs[i]?.dataset as UsageDataset, error: result.reason });
      });
      if (out.failed.length === specs.length) throw out.failed[0]?.error;
      return out;
    },
  };
}

/** One metric's total for the whole account over a range (see `accountTotals`). */
export interface UsageTotal {
  dataset: UsageDataset;
  metric: string;
  value: number;
}

/** What `accountTotals` read: the totals, and the datasets that could not be read. */
export interface UsageTotals {
  totals: UsageTotal[];
  failed: Array<{ dataset: UsageDataset; error: unknown }>;
}

const KV_ACTIONS: Record<string, string> = {
  read: "reads",
  write: "writes",
  delete: "deletes",
  list: "lists",
};

const SPECS = {
  workers: {
    dataset: "workersInvocationsAdaptive",
    idField: "scriptName",
    select: "sum { requests subrequests errors cpuTimeUs }",
    metrics: (r) => [
      ["requests", num(r.sum?.requests)],
      ["subrequests", num(r.sum?.subrequests)],
      ["errors", num(r.sum?.errors)],
      ["cpuTimeUs", num(r.sum?.cpuTimeUs)],
    ],
  },
  doInvocations: {
    dataset: "durableObjectsInvocationsAdaptiveGroups",
    idField: "namespaceId",
    idsAreUuids: true,
    select: "sum { requests }",
    metrics: (r) => [["requests", num(r.sum?.requests)]],
  },
  doPeriodic: {
    dataset: "durableObjectsPeriodicGroups",
    idField: "namespaceId",
    idsAreUuids: true,
    select:
      "sum { activeTime duration rowsRead rowsWritten inboundWebsocketMsgCount outboundWebsocketMsgCount storageReadUnits storageWriteUnits storageDeletes }",
    metrics: (r) => [
      ["activeTimeUs", num(r.sum?.activeTime)],
      ["durationGbs", num(r.sum?.duration)],
      ["rowsRead", num(r.sum?.rowsRead)],
      ["rowsWritten", num(r.sum?.rowsWritten)],
      ["inboundWebsocketMessages", num(r.sum?.inboundWebsocketMsgCount)],
      ["outboundWebsocketMessages", num(r.sum?.outboundWebsocketMsgCount)],
      ["storageReadUnits", num(r.sum?.storageReadUnits)],
      ["storageWriteUnits", num(r.sum?.storageWriteUnits)],
      ["storageDeletes", num(r.sum?.storageDeletes)],
    ],
  },
  doSqlStorage: {
    dataset: "durableObjectsSqlStorageGroups",
    idField: "namespaceId",
    idsAreUuids: true,
    select: "max { storedBytes }",
    combine: "max",
    sizes: true,
    metrics: (r) => [["storedBytes", num(r.max?.storedBytes)]],
  },
  doAlarmPeaks: {
    dataset: "durableObjectsInvocationsAdaptiveGroups",
    idField: "namespaceId",
    idsAreUuids: true,
    dimensions: ["objectId"],
    filter: { type: "alarm" },
    select: "sum { requests }",
    orderBy: "[sum_requests_DESC]",
    combine: "max",
    metrics: (r) => [["busiestObjectAlarms", num(r.sum?.requests)]],
  },
  d1: {
    dataset: "d1AnalyticsAdaptiveGroups",
    idField: "databaseId",
    idsAreUuids: true,
    select: "sum { rowsRead rowsWritten }",
    metrics: (r) => [
      ["rowsRead", num(r.sum?.rowsRead)],
      ["rowsWritten", num(r.sum?.rowsWritten)],
    ],
  },
  d1Storage: {
    dataset: "d1StorageAdaptiveGroups",
    idField: "databaseId",
    idsAreUuids: true,
    select: "max { databaseSizeBytes }",
    combine: "max",
    sizes: true,
    metrics: (r) => [["storedBytes", num(r.max?.databaseSizeBytes)]],
  },
  kvOperations: {
    dataset: "kvOperationsAdaptiveGroups",
    idField: "namespaceId",
    idsAreUuids: true,
    sendWithoutDashes: true,
    dimensions: ["actionType"],
    select: "sum { requests }",
    metrics: (r) => {
      const action = String(r.dimensions.actionType ?? "");
      return [[KV_ACTIONS[action] ?? action, num(r.sum?.requests)]];
    },
  },
  kvStorage: {
    dataset: "kvStorageAdaptiveGroups",
    idField: "namespaceId",
    idsAreUuids: true,
    sendWithoutDashes: true,
    select: "max { byteCount }",
    combine: "max",
    sizes: true,
    metrics: (r) => [["storedBytes", num(r.max?.byteCount)]],
  },
  r2Operations: {
    dataset: "r2OperationsAdaptiveGroups",
    idField: "bucketName",
    dimensions: ["actionType"],
    select: "sum { requests }",
    metrics: (r) => [[String(r.dimensions.actionType ?? ""), num(r.sum?.requests)]],
  },
  r2Storage: {
    dataset: "r2StorageAdaptiveGroups",
    idField: "bucketName",
    // One row per storage class; their sizes add up.
    dimensions: ["storageClass"],
    select: "max { payloadSize metadataSize }",
    sizes: true,
    metrics: (r) => [["storedBytes", num(r.max?.payloadSize) + num(r.max?.metadataSize)]],
  },
  queues: {
    dataset: "queueMessageOperationsAdaptiveGroups",
    idField: "queueId",
    idsAreUuids: true,
    select: "sum { billableOperations }",
    metrics: (r) => [["operations", num(r.sum?.billableOperations)]],
  },
  workflows: {
    dataset: "workflowsAdaptiveGroups",
    idField: "workflowName",
    dimensions: ["eventType"],
    select: "count sum { stepCount cpuTime }",
    metrics: (r) => [
      ["instanceStarts", r.dimensions.eventType === "WORKFLOW_START" ? num(r.count) : 0],
      ["steps", num(r.sum?.stepCount)],
      ["cpuTimeMs", num(r.sum?.cpuTime)],
    ],
  },
  workersAi: {
    dataset: "aiInferenceAdaptiveGroups",
    idField: "modelId",
    select: "count sum { totalNeurons }",
    metrics: (r) => [
      ["neurons", num(r.sum?.totalNeurons)],
      ["requests", num(r.count)],
    ],
  },
  vectorizeQueries: {
    dataset: "vectorizeV2QueriesAdaptiveGroups",
    idField: "indexName",
    select: "count sum { queriedVectorDimensions }",
    metrics: (r) => [
      ["queries", num(r.count)],
      ["queriedVectorDimensions", num(r.sum?.queriedVectorDimensions)],
    ],
  },
  vectorizeStorage: {
    dataset: "vectorizeV2StorageAdaptiveGroups",
    idField: "indexName",
    select: "max { storedVectorDimensions }",
    combine: "max",
    sizes: true,
    metrics: (r) => [["storedVectorDimensions", num(r.max?.storedVectorDimensions)]],
  },
  analyticsEngine: {
    dataset: "workersAnalyticsEngineAdaptiveGroups",
    idField: "dataset",
    select: "count",
    metrics: (r) => [["dataPoints", num(r.count)]],
  },
  browserEvents: {
    dataset: "browserRenderingEventsAdaptiveGroups",
    idField: "scriptName",
    dimensions: ["sessionId"],
    select: "count",
    // One row per session and hour: each counts the session once.
    metrics: () => [["sessions", 1]],
  },
  browserTime: {
    dataset: "browserRenderingBrowserTimeUsageAdaptiveGroups",
    idField: "sessionId",
    select: "sum { totalSessionDurationMs }",
    metrics: (r) => [["sessionDurationMs", num(r.sum?.totalSessionDurationMs)]],
  },
  containers: {
    dataset: "containersUsageAdaptiveGroups",
    idField: "applicationId",
    idsAreUuids: true,
    select: "sum { allocatedMemory allocatedDisk cpuTimeSec txBytes }",
    metrics: (r) => [
      ["allocatedMemoryByteSeconds", num(r.sum?.allocatedMemory)],
      ["allocatedDiskByteSeconds", num(r.sum?.allocatedDisk)],
      ["cpuTimeSec", num(r.sum?.cpuTimeSec)],
      ["txBytes", num(r.sum?.txBytes)],
    ],
  },
} satisfies Record<string, DatasetSpec>;

/** A request for the whole account's total of a dataset, and the metrics of its rows. */
interface TotalSpec extends FieldSpec {
  metrics(row: RawRow): Array<[metric: string, value: number]>;
}

/**
 * The account-wide totals `accountTotals` reads: the per-product reads'
 * datasets and metrics that a Workers Free daily limit counts, without the
 * resource and hour dimensions (all accepted on a Workers Free account,
 * 2026-10-13).
 */
const TOTALS: readonly TotalSpec[] = [
  {
    dataset: "workersInvocationsAdaptive",
    groupBy: [],
    select: "sum { requests }",
    metrics: (r) => [["requests", num(r.sum?.requests)]],
  },
  {
    dataset: "durableObjectsInvocationsAdaptiveGroups",
    groupBy: [],
    select: "sum { requests }",
    metrics: (r) => [["requests", num(r.sum?.requests)]],
  },
  {
    dataset: "durableObjectsPeriodicGroups",
    groupBy: [],
    select: "sum { duration rowsRead rowsWritten }",
    metrics: (r) => [
      ["durationGbs", num(r.sum?.duration)],
      ["rowsRead", num(r.sum?.rowsRead)],
      ["rowsWritten", num(r.sum?.rowsWritten)],
    ],
  },
  {
    dataset: "d1AnalyticsAdaptiveGroups",
    groupBy: [],
    select: "sum { rowsRead rowsWritten }",
    metrics: (r) => [
      ["rowsRead", num(r.sum?.rowsRead)],
      ["rowsWritten", num(r.sum?.rowsWritten)],
    ],
  },
  {
    dataset: "kvOperationsAdaptiveGroups",
    groupBy: ["actionType"],
    select: "sum { requests }",
    metrics: SPECS.kvOperations.metrics,
  },
  {
    dataset: "queueMessageOperationsAdaptiveGroups",
    groupBy: [],
    select: "sum { billableOperations }",
    metrics: (r) => [["operations", num(r.sum?.billableOperations)]],
  },
  {
    dataset: "workflowsAdaptiveGroups",
    groupBy: [],
    select: "sum { stepCount }",
    metrics: (r) => [["steps", num(r.sum?.stepCount)]],
  },
  {
    dataset: "aiInferenceAdaptiveGroups",
    groupBy: [],
    select: "sum { totalNeurons }",
    metrics: (r) => [["neurons", num(r.sum?.totalNeurons)]],
  },
  {
    dataset: "workersAnalyticsEngineAdaptiveGroups",
    groupBy: [],
    select: "count",
    metrics: (r) => [["dataPoints", num(r.count)]],
  },
  {
    dataset: "browserRenderingBrowserTimeUsageAdaptiveGroups",
    groupBy: [],
    select: "sum { totalSessionDurationMs }",
    metrics: (r) => [["sessionDurationMs", num(r.sum?.totalSessionDurationMs)]],
  },
];

/** Datasets `accountTotals` reads: one field each in a batched query. */
export const USAGE_TOTAL_DATASETS = TOTALS.length;
