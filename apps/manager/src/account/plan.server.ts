import { parseStoredCapabilities, resolveAccountPlan } from "../capabilities/capabilities";
import { type Read, read, runRead } from "../db/batch";
import type { Database } from "../db/client";
import { SETTING, settingsRead, writeSettings } from "../db/settings";
import type { AccountPlan } from "./plan";

/**
 * The account's Workers plan in force: the one the capability probes
 * detected, else `settings.account_plan` as an admin set it, else free.
 */
export async function readAccountPlan(db: Database): Promise<AccountPlan> {
  return runRead(db, accountPlanRead(db));
}

/** {@link readAccountPlan} as a read that can share a round trip with others (db/batch.ts). */
export function accountPlanRead(db: Database): Read<AccountPlan> {
  const rows = settingsRead(db, [SETTING.accountPlan, SETTING.accountCapabilities]);
  return read(rows.queries, (results) => {
    const row = rows.decode(results);
    return resolveAccountPlan(row.account_plan, parseStoredCapabilities(row.account_capabilities))
      .plan;
  });
}

/** Records the plan an admin states; it applies whenever none is detected. */
export async function writeAccountPlan(
  db: Database,
  plan: AccountPlan,
  now: Date = new Date(),
): Promise<void> {
  await writeSettings(db, { [SETTING.accountPlan]: plan }, now);
}
