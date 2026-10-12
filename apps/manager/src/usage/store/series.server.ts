import { and, asc, eq, gte, inArray, lt, notInArray, sql } from "drizzle-orm";
import type { BatchItem } from "drizzle-orm/batch";
import type { Database } from "../../db/client";
import { usage_daily, usage_hourly } from "../../db/schema";
import {
  chunk,
  DAY_SECONDS,
  dayStart,
  HOUR_SECONDS,
  MAX_BOUND_PARAMETERS,
  rowsPerStatement,
  STATEMENTS_PER_BATCH,
  toUnixSeconds,
} from "./limits";

/**
 * The usage series: Appflare's own hourly snapshots of what each install
 * used of each product (`usage_hourly`), rolled up into days
 * (`usage_daily`). Cloudflare deletes a Durable Object namespace's analytics
 * with the namespace, so history lives here, and outlives the install.
 *
 * Products are opaque keys here. A level product (storage) records the level
 * in each hour, and its day is the day's last level; every other product's
 * day is the sum of its hours. The caller says which products are levels.
 */

/** Hourly rows are kept this many days; days of `usage_daily` this many. */
export const HOURLY_RETENTION_DAYS = 45;
export const DAILY_RETENTION_DAYS = 400;

export type UsageGrain = "hour" | "day";

export interface HourlyUsage {
  installId: string;
  product: string;
  /** The unix second the UTC hour starts. */
  hour: number;
  /** Used in that hour; for a level product, the level. */
  value: number;
}

export interface UsagePoint {
  /** The unix second the UTC hour or day starts. */
  t: number;
  value: number;
}

export interface UsageRow extends UsagePoint {
  installId: string;
  product: string;
}

export class UsageStoreError extends Error {
  override name = "UsageStoreError";
}

/** Sends `items` in batches of at most `STATEMENTS_PER_BATCH` (each batch is one transaction). */
async function runInBatches(db: Database, items: readonly BatchItem<"sqlite">[]): Promise<void> {
  for (const part of chunk(items, STATEMENTS_PER_BATCH)) {
    const [first, ...rest] = part;
    if (first) await db.batch([first, ...rest]);
  }
}

function checkRow(row: HourlyUsage): void {
  if (!row.installId || !row.product) {
    throw new UsageStoreError("A usage row needs an install id and a product");
  }
  if (!Number.isInteger(row.hour) || row.hour % HOUR_SECONDS !== 0) {
    throw new UsageStoreError(`Usage hour ${row.hour} is not the start of a UTC hour`);
  }
  if (!Number.isFinite(row.value) || row.value < 0) {
    throw new UsageStoreError(`Usage value ${row.value} is not a non-negative number`);
  }
}

/**
 * Writes hourly rows (an hour written again replaces its value) and rolls
 * up every day they touch, for the installs they name, into `usage_daily`.
 * Rows of a day that starts before the hourly retention are skipped: that
 * day's other hours may be pruned, so rolling it up again would replace a
 * whole day with a part.
 *
 * Cost: each rolled-up day reads that day's hourly rows of the named
 * installs, so a caller that writes every few minutes should send only the
 * hours that changed.
 */
export async function recordHourlyUsage(
  db: Database,
  rows: readonly HourlyUsage[],
  options: { levels?: readonly string[]; now?: Date } = {},
): Promise<{ written: number; days: number[] }> {
  const levels = [...new Set(options.levels ?? [])];
  const oldest =
    toUnixSeconds((options.now ?? new Date()).getTime()) - HOURLY_RETENTION_DAYS * DAY_SECONDS;
  for (const row of rows) checkRow(row);
  // By day, not hour: the day the retention cuts through is already partly pruned.
  const kept = rows.filter((r) => dayStart(r.hour) >= oldest);
  if (kept.length === 0) return { written: 0, days: [] };

  const items: BatchItem<"sqlite">[] = chunk(kept, rowsPerStatement(4)).map((part) =>
    db
      .insert(usage_hourly)
      .values(
        part.map((r) => ({
          install_id: r.installId,
          product: r.product,
          hour: r.hour,
          value: r.value,
        })),
      )
      .onConflictDoUpdate({
        target: [usage_hourly.install_id, usage_hourly.product, usage_hourly.hour],
        set: { value: sql`excluded.value` },
      }),
  );

  const byDay = new Map<number, Set<string>>();
  for (const r of kept) {
    const day = dayStart(r.hour);
    const ids = byDay.get(day) ?? new Set<string>();
    ids.add(r.installId);
    byDay.set(day, ids);
  }
  const days = [...byDay.keys()].sort((a, b) => a - b);
  for (const day of days) {
    items.push(...rollUpStatements(db, day, [...(byDay.get(day) ?? [])], levels));
  }
  await runInBatches(db, items);
  return { written: kept.length, days };
}

/**
 * Recomputes `usage_daily` for the given days from `usage_hourly`, for the
 * given installs (every install when omitted). Days with no hourly rows are
 * left as they are.
 */
export async function rollUpDays(
  db: Database,
  days: readonly number[],
  options: { levels?: readonly string[]; installIds?: readonly string[] } = {},
): Promise<void> {
  const levels = [...new Set(options.levels ?? [])];
  const items: BatchItem<"sqlite">[] = [];
  for (const day of new Set(days)) {
    if (day % DAY_SECONDS !== 0) {
      throw new UsageStoreError(`Usage day ${day} is not the start of a UTC day`);
    }
    items.push(...rollUpStatements(db, day, options.installIds ?? null, levels));
  }
  await runInBatches(db, items);
}

