import { eq } from "drizzle-orm";
import { ulid } from "ulidx";
import { readAccountPlan } from "../account/plan.server";
import type { Database } from "../db/client";
import { app_spend_settings, installs, usage_activity } from "../db/schema";
import { type AppSpendPatch, FREE_CAP_REFUSAL } from "./app-spend";
import { ACTIVITY_FACTS } from "./store/activity";
import { readAppSpendSettings } from "./store/app-settings.server";
import { type AppSpendSettings, appSpendSettingsPatchSchema } from "./store/spend-settings";

/**
 * Changes one app's spend protection settings and records which changed (by
 * name, not value) in the app's usage activity, in one batch, so a change is
 * never saved without its record or the other way round. A patch that
 * changes nothing writes nothing. Server only.
 */

export class AppSpendError extends Error {
  override name = "AppSpendError";
}

type PatchKey = keyof AppSpendPatch;

/** A patch's part as the stored settings hold it, to tell whether it changes them. */
function storedPart(key: PatchKey, s: AppSpendSettings): unknown {
  switch (key) {
    case "loop":
      return { on: s.loopOn, level: s.loopLevel };
    case "cap":
      return { on: s.capOn, amount: s.capAmount, period: s.capPeriod };
    default:
      return s[key];
  }
}

function same(a: unknown, b: unknown): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

export async function changeAppSpendSettings(
  db: Database,
  installId: string,
  patch: AppSpendPatch,
  by: { userId: string; now?: Date },
): Promise<AppSpendSettings> {
  const [install, before, plan] = await Promise.all([
    db
      .select({ status: installs.status })
      .from(installs)
      .where(eq(installs.id, installId))
      .limit(1),
    readAppSpendSettings(db, installId),
    readAccountPlan(db),
  ]);
  if (install[0] === undefined || install[0].status === "uninstalled") {
    throw new AppSpendError("There is no such app.");
  }
  if (plan === "free" && patch.cap?.on === true && patch.cap.amount !== null) {
    throw new AppSpendError(FREE_CAP_REFUSAL);
  }
  const changed = (Object.keys(patch) as PatchKey[]).filter(
    (key) => patch[key] !== undefined && !same(patch[key], storedPart(key, before)),
  );
  if (changed.length === 0) return before;
  const has = (key: PatchKey) => changed.includes(key);
  const p = appSpendSettingsPatchSchema.parse({
    unusualFactor: has("unusualFactor") ? patch.unusualFactor : undefined,
    autoPause: has("autoPause") ? patch.autoPause : undefined,
    customTriggers: has("customTriggers") ? patch.customTriggers : undefined,
    loopOn: has("loop") ? patch.loop?.on : undefined,
    loopLevel: has("loop") ? patch.loop?.level : undefined,
    capOn: has("cap") ? patch.cap?.on : undefined,
    capAmount: has("cap") ? patch.cap?.amount : undefined,
    capPeriod: has("cap") ? patch.cap?.period : undefined,
    budgetExempt: has("budgetExempt") ? patch.budgetExempt : undefined,
  });
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
    updated_at: now,
    updated_by: by.userId,
  };
  const facts = ACTIVITY_FACTS.settings_changed.parse({ changed });
  // Drizzle leaves out `undefined` values, so only the changed columns are written.
  await db.batch([
    db
      .insert(app_spend_settings)
      .values({ ...set, install_id: installId, updated_at: now, updated_by: by.userId })
      .onConflictDoUpdate({ target: app_spend_settings.install_id, set }),
    db.insert(usage_activity).values({
      id: ulid(),
      install_id: installId,
      at: now,
      kind: "settings_changed",
      by: by.userId,
      facts_json: JSON.stringify(facts),
    }),
  ]);
  return readAppSpendSettings(db, installId);
}
