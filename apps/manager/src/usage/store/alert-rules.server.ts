import { and, asc, eq, inArray, lt, sql } from "drizzle-orm";
import { ulid } from "ulidx";
import { z } from "zod";
import { type Read, read } from "../../db/batch";
import type { Database } from "../../db/client";
import {
  ALERT_RULE_KINDS,
  ALERT_RULE_UNITS,
  type AlertRuleKind,
  type AlertRuleUnit,
  SPEND_PERIODS,
  type SpendPeriod,
  usage_alert_firings,
  usage_alert_rules,
} from "../../db/schema";
import { chunk, DAY_SECONDS, MAX_BOUND_PARAMETERS, toUnixSeconds } from "./limits";

/**
 * Usage alert rules ("When it has spent $6 this month") and their firings.
 * A rule fires at most once per period: `usage_alert_firings` is keyed by
 * the rule and the period's start, so recording a firing twice is a no-op.
 */

export const alertRuleInputSchema = z.object({
  kind: z.enum(ALERT_RULE_KINDS),
  unit: z.enum(ALERT_RULE_UNITS),
  amount: z.number().positive(),
  period: z.enum(SPEND_PERIODS),
});
export type AlertRuleInput = z.infer<typeof alertRuleInputSchema>;

export interface AlertFiring {
  /** The unix second the rule's period started. */
  periodStart: number;
  /** Epoch ms. */
  firedAt: number;
  /** What the rule watched when it fired. */
  value: number;
}

export interface AlertRule {
  id: string;
  installId: string;
  kind: AlertRuleKind;
  unit: AlertRuleUnit;
  amount: number;
  period: SpendPeriod;
  /** Epoch ms. */
  createdAt: number;
  createdBy: string;
  /** The rule's most recent firing, in any period; null if it never fired. */
  lastFiring: AlertFiring | null;
}

type RuleRow = typeof usage_alert_rules.$inferSelect;

function fromRow(row: RuleRow, lastFiring: AlertFiring | null): AlertRule {
  return {
    id: row.id,
    installId: row.install_id,
    kind: row.kind,
    unit: row.unit,
    amount: row.amount,
    period: row.period,
    createdAt: row.created_at.getTime(),
    createdBy: row.created_by,
    lastFiring,
  };
}

/** The latest firing of each given rule. */
async function lastFirings(
  db: Database,
  ruleIds: readonly string[],
): Promise<Map<string, AlertFiring>> {
  const out = new Map<string, AlertFiring>();
  for (const ids of chunk(ruleIds, MAX_BOUND_PARAMETERS)) {
    // SQLite gives the bare columns the values of the row MAX() picked.
    const rows = await db
      .select({
        ruleId: usage_alert_firings.rule_id,
        periodStart: sql<number>`max(${usage_alert_firings.period_start})`,
        firedAt: usage_alert_firings.fired_at,
        value: usage_alert_firings.value,
      })
      .from(usage_alert_firings)
      .where(inArray(usage_alert_firings.rule_id, ids))
      .groupBy(usage_alert_firings.rule_id);
    for (const row of rows) {
      out.set(row.ruleId, {
        periodStart: row.periodStart,
        firedAt: row.firedAt.getTime(),
        value: row.value,
      });
    }
  }
  return out;
}

async function withFirings(db: Database, rows: RuleRow[]): Promise<AlertRule[]> {
  const fired = await lastFirings(
    db,
    rows.map((r) => r.id),
  );
  return rows.map((row) => fromRow(row, fired.get(row.id) ?? null));
}

/**
 * Every install's rules, oldest first, with their latest firings, as one
 * read (db/batch.ts): the same as `listAlertRules(db)`.
 */
export function allAlertRulesRead(db: Database): Read<AlertRule[]> {
  return read(
    [
      db
        .select()
        .from(usage_alert_rules)
        .orderBy(asc(usage_alert_rules.created_at), asc(usage_alert_rules.id)),
      // SQLite gives the bare columns the values of the row MAX() picked.
      db
        .select({
          ruleId: usage_alert_firings.rule_id,
          periodStart: sql<number>`max(${usage_alert_firings.period_start})`,
          firedAt: usage_alert_firings.fired_at,
          value: usage_alert_firings.value,
        })
        .from(usage_alert_firings)
        .where(
          inArray(
            usage_alert_firings.rule_id,
            db.select({ id: usage_alert_rules.id }).from(usage_alert_rules),
          ),
        )
        .groupBy(usage_alert_firings.rule_id),
    ],
    ([rules, firings]) => {
      const fired = new Map<string, AlertFiring>();
      for (const row of firings as Array<{
        ruleId: string;
        periodStart: number;
        firedAt: Date;
        value: number;
      }>) {
        fired.set(row.ruleId, {
          periodStart: row.periodStart,
          firedAt: row.firedAt.getTime(),
          value: row.value,
        });
      }
      return (rules as RuleRow[]).map((row) => fromRow(row, fired.get(row.id) ?? null));
    },
  );
}

