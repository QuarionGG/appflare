import type { Database } from "../../db/client";
import { readSettings, SETTING, writeSettings } from "../../db/settings";
import {
  DEFAULT_SPEND_DEFAULTS,
  type SpendDefaults,
  type SpendDefaultsPatch,
  spendDefaultsPatchSchema,
  spendDefaultsSchema,
} from "./spend-settings";

/**
 * The account's spend protection defaults, one `settings` row each (so
 * changing one never rewrites another). A missing or unreadable row reads
 * as the default.
 */

const KEYS = [
  SETTING.spendAutoPause,
  SETTING.spendLoop,
  SETTING.spendCap,
  SETTING.spendBudget,
  SETTING.spendUnusualFactor,
] as const;

function parsed<T>(
  raw: string | undefined,
  read: (value: unknown) => T | undefined,
): T | undefined {
  if (raw === undefined) return undefined;
  try {
    return read(JSON.parse(raw));
  } catch {
    return undefined;
  }
}

const shape = spendDefaultsSchema.shape;

export async function readSpendDefaults(db: Database): Promise<SpendDefaults> {
  const rows = await readSettings(db, KEYS);
  const d = DEFAULT_SPEND_DEFAULTS;
  const auto = rows[SETTING.spendAutoPause];
  return {
    autoPause: auto === "on" ? true : auto === "off" ? false : d.autoPause,
    loop: parsed(rows[SETTING.spendLoop], (v) => shape.loop.safeParse(v).data) ?? { ...d.loop },
    cap: parsed(rows[SETTING.spendCap], (v) => shape.cap.safeParse(v).data) ?? { ...d.cap },
    budget: parsed(rows[SETTING.spendBudget], (v) => shape.budget.safeParse(v).data) ?? {
      ...d.budget,
    },
    unusualFactor:
      parsed(rows[SETTING.spendUnusualFactor], (v) => shape.unusualFactor.safeParse(v).data) ??
      d.unusualFactor,
  };
}

/** Writes the given defaults (validated; throws a ZodError on a bad value) and returns them all. */
export async function writeSpendDefaults(
  db: Database,
  patch: SpendDefaultsPatch,
  now: Date = new Date(),
): Promise<SpendDefaults> {
  const p = spendDefaultsPatchSchema.parse(patch);
  await writeSettings(
    db,
    {
      [SETTING.spendAutoPause]: p.autoPause === undefined ? undefined : p.autoPause ? "on" : "off",
      [SETTING.spendLoop]: p.loop && JSON.stringify(p.loop),
      [SETTING.spendCap]: p.cap && JSON.stringify(p.cap),
      [SETTING.spendBudget]: p.budget && JSON.stringify(p.budget),
      [SETTING.spendUnusualFactor]:
        p.unusualFactor === undefined ? undefined : String(p.unusualFactor),
    },
    now,
  );
  return readSpendDefaults(db);
}
