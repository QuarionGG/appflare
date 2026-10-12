/**
 * Test-only: GraphQL Analytics answers for the usage collector's tests, and
 * a fetch that answers the collector's requests from them.
 *
 * `RECORDED` holds real answers, read from a Workers Paid account on
 * 2026-10-12 between 12:00 and 16:50 UTC (`RECORDED_NOW`) for one small app
 * (a Worker, a D1 database, a KV namespace and a Durable Object namespace),
 * with the resource ids and names replaced. The Durable Object namespace held
 * data but ran nothing in those hours, so its invocation datasets answered no
 * rows.
 */

import type { FetchLike } from "@appflare/cf-api";

/** When the answers were read (unix seconds). */
export const RECORDED_NOW = 1791822610;

/** The app's resources as the answers name them. */
export const RECORDED_IDS = {
  worker: "notes",
  d1: "d1d1d1d1-0000-4000-8000-00000000000a",
  kv: "4b4b4b4b00004000800000000000000a",
  durableObject: "d0d0d0d000004000800000000000000a",
} as const;

export type AnswerRow = { dimensions: Record<string, string | number | null> } & Record<
  string,
  unknown
>;

/** Answer rows by dataset; `alarms` is the Durable Object invocations dataset filtered to alarms. */
export const RECORDED: Readonly<Record<string, readonly AnswerRow[]>> = {
  workersInvocationsAdaptive: [
    {
      dimensions: {
        datetimeHour: "2026-10-12T12:00:00Z",
        scriptName: "notes",
      },
      sum: {
        cpuTimeUs: 308506,
        errors: 0,
        requests: 2,
        subrequests: 6,
      },
    },
    {
      dimensions: {
        datetimeHour: "2026-10-12T13:00:00Z",
        scriptName: "notes",
      },
      sum: {
        cpuTimeUs: 275191,
        errors: 0,
        requests: 2,
        subrequests: 6,
      },
    },
    {
      dimensions: {
        datetimeHour: "2026-10-12T14:00:00Z",
        scriptName: "notes",
      },
      sum: {
        cpuTimeUs: 262806,
        errors: 0,
        requests: 2,
        subrequests: 6,
      },
    },
    {
      dimensions: {
        datetimeHour: "2026-10-12T15:00:00Z",
        scriptName: "notes",
      },
      sum: {
        cpuTimeUs: 262411,
        errors: 0,
        requests: 2,
        subrequests: 6,
      },
    },
    {
      dimensions: {
        datetimeHour: "2026-10-12T16:00:00Z",
        scriptName: "notes",
      },
      sum: {
        cpuTimeUs: 136516,
        errors: 0,
        requests: 1,
        subrequests: 3,
      },
    },
  ],
  d1AnalyticsAdaptiveGroups: [
    {
      dimensions: {
        databaseId: "d1d1d1d1-0000-4000-8000-00000000000a",
        datetimeHour: "2026-10-12T12:00:00Z",
      },
      sum: {
        rowsRead: 276,
        rowsWritten: 2,
      },
    },
    {
      dimensions: {
        databaseId: "d1d1d1d1-0000-4000-8000-00000000000a",
        datetimeHour: "2026-10-12T14:00:00Z",
      },
      sum: {
        rowsRead: 276,
        rowsWritten: 2,
      },
    },
    {
      dimensions: {
        databaseId: "d1d1d1d1-0000-4000-8000-00000000000a",
        datetimeHour: "2026-10-12T15:00:00Z",
      },
      sum: {
        rowsRead: 276,
        rowsWritten: 2,
      },
    },
    {
      dimensions: {
        databaseId: "d1d1d1d1-0000-4000-8000-00000000000a",
        datetimeHour: "2026-10-12T16:00:00Z",
      },
      sum: {
        rowsRead: 138,
        rowsWritten: 1,
      },
    },
    {
      dimensions: {
        databaseId: "d1d1d1d1-0000-4000-8000-00000000000a",
        datetimeHour: "2026-10-12T13:00:00Z",
      },
      sum: {
        rowsRead: 276,
        rowsWritten: 2,
      },
    },
  ],
  d1StorageAdaptiveGroups: [
    {
      dimensions: {
        databaseId: "d1d1d1d1-0000-4000-8000-00000000000a",
        datetimeHour: "2026-10-12T12:00:00Z",
      },
      max: {
        databaseSizeBytes: 679936,
      },
    },
    {
      dimensions: {
        databaseId: "d1d1d1d1-0000-4000-8000-00000000000a",
        datetimeHour: "2026-10-12T14:00:00Z",
      },
      max: {
        databaseSizeBytes: 679936,
      },
    },
    {
      dimensions: {
        databaseId: "d1d1d1d1-0000-4000-8000-00000000000a",
        datetimeHour: "2026-10-12T15:00:00Z",
      },
      max: {
        databaseSizeBytes: 679936,
      },
    },
    {
      dimensions: {
        databaseId: "d1d1d1d1-0000-4000-8000-00000000000a",
        datetimeHour: "2026-10-12T16:00:00Z",
      },
      max: {
        databaseSizeBytes: 679936,
      },
    },
    {
      dimensions: {
        databaseId: "d1d1d1d1-0000-4000-8000-00000000000a",
        datetimeHour: "2026-10-12T13:00:00Z",
      },
      max: {
        databaseSizeBytes: 679936,
      },
    },
  ],
  kvOperationsAdaptiveGroups: [
    {
      dimensions: {
        actionType: "write",
        datetimeHour: "2026-10-12T12:00:00Z",
        namespaceId: "4b4b4b4b00004000800000000000000a",
      },
      sum: {
        requests: 4,
      },
    },
    {
      dimensions: {
        actionType: "write",
        datetimeHour: "2026-10-12T13:00:00Z",
        namespaceId: "4b4b4b4b00004000800000000000000a",
      },
      sum: {
        requests: 2,
      },
    },
    {
      dimensions: {
        actionType: "write",
        datetimeHour: "2026-10-12T16:00:00Z",
        namespaceId: "4b4b4b4b00004000800000000000000a",
      },
      sum: {
        requests: 1,
      },
    },
    {
      dimensions: {
        actionType: "read",
        datetimeHour: "2026-10-12T13:00:00Z",
        namespaceId: "4b4b4b4b00004000800000000000000a",
      },
      sum: {
        requests: 8,
      },
    },
    {
      dimensions: {
        actionType: "write",
        datetimeHour: "2026-10-12T15:00:00Z",
        namespaceId: "4b4b4b4b00004000800000000000000a",
      },
      sum: {
        requests: 3,
      },
    },
    {
      dimensions: {
        actionType: "read",
        datetimeHour: "2026-10-12T14:00:00Z",
        namespaceId: "4b4b4b4b00004000800000000000000a",
      },
      sum: {
        requests: 8,
      },
    },
    {
      dimensions: {
        actionType: "write",
        datetimeHour: "2026-10-12T14:00:00Z",
        namespaceId: "4b4b4b4b00004000800000000000000a",
      },
      sum: {
        requests: 2,
      },
    },
    {
      dimensions: {
        actionType: "read",
        datetimeHour: "2026-10-12T12:00:00Z",
        namespaceId: "4b4b4b4b00004000800000000000000a",
      },
      sum: {
        requests: 8,
      },
    },
    {
      dimensions: {
        actionType: "read",
        datetimeHour: "2026-10-12T15:00:00Z",
        namespaceId: "4b4b4b4b00004000800000000000000a",
      },
      sum: {
        requests: 9,
      },
    },
    {
      dimensions: {
        actionType: "read",
        datetimeHour: "2026-10-12T16:00:00Z",
        namespaceId: "4b4b4b4b00004000800000000000000a",
      },
      sum: {
        requests: 4,
      },
    },
  ],
  kvStorageAdaptiveGroups: [
    {
      dimensions: {
        datetimeHour: "2026-10-12T13:00:00Z",
        namespaceId: "4b4b4b4b-0000-4000-8000-00000000000a",
      },
      max: {
        byteCount: 660022,
      },
    },
    {
      dimensions: {
        datetimeHour: "2026-10-12T12:00:00Z",
        namespaceId: "4b4b4b4b-0000-4000-8000-00000000000a",
      },
      max: {
        byteCount: 660022,
      },
    },
    {
      dimensions: {
        datetimeHour: "2026-10-12T14:00:00Z",
        namespaceId: "4b4b4b4b-0000-4000-8000-00000000000a",
      },
      max: {
        byteCount: 660022,
      },
    },
    {
      dimensions: {
        datetimeHour: "2026-10-12T15:00:00Z",
        namespaceId: "4b4b4b4b-0000-4000-8000-00000000000a",
      },
      max: {
        byteCount: 660022,
      },
    },
    {
      dimensions: {
        datetimeHour: "2026-10-12T16:00:00Z",
        namespaceId: "4b4b4b4b-0000-4000-8000-00000000000a",
      },
      max: {
        byteCount: 660022,
      },
    },
  ],
  durableObjectsSqlStorageGroups: [
    {
      dimensions: {
        datetimeHour: "2026-10-12T12:00:00Z",
        namespaceId: "d0d0d0d000004000800000000000000a",
      },
      max: {
        storedBytes: 49152,
      },
    },
    {
      dimensions: {
        datetimeHour: "2026-10-12T13:00:00Z",
        namespaceId: "d0d0d0d000004000800000000000000a",
      },
      max: {
        storedBytes: 49152,
      },
    },
    {
      dimensions: {
        datetimeHour: "2026-10-12T15:00:00Z",
        namespaceId: "d0d0d0d000004000800000000000000a",
      },
      max: {
        storedBytes: 49152,
      },
    },
    {
      dimensions: {
        datetimeHour: "2026-10-12T14:00:00Z",
        namespaceId: "d0d0d0d000004000800000000000000a",
      },
      max: {
        storedBytes: 49152,
      },
    },
    {
      dimensions: {
        datetimeHour: "2026-10-12T16:00:00Z",
        namespaceId: "d0d0d0d000004000800000000000000a",
      },
      max: {
        storedBytes: 49152,
      },
    },
  ],
  durableObjectsInvocationsAdaptiveGroups: [],
  durableObjectsPeriodicGroups: [],
  alarms: [],
};