/** An install's rules, oldest first; every install's when `installId` is omitted. */
export async function listAlertRules(db: Database, installId?: string): Promise<AlertRule[]> {
  const rows = await db
    .select()
    .from(usage_alert_rules)
    .where(installId === undefined ? undefined : eq(usage_alert_rules.install_id, installId))
    .orderBy(asc(usage_alert_rules.created_at), asc(usage_alert_rules.id));
  return withFirings(db, rows);
}

export async function readAlertRule(db: Database, id: string): Promise<AlertRule | null> {
  const rows = await db.select().from(usage_alert_rules).where(eq(usage_alert_rules.id, id));
  const [rule] = await withFirings(db, rows);
  return rule ?? null;
}

/** Adds a rule (validated; throws a ZodError on a bad value). */
export async function createAlertRule(
  db: Database,
  installId: string,
  input: AlertRuleInput,
  by: { userId: string; now?: Date },
): Promise<AlertRule> {
  const r = alertRuleInputSchema.parse(input);
  const [row] = await db
    .insert(usage_alert_rules)
    .values({
      id: ulid(),
      install_id: installId,
      ...r,
      created_at: by.now ?? new Date(),
      created_by: by.userId,
    })
    .returning();
  if (!row) throw new Error("The alert rule was not stored");
  return fromRow(row, null);
}

/**
 * Changes a rule of the install; returns null when it has no such rule.
 * A change of what it watches (kind, unit, amount or period) deletes its
 * firings: the rule is a new one, so a raised amount can fire again this
 * period, and its badge never says "sent" for an amount it never reached.
 * What was sent stays in the activity log.
 */
export async function updateAlertRule(
  db: Database,
  installId: string,
  id: string,
  patch: Partial<AlertRuleInput>,
): Promise<AlertRule | null> {
  const p = alertRuleInputSchema.partial().parse(patch);
  const current = await readOwnRule(db, installId, id);
  if (!current) return null;
  const changed = (Object.keys(p) as (keyof AlertRuleInput)[]).some(
    (k) => p[k] !== undefined && p[k] !== current[k],
  );
  if (!changed) return current;
  const own = and(eq(usage_alert_rules.id, id), eq(usage_alert_rules.install_id, installId));
  const [rows] = await db.batch([
    db.update(usage_alert_rules).set(p).where(own).returning(),
    db.delete(usage_alert_firings).where(eq(usage_alert_firings.rule_id, id)),
  ]);
  return (await withFirings(db, rows))[0] ?? null;
}

async function readOwnRule(db: Database, installId: string, id: string) {
  const rule = await readAlertRule(db, id);
  return rule?.installId === installId ? rule : null;
}

/** Removes a rule of the install and its firings; returns whether it existed. */
export async function deleteAlertRule(
  db: Database,
  installId: string,
  id: string,
): Promise<boolean> {
  const own = and(eq(usage_alert_rules.id, id), eq(usage_alert_rules.install_id, installId));
  const [, rules] = await db.batch([
    db
      .delete(usage_alert_firings)
      .where(
        inArray(
          usage_alert_firings.rule_id,
          db.select({ id: usage_alert_rules.id }).from(usage_alert_rules).where(own),
        ),
      ),
    db.delete(usage_alert_rules).where(own),
  ]);
  return rules.meta.changes > 0;
}

/**
 * Records that a rule fired in the period starting at `periodStart` (unix
 * seconds). Returns true only for the first firing of that period, so the
 * caller notifies exactly once. Firings only dedupe: editing or removing
 * the rule deletes them. The history is the activity log, so the caller
 * also records an `alert_sent` entry with the rule's sentence as it read
 * when it fired.
 */
export async function recordAlertFiring(
  db: Database,
  firing: { ruleId: string; periodStart: number; value: number; firedAt?: Date },
): Promise<boolean> {
  const inserted = await db
    .insert(usage_alert_firings)
    .values({
      rule_id: firing.ruleId,
      period_start: firing.periodStart,
      value: firing.value,
      fired_at: firing.firedAt ?? new Date(),
    })
    .onConflictDoNothing()
    .returning({ ruleId: usage_alert_firings.rule_id });
  return inserted.length > 0;
}

/** Deletes firings of periods that started more than `days` (default 400) days before `now`. */
export async function pruneAlertFirings(
  db: Database,
  now: Date = new Date(),
  days = 400,
): Promise<number> {
  const result = await pruneAlertFiringsStatement(db, now, days);
  return result.meta.changes;
}

/** The delete of {@link pruneAlertFirings}, to batch with others. */
export function pruneAlertFiringsStatement(db: Database, now: Date, days = 400) {
  const cutoff = toUnixSeconds(now.getTime()) - days * DAY_SECONDS;
  return db.delete(usage_alert_firings).where(lt(usage_alert_firings.period_start, cutoff));
}