/**
 * The statements that roll one day up: sums for counted products, the
 * last hour's value for levels. Install ids are cut so every statement
 * stays under D1's parameter limit (3 for the day, plus the levels).
 * Exported for the test that checks their query plans.
 */
export function rollUpStatements(
  db: Database,
  day: number,
  installIds: readonly string[] | null,
  levels: readonly string[],
): BatchItem<"sqlite">[] {
  const fixed = 3 + levels.length;
  if (fixed >= MAX_BOUND_PARAMETERS) {
    throw new UsageStoreError(`Too many level products (${levels.length})`);
  }
  const groups = installIds === null ? [null] : chunk(installIds, MAX_BOUND_PARAMETERS - fixed);
  const h = usage_hourly;
  const upsert = {
    target: [usage_daily.install_id, usage_daily.product, usage_daily.day],
    set: { value: sql`excluded.value` },
  };
  const out: BatchItem<"sqlite">[] = [];
  for (const ids of groups) {
    const scope = [
      gte(h.hour, day),
      lt(h.hour, day + DAY_SECONDS),
      ids === null ? undefined : inArray(h.install_id, ids),
    ];
    const sums = db
      .select({
        install_id: h.install_id,
        product: h.product,
        day: sql<number>`${day}`.as("day"),
        value: sql<number>`sum(${h.value})`.as("value"),
      })
      .from(h)
      .where(and(...scope, levels.length > 0 ? notInArray(h.product, [...levels]) : undefined))
      .groupBy(h.install_id, h.product);
    out.push(db.insert(usage_daily).select(sums).onConflictDoUpdate(upsert));
    if (levels.length > 0) {
      // SQLite gives a bare column the value of the row MAX() picked: the
      // level of the day's last hour.
      const last = db
        .select({
          install_id: h.install_id,
          product: h.product,
          value: h.value,
          last_hour: sql<number>`max(${h.hour})`.as("last_hour"),
        })
        .from(h)
        .where(and(...scope, inArray(h.product, [...levels])))
        .groupBy(h.install_id, h.product)
        .as("last");
      const lastLevels = db
        .select({
          install_id: last.install_id,
          product: last.product,
          day: sql<number>`${day}`.as("day"),
          value: last.value,
        })
        .from(last)
        // Without a WHERE, SQLite could read the upsert's ON as a join's.
        .where(sql`true`);
      out.push(db.insert(usage_daily).select(lastLevels).onConflictDoUpdate(upsert));
    }
  }
  return out;
}

/**
 * One product of one install from `from` (inclusive) to `to` (exclusive),
 * unix seconds, oldest first. Hours or days with no row are absent.
 */
export async function readSeries(
  db: Database,
  query: { installId: string; product: string; from: number; to: number; grain: UsageGrain },
): Promise<UsagePoint[]> {
  if (query.grain === "hour") {
    const rows = await db
      .select({ t: usage_hourly.hour, value: usage_hourly.value })
      .from(usage_hourly)
      .where(
        and(
          eq(usage_hourly.install_id, query.installId),
          eq(usage_hourly.product, query.product),
          gte(usage_hourly.hour, query.from),
          lt(usage_hourly.hour, query.to),
        ),
      )
      .orderBy(asc(usage_hourly.hour));
    return rows;
  }
  return db
    .select({ t: usage_daily.day, value: usage_daily.value })
    .from(usage_daily)
    .where(
      and(
        eq(usage_daily.install_id, query.installId),
        eq(usage_daily.product, query.product),
        gte(usage_daily.day, query.from),
        lt(usage_daily.day, query.to),
      ),
    )
    .orderBy(asc(usage_daily.day));
}

/**
 * Every product of the given installs (every install when omitted) from
 * `from` (inclusive) to `to` (exclusive), unix seconds, ordered by time,
 * then install and product.
 */
export async function readUsage(
  db: Database,
  query: { from: number; to: number; grain: UsageGrain; installIds?: readonly string[] },
): Promise<UsageRow[]> {
  const table = query.grain === "hour" ? usage_hourly : usage_daily;
  const time = query.grain === "hour" ? usage_hourly.hour : usage_daily.day;
  const groups =
    query.installIds === undefined ? [null] : chunk(query.installIds, MAX_BOUND_PARAMETERS - 2);
  const out: UsageRow[] = [];
  for (const ids of groups) {
    const rows = await db
      .select({
        installId: table.install_id,
        product: table.product,
        t: time,
        value: table.value,
      })
      .from(table)
      .where(
        and(
          gte(time, query.from),
          lt(time, query.to),
          ids === null ? undefined : inArray(table.install_id, ids),
        ),
      );
    out.push(...rows);
  }
  return out.sort(
    (a, b) =>
      a.t - b.t || a.installId.localeCompare(b.installId) || a.product.localeCompare(b.product),
  );
}

/**
 * Deletes hourly rows older than `HOURLY_RETENTION_DAYS` and days older
 * than `DAILY_RETENTION_DAYS`, counted back from `now`. Returns how many
 * rows of each went.
 */
export async function pruneUsage(
  db: Database,
  now: Date = new Date(),
): Promise<{ hourly: number; daily: number }> {
  const nowSeconds = toUnixSeconds(now.getTime());
  const [hourly, daily] = await db.batch([
    db
      .delete(usage_hourly)
      .where(lt(usage_hourly.hour, nowSeconds - HOURLY_RETENTION_DAYS * DAY_SECONDS)),
    db
      .delete(usage_daily)
      .where(lt(usage_daily.day, dayStart(nowSeconds) - DAILY_RETENTION_DAYS * DAY_SECONDS)),
  ]);
  return { hourly: hourly.meta.changes, daily: daily.meta.changes };
}
