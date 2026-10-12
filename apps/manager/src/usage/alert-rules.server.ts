import { and, eq, inArray, type SQL, sql } from "drizzle-orm";
import { ulid } from "ulidx";
import type { AccountPlan } from "../account/plan";
import { readAccountPlan } from "../account/plan.server";
import type { Database } from "../db/client";
import { installs, usage_activity, usage_alert_firings, usage_alert_rules } from "../db/schema";
import { type AlertRuleFields, alertSentence, planRefusal } from "./alert-rules";
import { ACTIVITY_FACTS } from "./store/activity";
import { type AlertRule, alertRuleInputSchema, readAlertRule } from "./store/alert-rules.server";

/**
 * Adding, changing and removing an app's usage alerts, each recorded in the
 * app's usage activity (`settings_changed`, with the rule's sentence) in
 * the same batch as the change, so a change is never saved without its
 * record. The rules keep the store's meaning (usage/store/alert-rules): a
 * change of what a rule watches deletes its firings, so it can fire again
 * this period; removing a rule removes its firings. Server only.
 */

export class AlertRuleError extends Error {
  override name = "AlertRuleError";
}

export const ALERT_RULE_MESSAGES = {
  noInstall: "There is no such app.",
  noRule: "There is no such alert. It may have been removed.",
} as const;

/** The setting name these changes record. */
export const ALERT_SETTING = "usageAlerts";

interface By {
  userId: string;
  now?: Date;
}

/**
 * The plan, after checking the install exists and is not uninstalled, and
 * with `ruleId` the install's rule of that id. One round; the install is
 * judged before the rule.
 */
async function readContext(
  db: Database,
  installId: string,
  ruleId?: string,
): Promise<{ plan: AccountPlan; rule: AlertRule | null }> {
  const [install, plan, rule] = await Promise.all([
    db
      .select({ status: installs.status })
      .from(installs)
      .where(eq(installs.id, installId))
      .limit(1),
    readAccountPlan(db),
    ruleId === undefined ? Promise.resolve(null) : readAlertRule(db, ruleId),
  ]);
  if (install[0] === undefined || install[0].status === "uninstalled") {
    throw new AlertRuleError(ALERT_RULE_MESSAGES.noInstall);
  }
  if (ruleId !== undefined && (rule === null || rule.installId !== installId)) {
    throw new AlertRuleError(ALERT_RULE_MESSAGES.noRule);
  }
  return { plan, rule };
}

/** The install's rule of `ruleId`, after the checks of {@link readContext}. */
async function readOwnRule(db: Database, installId: string, ruleId: string) {
  const { plan, rule } = await readContext(db, installId, ruleId);
  if (rule === null) throw new AlertRuleError(ALERT_RULE_MESSAGES.noRule);
  return { plan, current: rule };
}

function activityRow(
  installId: string,
  by: By,
  at: Date,
  facts: { alert: "added" | "changed" | "removed"; sentence: string; ruleId: string },
) {
  const checked = ACTIVITY_FACTS.settings_changed.parse({ changed: [ALERT_SETTING], ...facts });
  return {
    id: ulid(),
    install_id: installId,
    at,
    kind: "settings_changed" as const,
    by: by.userId,
    facts_json: JSON.stringify(checked),
  };
}

/**
 * Inserts the activity row only while the rule matching `own` exists
 * (INSERT … SELECT from the rule), so an edit or removal that lost a race
 * with another removal records nothing.
 */
function activityIfRuleExists(
  db: Database,
  own: SQL | undefined,
  row: ReturnType<typeof activityRow>,
) {
  return db.insert(usage_activity).select(
    db
      .select({
        id: sql<string>`${row.id}`.as("id"),
        install_id: sql<string>`${row.install_id}`.as("install_id"),
        at: sql<Date>`${row.at.getTime()}`.as("at"),
        kind: sql<"settings_changed">`${row.kind}`.as("kind"),
        by: sql<string>`${row.by}`.as("by"),
        facts_json: sql<string>`${row.facts_json}`.as("facts_json"),
      })
      .from(usage_alert_rules)
      .where(own),
  );
}

/** Adds a usage alert to the app; returns its id. */
export async function addAlertRule(
  db: Database,
  installId: string,
  rule: AlertRuleFields,
  by: By,
): Promise<string> {
  const { plan } = await readContext(db, installId);
  const refusal = planRefusal(plan, rule);
  if (refusal !== null) throw new AlertRuleError(refusal);
  const r = alertRuleInputSchema.parse(rule);
  const now = by.now ?? new Date();
  const id = ulid();
  await db.batch([
    db.insert(usage_alert_rules).values({
      id,
      install_id: installId,
      ...r,
      created_at: now,
      created_by: by.userId,
    }),
    db.insert(usage_activity).values(
      activityRow(installId, by, now, {
        alert: "added",
        sentence: alertSentence(plan, r),
        ruleId: id,
      }),
    ),
  ]);
  return id;
}

/** Changes one of the app's usage alerts; a rule changed in nothing is left alone. */
export async function changeAlertRule(
  db: Database,
  installId: string,
  ruleId: string,
  rule: AlertRuleFields,
  by: By,
): Promise<void> {
  const { plan, current } = await readOwnRule(db, installId, ruleId);
  const refusal = planRefusal(plan, rule);
  if (refusal !== null) throw new AlertRuleError(refusal);
  const r = alertRuleInputSchema.parse(rule);
  const same =
    r.kind === current.kind &&
    r.unit === current.unit &&
    r.amount === current.amount &&
    r.period === current.period;
  if (same) return;
  const now = by.now ?? new Date();
  const own = and(eq(usage_alert_rules.id, ruleId), eq(usage_alert_rules.install_id, installId));
  await db.batch([
    // Recorded only while the rule exists: a rule removed meanwhile is no change.
    activityIfRuleExists(
      db,
      own,
      activityRow(installId, by, now, {
        alert: "changed",
        sentence: alertSentence(plan, r),
        ruleId,
      }),
    ),
    db.update(usage_alert_rules).set(r).where(own),
    // What it watches changed: a new rule, which may fire again this period.
    db.delete(usage_alert_firings).where(eq(usage_alert_firings.rule_id, ruleId)),
  ]);
}

/** Removes one of the app's usage alerts and its firings. */
export async function removeAlertRule(
  db: Database,
  installId: string,
  ruleId: string,
  by: By,
): Promise<void> {
  const { plan, current } = await readOwnRule(db, installId, ruleId);
  const now = by.now ?? new Date();
  const own = and(eq(usage_alert_rules.id, ruleId), eq(usage_alert_rules.install_id, installId));
  await db.batch([
    // Recorded only while the rule exists, so removing it twice records it once.
    activityIfRuleExists(
      db,
      own,
      activityRow(installId, by, now, {
        alert: "removed",
        sentence: alertSentence(plan, current),
        ruleId,
      }),
    ),
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
}
