import { and, eq, inArray, isNull } from "drizzle-orm";
import type { BatchItem } from "drizzle-orm/batch";
import type { Database } from "../../db/client";
import {
  app_pauses,
  app_spend_settings,
  app_usage_state,
  usage_alert_firings,
  usage_alert_rules,
} from "../../db/schema";

/**
 * The statements that remove an uninstalled app's spend protection: its own
 * settings, its alert rules and their firings, the watcher's state, and any
 * open pause (closed now, by no one: there is nothing left to resume). Its
 * usage and activity stay: this month's bill still counts what it used, and
 * they are pruned with everyone else's. For a caller that runs them in the
 * same batch as its own statements, such as marking the install uninstalled.
 */
export function forgetInstallSpendStatements(
  db: Database,
  installId: string,
  now: Date = new Date(),
): [BatchItem<"sqlite">, ...BatchItem<"sqlite">[]] {
  const rules = db
    .select({ id: usage_alert_rules.id })
    .from(usage_alert_rules)
    .where(eq(usage_alert_rules.install_id, installId));
  return [
    db.delete(usage_alert_firings).where(inArray(usage_alert_firings.rule_id, rules)),
    db.delete(usage_alert_rules).where(eq(usage_alert_rules.install_id, installId)),
    db.delete(app_spend_settings).where(eq(app_spend_settings.install_id, installId)),
    db.delete(app_usage_state).where(eq(app_usage_state.install_id, installId)),
    db
      .update(app_pauses)
      .set({ resumed_at: now, resumed_by: null })
      .where(and(eq(app_pauses.install_id, installId), isNull(app_pauses.resumed_at))),
  ];
}

/** Removes an uninstalled app's spend protection in one transaction ({@link forgetInstallSpendStatements}). */
export async function forgetInstallSpend(
  db: Database,
  installId: string,
  now: Date = new Date(),
): Promise<void> {
  await db.batch(forgetInstallSpendStatements(db, installId, now));
}
