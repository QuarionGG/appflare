import type { CloudflareClient } from "@appflare/cf-api";
import { z } from "zod";
import { type CfClientEnv, getCfClient } from "../../cloudflare/client.server";
import { createDb, type Database } from "../../db/client";
import { readSettings, SETTING, writeSettings } from "../../db/settings";

/**
 * The manager's own cron schedule. Cron triggers belong to the Worker, not
 * to a version, so a self-update that deploys a new version keeps the old
 * schedule. Each version therefore sets its own: the scheduled run (which
 * runs at minute 0 and 30 on any schedule an earlier version had) compares
 * the Worker's schedule with {@link MANAGER_CRONS} once per running version
 * and replaces it when it differs ({@link ensureOwnSchedule}).
 *
 * Each version's schedule is remembered in `settings.manager_crons`
 * (`{ "<version>": ["<cron>", ...] }`), so rolling back to an earlier
 * version can set the schedule that version ran with.
 */

/**
 * This build's cron schedule: the `triggers.crons` of apps/manager/wrangler.jsonc
 * (a test checks they match). One cron: the Workers Free plan allows three
 * per account.
 */
export const MANAGER_CRONS: readonly string[] = Object.freeze(["*/5 * * * *"]);

/** The schedule every version ran with before versions set their own. */
export const LEGACY_MANAGER_CRONS: readonly string[] = Object.freeze(["*/30 * * * *"]);

type SchedulesApi = { workers: Pick<CloudflareClient["workers"], "getSchedules" | "putSchedules"> };

const managerCronsSchema = z.record(z.string(), z.array(z.string()));
export type ManagerCrons = z.infer<typeof managerCronsSchema>;

/** Whether two schedules hold the same crons, in any order. */
export function sameCrons(a: readonly string[], b: readonly string[]): boolean {
  const left = [...new Set(a)].sort();
  const right = [...new Set(b)].sort();
  return left.length === right.length && left.every((cron, i) => cron === right[i]);
}

function parseManagerCrons(raw: string | undefined): ManagerCrons {
  if (raw === undefined) return {};
  try {
    return managerCronsSchema.safeParse(JSON.parse(raw)).data ?? {};
  } catch {
    return {};
  }
}

export async function readManagerCrons(db: Database): Promise<ManagerCrons> {
  return parseManagerCrons((await readSettings(db, [SETTING.managerCrons]))[SETTING.managerCrons]);
}

/**
 * The schedule a version ran with. A version that never recorded its own
 * and is older than every version that did (and than the running one) ran
 * before versions set their own schedule: {@link LEGACY_MANAGER_CRONS}.
 * Null for any other version not recorded.
 */
export function cronsOfVersion(
  known: ManagerCrons,
  version: string,
  running: string,
): readonly string[] | null {
  const own = known[version];
  if (own !== undefined) return own;
  const recorded = [...Object.keys(known), running];
  return recorded.every((v) => compareVersions(version, v) < 0) ? LEGACY_MANAGER_CRONS : null;
}

/** Compares `x.y.z` versions (pre-release suffixes ignored). */
export function compareVersions(a: string, b: string): number {
  const parts = (v: string) =>
    v
      .split(/[-+]/)[0]
      ?.split(".")
      .map((n) => Number(n) || 0) ?? [];
  const x = parts(a);
  const y = parts(b);
  for (let i = 0; i < Math.max(x.length, y.length); i++) {
    const d = (x[i] ?? 0) - (y[i] ?? 0);
    if (d !== 0) return d;
  }
  return 0;
}

export type ScheduleChange =
  | { status: "unchanged"; crons: string[] }
  | { status: "changed"; from: string[]; to: string[] };

/**
 * Sets the Worker's schedule to `crons` unless it already is that; reads it
 * first, so doing it again changes nothing.
 */
export async function applyManagerCrons(
  api: SchedulesApi,
  workerName: string,
  crons: readonly string[],
): Promise<ScheduleChange> {
  const current = (await api.workers.getSchedules(workerName)).schedules.map((s) => s.cron);
  if (sameCrons(current, crons)) return { status: "unchanged", crons: current };
  await api.workers.putSchedules(
    workerName,
    crons.map((cron) => ({ cron })),
  );
  return { status: "changed", from: current, to: [...crons] };
}

export type OwnScheduleOutcome =
  /** This version checked its schedule already. */
  | { status: "done" }
  /** Not set up yet (no Worker name or connection): tried again next run. */
  | { status: "skipped" }
  | { status: "checked"; change: ScheduleChange }
  /** Tried again on the next run. */
  | { status: "failed"; error: string };

/**
 * Once per deployed Worker version: the Worker's schedule set to this
 * build's ({@link MANAGER_CRONS}) when it differs, and the release's
 * schedule remembered. Recorded as done (`settings.manager_schedule_version`,
 * the Workers version id, or the release when the binding is missing) only
 * once it worked, so a failure is tried again by the next run. A rollback
 * clears the mark, so going back to a release that ran before checks again.
 * Never throws.
 */
export async function ensureOwnSchedule(
  env: CfClientEnv & {
    DB: D1Database;
    APPFLARE_VERSION?: string;
    CF_VERSION_METADATA?: { id?: string };
  },
  deps: { api?: SchedulesApi; now?: () => number } = {},
): Promise<OwnScheduleOutcome> {
  const version = env.APPFLARE_VERSION;
  if (version === undefined || version === "") return { status: "skipped" };
  const db = createDb(env.DB);
  try {
    const settings = await readSettings(db, [
      SETTING.managerScheduleVersion,
      SETTING.workerName,
      SETTING.managerCrons,
    ]);
    const deployed = env.CF_VERSION_METADATA?.id || version;
    if (settings.manager_schedule_version === deployed) return { status: "done" };
    const workerName = settings.worker_name;
    if (workerName === undefined || workerName === "") return { status: "skipped" };
    const api = deps.api ?? (await getCfClient(env));
    const change = await applyManagerCrons(api, workerName, MANAGER_CRONS);
    const known = parseManagerCrons(settings.manager_crons);
    await writeSettings(
      db,
      {
        [SETTING.managerCrons]: JSON.stringify({ ...known, [version]: [...MANAGER_CRONS] }),
        [SETTING.managerScheduleVersion]: deployed,
      },
      new Date((deps.now ?? Date.now)()),
    );
    return { status: "checked", change };
  } catch (error) {
    return { status: "failed", error: error instanceof Error ? error.message : String(error) };
  }
}

/** The log line of {@link ensureOwnSchedule}'s outcome, or null when there is nothing to say. */
export function ownScheduleLog(outcome: OwnScheduleOutcome): string | null {
  switch (outcome.status) {
    case "done":
    case "skipped":
      return null;
    case "checked":
      return outcome.change.status === "changed"
        ? `cron triggers set to ${outcome.change.to.join(", ")} (were ${outcome.change.from.join(", ") || "none"})`
        : null;
    case "failed":
      return `cron triggers not checked: ${outcome.error}`;
  }
}
