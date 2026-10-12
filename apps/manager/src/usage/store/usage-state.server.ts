import { eq, inArray, sql } from "drizzle-orm";
import type { BatchItem } from "drizzle-orm/batch";
import type { Database } from "../../db/client";
import { app_usage_state } from "../../db/schema";
import { chunk, MAX_BOUND_PARAMETERS, rowsPerStatement, STATEMENTS_PER_BATCH } from "./limits";

/**
 * What the spend watcher remembers about each install between checks: how
 * many checks in a row the loop trigger tripped, the unusual-usage episode
 * it is in (so each episode alerts once), the day it last warned that a free
 * daily limit runs out, and the last burn and normal it computed.
 */

export interface UsageState {
  installId: string;
  /** Consecutive checks the loop trigger tripped on. */
  loopChecks: number;
  /** Epoch ms the current unusual-usage episode began; null outside one. */
  unusualSince: number | null;
  /** The unix second of the UTC day a free daily limit warning was last sent. */
  limitWarnedDay: number | null;
  /** Epoch ms; null for an install never checked. */
  lastCheckedAt: number | null;
  /** Dollars an hour at list price. */
  lastBurn: number | null;
  normalBurn: number | null;
}

type Row = typeof app_usage_state.$inferSelect;

function fromRow(row: Row): UsageState {
  return {
    installId: row.install_id,
    loopChecks: row.loop_checks,
    unusualSince: row.unusual_since?.getTime() ?? null,
    limitWarnedDay: row.limit_warned_day,
    lastCheckedAt: row.last_checked_at?.getTime() ?? null,
    lastBurn: row.last_burn,
    normalBurn: row.normal_burn,
  };
}

/** The state of an install the watcher never checked. */
export function initialUsageState(installId: string): UsageState {
  return {
    installId,
    loopChecks: 0,
    unusualSince: null,
    limitWarnedDay: null,
    lastCheckedAt: null,
    lastBurn: null,
    normalBurn: null,
  };
}

export async function readUsageState(db: Database, installId: string): Promise<UsageState> {
  const [row] = await db
    .select()
    .from(app_usage_state)
    .where(eq(app_usage_state.install_id, installId));
  return row ? fromRow(row) : initialUsageState(installId);
}

/** The state of each given install (initial for one never checked). */
export async function readUsageStates(
  db: Database,
  installIds: readonly string[],
): Promise<Map<string, UsageState>> {
  const out = new Map<string, UsageState>();
  for (const id of installIds) out.set(id, initialUsageState(id));
  for (const ids of chunk(installIds, MAX_BOUND_PARAMETERS)) {
    const rows = await db
      .select()
      .from(app_usage_state)
      .where(inArray(app_usage_state.install_id, ids));
    for (const row of rows) out.set(row.install_id, fromRow(row));
  }
  return out;
}

/**
 * Stores the watcher's new state of each install as one check's result,
 * stamped `checkedAt`: whole rows, in as few statements as D1's parameter
 * limit allows.
 */
export async function writeUsageStates(
  db: Database,
  states: readonly Omit<UsageState, "lastCheckedAt">[],
  checkedAt: Date = new Date(),
): Promise<void> {
  const items: BatchItem<"sqlite">[] = chunk(states, rowsPerStatement(7)).map((part) =>
    db
      .insert(app_usage_state)
      .values(
        part.map((s) => ({
          install_id: s.installId,
          loop_checks: s.loopChecks,
          unusual_since: s.unusualSince === null ? null : new Date(s.unusualSince),
          limit_warned_day: s.limitWarnedDay,
          last_checked_at: checkedAt,
          last_burn: s.lastBurn,
          normal_burn: s.normalBurn,
        })),
      )
      .onConflictDoUpdate({
        target: app_usage_state.install_id,
        set: {
          loop_checks: sql`excluded.loop_checks`,
          unusual_since: sql`excluded.unusual_since`,
          limit_warned_day: sql`excluded.limit_warned_day`,
          last_checked_at: sql`excluded.last_checked_at`,
          last_burn: sql`excluded.last_burn`,
          normal_burn: sql`excluded.normal_burn`,
        },
      }),
  );
  for (const part of chunk(items, STATEMENTS_PER_BATCH)) {
    const [first, ...rest] = part;
    if (first) await db.batch([first, ...rest]);
  }
}

/**
 * Changes some of an install's state, leaving the rest as it was (for one
 * install, outside the watcher's check: say, ending an episode on resume).
 */
export async function updateUsageState(
  db: Database,
  installId: string,
  patch: Partial<Omit<UsageState, "installId" | "lastCheckedAt">>,
): Promise<UsageState> {
  const set = {
    loop_checks: patch.loopChecks,
    unusual_since:
      patch.unusualSince === undefined
        ? undefined
        : patch.unusualSince === null
          ? null
          : new Date(patch.unusualSince),
    limit_warned_day: patch.limitWarnedDay,
    last_burn: patch.lastBurn,
    normal_burn: patch.normalBurn,
  };
  const insert = db.insert(app_usage_state).values({ ...set, install_id: installId });
  if (Object.values(set).every((v) => v === undefined)) {
    await insert.onConflictDoNothing();
  } else {
    await insert.onConflictDoUpdate({ target: app_usage_state.install_id, set });
  }
  return readUsageState(db, installId);
}
