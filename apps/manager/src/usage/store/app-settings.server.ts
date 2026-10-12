import { eq, inArray } from "drizzle-orm";
import type { Database } from "../../db/client";
import { app_spend_settings } from "../../db/schema";
import { readSpendDefaults } from "./defaults.server";
import { chunk, MAX_BOUND_PARAMETERS } from "./limits";
import {
  type AppSpendSettings,
  type AppSpendSettingsPatch,
  appSpendSettingsPatchSchema,
  defaultAppSpendSettings,
  type EffectiveSpendSettings,
  resolveSpendSettings,
  UNUSUAL_FACTORS,
  type UnusualFactor,
} from "./spend-settings";

/**
 * An app's own spend protection settings. An app with no row follows the
 * account in everything; the first change writes the row.
 */

type Row = typeof app_spend_settings.$inferSelect;

/** A stored factor that is not one of the choices follows the account. */
function asUnusualFactor(value: number | null): UnusualFactor | null {
  return UNUSUAL_FACTORS.find((f) => f === value) ?? null;
}

function fromRow(row: Row): AppSpendSettings {
  return {
    installId: row.install_id,
    unusualFactor: asUnusualFactor(row.unusual_factor),
    autoPause: row.auto_pause,
    customTriggers: row.custom_triggers,
    loopOn: row.loop_on,
    loopLevel: row.loop_level,
    capOn: row.cap_on,
    capAmount: row.cap_amount,
    capPeriod: row.cap_period,
    budgetExempt: row.budget_exempt,
    capSetAsideUntil: row.cap_set_aside_until?.getTime() ?? null,
    updatedAt: row.updated_at.getTime(),
    updatedBy: row.updated_by,
  };
}

export async function readAppSpendSettings(
  db: Database,
  installId: string,
): Promise<AppSpendSettings> {
  const [row] = await db
    .select()
    .from(app_spend_settings)
    .where(eq(app_spend_settings.install_id, installId));
  return row ? fromRow(row) : defaultAppSpendSettings(installId);
}

/** The settings of the given installs, or of every install with a row when omitted. */
async function readMany(
  db: Database,
  installIds?: readonly string[],
): Promise<Map<string, AppSpendSettings>> {
  const rows: Row[] = [];
  if (installIds === undefined) {
    rows.push(...(await db.select().from(app_spend_settings)));
  } else {
    for (const ids of chunk(installIds, MAX_BOUND_PARAMETERS)) {
      rows.push(
        ...(await db
          .select()
          .from(app_spend_settings)
          .where(inArray(app_spend_settings.install_id, ids))),
      );
    }
  }
  const out = new Map<string, AppSpendSettings>();
  for (const id of installIds ?? []) out.set(id, defaultAppSpendSettings(id));
  for (const row of rows) out.set(row.install_id, fromRow(row));
  return out;
}

/**
 * Changes some of an app's settings (validated; throws a ZodError on a bad
 * value), leaving the rest as they were, and returns them all.
 */
export async function writeAppSpendSettings(
  db: Database,
  installId: string,
  patch: AppSpendSettingsPatch,
  by: { userId: string; now?: Date },
): Promise<AppSpendSettings> {
  const p = appSpendSettingsPatchSchema.parse(patch);
  const now = by.now ?? new Date();
  const set: Partial<typeof app_spend_settings.$inferInsert> = {
    unusual_factor: p.unusualFactor,
    auto_pause: p.autoPause,
    custom_triggers: p.customTriggers,
    loop_on: p.loopOn,
    loop_level: p.loopLevel,
    cap_on: p.capOn,
    cap_amount: p.capAmount,
    cap_period: p.capPeriod,
    budget_exempt: p.budgetExempt,
    cap_set_aside_until:
      p.capSetAsideUntil === undefined
        ? undefined
        : p.capSetAsideUntil === null
          ? null
          : new Date(p.capSetAsideUntil),
    updated_at: now,
    updated_by: by.userId,
  };
  // Drizzle leaves out `undefined` values, so only the patched columns change.
  await db
    .insert(app_spend_settings)
    .values({ ...set, install_id: installId, updated_at: now, updated_by: by.userId })
    .onConflictDoUpdate({ target: app_spend_settings.install_id, set });
  return readAppSpendSettings(db, installId);
}

/** An app's settings with the account's defaults applied. */
export async function effectiveSpendSettings(
  db: Database,
  installId: string,
): Promise<EffectiveSpendSettings> {
  const [defaults, app] = await Promise.all([
    readSpendDefaults(db),
    readAppSpendSettings(db, installId),
  ]);
  return resolveSpendSettings(defaults, app);
}

/** `effectiveSpendSettings` for many installs, in two queries (plus one per 100 ids). */
export async function effectiveSpendSettingsOf(
  db: Database,
  installIds: readonly string[],
): Promise<Map<string, EffectiveSpendSettings>> {
  const [defaults, apps] = await Promise.all([readSpendDefaults(db), readMany(db, installIds)]);
  const out = new Map<string, EffectiveSpendSettings>();
  for (const [id, app] of apps) out.set(id, resolveSpendSettings(defaults, app));
  return out;
}

/** Every app that changed any setting (for "Set their own" and "Never paused for the budget"). */
export async function readCustomizedAppSpendSettings(db: Database): Promise<AppSpendSettings[]> {
  return [...(await readMany(db)).values()];
}
