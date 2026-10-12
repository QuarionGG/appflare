import { sql } from "drizzle-orm";
import { ulid } from "ulidx";
import { readAccountPlan } from "../account/plan.server";
import type { Database } from "../db/client";
import { settings, usage_activity } from "../db/schema";
import { SETTING } from "../db/settings";
import type { SetSpendDefaultsInput } from "./spend-defaults";
import { ACTIVITY_FACTS } from "./store/activity";
import { readSpendDefaults } from "./store/defaults.server";
import { type SpendDefaults, spendDefaultsPatchSchema } from "./store/spend-settings";

export const FREE_DOLLARS_REFUSAL =
  "Workers Free can't bill you for Workers, so there's no dollar cap or budget.";

/** A value as JSON with its keys sorted, so two objects compare by content. */
function canonical(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  const entries = Object.entries(value).sort(([a], [b]) => a.localeCompare(b));
  return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${canonical(v)}`).join(",")}}`;
}

/**
 * Each default's `settings` row as `readSpendDefaults` reads it back: `on`
 * or `off` for auto-pause, JSON for the triggers and the budget, the factor
 * as a number.
 */
function settingRows(patch: Partial<SpendDefaults>): { key: string; value: string }[] {
  const rows: { key: string; value: string }[] = [];
  if (patch.autoPause !== undefined) {
    rows.push({ key: SETTING.spendAutoPause, value: patch.autoPause ? "on" : "off" });
  }
  if (patch.loop !== undefined) {
    rows.push({ key: SETTING.spendLoop, value: JSON.stringify(patch.loop) });
  }
  if (patch.cap !== undefined) {
    rows.push({ key: SETTING.spendCap, value: JSON.stringify(patch.cap) });
  }
  if (patch.budget !== undefined) {
    rows.push({ key: SETTING.spendBudget, value: JSON.stringify(patch.budget) });
  }
  if (patch.unusualFactor !== undefined) {
    rows.push({ key: SETTING.spendUnusualFactor, value: String(patch.unusualFactor) });
  }
  return rows;
}

/**
 * Changes the account's spend protection defaults and records what changed
 * in the usage activity log (account-level: no install), by name, not value,
 * in one batch, so a change is never saved without its record or the other
 * way round. A patch that changes nothing writes nothing and records nothing.
 */
export async function changeSpendDefaults(
  db: Database,
  patch: SetSpendDefaultsInput,
  by: { userId: string; now?: Date },
): Promise<SpendDefaults> {
  const [before, plan] = await Promise.all([readSpendDefaults(db), readAccountPlan(db)]);
  // Workers Free bills nothing for Workers: a dollar cap or budget there would never trip.
  if (plan === "free" && (patch.cap?.on === true || patch.budget?.on === true)) {
    throw new Error(FREE_DOLLARS_REFUSAL);
  }
  const changed = (Object.keys(patch) as (keyof SpendDefaults)[]).filter(
    (key) => patch[key] !== undefined && canonical(patch[key]) !== canonical(before[key]),
  );
  if (changed.length === 0) return before;
  const only = spendDefaultsPatchSchema.parse(
    Object.fromEntries(changed.map((key) => [key, patch[key]])),
  );
  const facts = ACTIVITY_FACTS.settings_changed.parse({ changed });
  const now = by.now ?? new Date();
  await db.batch([
    db
      .insert(settings)
      .values(settingRows(only).map((row) => ({ ...row, updated_at: now })))
      .onConflictDoUpdate({
        target: settings.key,
        set: { value: sql`excluded.value`, updated_at: sql`excluded.updated_at` },
      }),
    db.insert(usage_activity).values({
      id: ulid(),
      install_id: null,
      at: now,
      kind: "settings_changed",
      by: by.userId,
      facts_json: JSON.stringify(facts),
    }),
  ]);
  return readSpendDefaults(db);
}
