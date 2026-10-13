import { and, count, desc, eq, gte, inArray, isNull, lt, type SQL } from "drizzle-orm";
import { ulid } from "ulidx";
import type { Database } from "../../db/client";
import { type ActivityKind, usage_activity } from "../../db/schema";
import { ACTIVITY_FACTS, type Activity, type ActivityFacts } from "./activity";
import { DAY_SECONDS } from "./limits";

/**
 * The usage activity log (`usage_activity`): written as things happen, read
 * for an app's Recent activity, its chart's markers and the "alerts sent"
 * count, and to tell whether something already happened this period (the
 * monthly budget reached this month).
 */

export const ACTIVITY_RETENTION_DAYS = 400;

/** Records one entry (facts validated by its kind; throws a ZodError on bad facts). */
export async function recordActivity<K extends ActivityKind>(
  db: Database,
  entry: {
    /** Null for the account. */
    installId: string | null;
    kind: K;
    facts: ActivityFacts[K];
    /** The user id; null (the default) for Appflare on its own. */
    by?: string | null;
    at?: Date;
  },
): Promise<Activity> {
  const facts = ACTIVITY_FACTS[entry.kind].parse(entry.facts);
  const row = {
    id: ulid(),
    install_id: entry.installId,
    at: entry.at ?? new Date(),
    kind: entry.kind,
    by: entry.by ?? null,
    facts_json: JSON.stringify(facts),
  };
  await db.insert(usage_activity).values(row);
  return {
    id: row.id,
    installId: row.install_id,
    at: row.at.getTime(),
    kind: entry.kind,
    by: row.by,
    facts,
  } as Activity;
}

type Row = typeof usage_activity.$inferSelect;

/** Null for a row whose facts no longer read as its kind's (written by hand, say). */
function fromRow(row: Row): Activity | null {
  let raw: unknown;
  try {
    raw = JSON.parse(row.facts_json);
  } catch {
    return null;
  }
  const facts = ACTIVITY_FACTS[row.kind].safeParse(raw);
  if (!facts.success) return null;
  return {
    id: row.id,
    installId: row.install_id,
    at: row.at.getTime(),
    kind: row.kind,
    by: row.by,
    facts: facts.data,
  } as Activity;
}

export interface ActivityQuery {
  /** One install's entries; null for the account's own; every entry when omitted. */
  installId?: string | null;
  /** Entries at or after this instant. */
  since?: Date;
  kinds?: readonly ActivityKind[];
}

function where(q: ActivityQuery): SQL | undefined {
  return and(
    q.installId === undefined
      ? undefined
      : q.installId === null
        ? isNull(usage_activity.install_id)
        : eq(usage_activity.install_id, q.installId),
    q.since === undefined ? undefined : gte(usage_activity.at, q.since),
    q.kinds === undefined ? undefined : inArray(usage_activity.kind, [...q.kinds]),
  );
}

/** Entries matching the query, newest first, at most `limit` (default 50). */
export async function listActivity(
  db: Database,
  query: ActivityQuery & { limit?: number } = {},
): Promise<Activity[]> {
  if (query.kinds?.length === 0) return [];
  const rows = await db
    .select()
    .from(usage_activity)
    .where(where(query))
    .orderBy(desc(usage_activity.at), desc(usage_activity.id))
    .limit(query.limit ?? 50);
  return rows.map(fromRow).filter((a) => a !== null);
}

/** How many entries match (the "N alerts sent" badge: `alert_sent` since the period began). */
export async function countActivity(db: Database, query: ActivityQuery): Promise<number> {
  if (query.kinds?.length === 0) return 0;
  const [row] = await db.select({ n: count() }).from(usage_activity).where(where(query));
  return row?.n ?? 0;
}

/** Deletes entries older than `ACTIVITY_RETENTION_DAYS` before `now`; returns how many went. */
export async function pruneActivity(db: Database, now: Date = new Date()): Promise<number> {
  const cutoff = new Date(now.getTime() - ACTIVITY_RETENTION_DAYS * DAY_SECONDS * 1000);
  const result = await db.delete(usage_activity).where(lt(usage_activity.at, cutoff));
  return result.meta.changes;
}