/** One GraphQL request the fake answered. */
export interface GraphQLSent {
  /** The dataset, or `alarms` for the alarm read. */
  dataset: string;
  filter: Record<string, unknown>;
}

const idKey = (id: unknown) => String(id).replaceAll("-", "").toLowerCase();

const ID_FIELDS = [
  "scriptName",
  "namespaceId",
  "databaseId",
  "bucketName",
  "queueId",
  "indexName",
  "dataset",
  "applicationId",
  "workflowName",
  "sessionId",
];

/**
 * A fetch answering `POST /graphql` from `answers` (by dataset), as
 * Cloudflare would: only rows of the ids asked for (`<idField>_in`) and the
 * hours asked for (`datetime_geq`, `datetime_lt`). With `refuse`, every
 * GraphQL request (or those of `refuse.datasets`) is refused with that error. Anything else goes to `rest`
 * (the fake REST API), or a 404.
 */
export function fakeGraphQL(
  answers: Readonly<Record<string, readonly AnswerRow[]>>,
  rest?: FetchLike,
  refuse?: { message: string; code?: string; datasets?: readonly string[] },
): { fetch: FetchLike; sent: GraphQLSent[] } {
  const sent: GraphQLSent[] = [];
  const fetch: FetchLike = async (input, init) => {
    const request = new Request(input, init);
    if (!new URL(request.url).pathname.endsWith("/graphql")) {
      if (rest !== undefined) return rest(input, init);
      return Response.json(
        { success: false, errors: [{ code: 7003, message: "No route" }] },
        { status: 404 },
      );
    }
    const body = (await request.json()) as {
      query: string;
      variables: { filter: Record<string, unknown> };
    };
    const filter = body.variables.filter;
    const named = /rows: (\w+)\(/.exec(body.query)?.[1] ?? "";
    const dataset = filter.type === "alarm" ? "alarms" : named;
    sent.push({ dataset, filter });
    if (refuse !== undefined && (refuse.datasets?.includes(dataset) ?? true)) {
      return Response.json({
        data: null,
        errors: [
          {
            message: refuse.message,
            extensions: refuse.code === undefined ? {} : { code: refuse.code },
          },
        ],
      });
    }
    const from = Date.parse(String(filter.datetime_geq));
    const to = Date.parse(String(filter.datetime_lt));
    const rows = (answers[dataset] ?? []).filter((row) => {
      const hour = Date.parse(String(row.dimensions.datetimeHour));
      if (!(hour >= from && hour < to)) return false;
      for (const field of ID_FIELDS) {
        const wanted = filter[`${field}_in`];
        if (!Array.isArray(wanted)) continue;
        if (!wanted.map(idKey).includes(idKey(row.dimensions[field]))) return false;
      }
      return true;
    });
    return Response.json({ data: { viewer: { accounts: [{ rows }] } }, errors: null });
  };
  return { fetch, sent };
}

/** An answer row for an hour (unix seconds) and a resource. */
export function answerRow(
  idField: string,
  id: string,
  hour: number,
  aggregates: Record<string, unknown>,
  dimensions: Record<string, string> = {},
): AnswerRow {
  return {
    dimensions: {
      [idField]: id,
      datetimeHour: new Date(hour * 1000).toISOString().replace(".000Z", "Z"),
      ...dimensions,
    },
    ...aggregates,
  };
}
