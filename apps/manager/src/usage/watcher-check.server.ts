import { z } from "zod";
import { ACCOUNT_PLANS, type AccountPlan } from "../account/plan";
import { createDb } from "../db/client";
import type { ResumeWindow } from "./math";
import { alarmsIn, appsIn, isRecord, need, numberIn, resumesIn, stringsIn } from "./plain-input";
import { readUsage } from "./store/series.server";
import {
  historyBounds,
  loadHistory,
  SUMS_HISTORY,
  type UsageHistory,
  usageByInstall,
} from "./watcher-history.server";
import type { SpendWatchDeps, SpendWatchEnv, SpendWatchReport } from "./watcher-judge.server";
import { checkInShards } from "./watcher-shard.server";

/**
 * The second half of a check on Workers Free, as a unit of its own (the
 * `spendCheck` unit over `SELF`), so the check's CPU time is split between
 * two invocations: the check itself reads the analytics and stores the
 * hours (watcher.server.ts), then hands the rest here: the account's sums
 * (the history kept for them, and the recent hours as now stored), the free
 * daily limits, the parts that judge the apps (watcher-shard.server.ts) and
 * the pages' numbers, which it hands back for the check to store with its
 * status. Without the unit (a `SELF` that does not serve it) the check does
 * this in place.
 */

const appSchema = z.object({ installId: z.string().min(1), installedAt: z.number() });

export const checkInputSchema = z.object({
  now: z.number().int().positive(),
  plan: z.enum(ACCOUNT_PLANS),
  /** Every app (not uninstalled), in the order the pages list them. */
  all: z.array(appSchema),
  /** The apps the check read: the parts judge these. */
  judge: z.array(z.string()),
  /** Of those, the ones some of whose usage could not be read. */
  incomplete: z.array(z.string()),
  alarms: z.record(z.string(), z.array(z.object({ object: z.string(), alarms: z.number() }))),
  /** Apps the check wrote history hours of: their histories are read afresh. */
  fresh: z.array(z.string()),
  /** Subrequests the parts may take. */
  budget: z.number(),
  /** The apps resumed lately, as the check worked them out (resume.server.ts). */
  resumes: z.record(
    z.string(),
    z.object({ at: z.number(), base: z.record(z.string(), z.number()) }),
  ),
});
export type CheckInput = z.infer<typeof checkInputSchema>;

/**
 * The input as `checkInputSchema.parse` reads it (throws on what the schema
 * refuses), without Zod (plain-input.ts). A test holds the two together.
 */
export function parseCheckInput(raw: unknown): CheckInput {
  need(isRecord(raw), "not an object");
  const r = raw as Record<string, unknown>;
  const now = numberIn(r.now, "now");
  need(Number.isInteger(now) && now > 0, "now is not a positive integer");
  need(ACCOUNT_PLANS.includes(r.plan as AccountPlan), "plan is not an account plan");
  return {
    now,
    plan: r.plan as AccountPlan,
    all: appsIn(r.all, "all", Number.POSITIVE_INFINITY),
    judge: stringsIn(r.judge, "judge"),
    incomplete: stringsIn(r.incomplete, "incomplete"),
    alarms: alarmsIn(r.alarms, "alarms"),
    fresh: stringsIn(r.fresh, "fresh"),
    budget: numberIn(r.budget, "budget"),
    resumes: resumesIn(r.resumes, "resumes"),
  };
}

export interface CheckResult {
  /** The pages' numbers as `settings.spend_overview` stores them; null when not worked out. */
  overview: string | null;
  /** Where the account's sums history came from. */
  history: UsageHistory["source"];
  alerts: number;
  pauses: number;
  deferred: number;
  /** Subrequests the unit made (the parts). */
  subrequests: number;
  parts?: SpendWatchReport["parts"];
}

export type CheckUnitResult = { ok: true; value: CheckResult } | { ok: false; error: string };

/** The second half of a check; see the module comment. Never throws for a part that fails. */
export async function runCheck(
  env: SpendWatchEnv,
  input: CheckInput,
  _deps: SpendWatchDeps = {},
): Promise<CheckResult> {
  const db = createDb(env.DB);
  const hourNow = Math.floor(input.now / 3_600_000) * 3_600;
  const fresh = new Set(input.fresh);
  // The recent hours as the check stored them, next to the history it kept.
  const [history, recent] = await Promise.all([
    loadHistory(db, env.KV, input.now, SUMS_HISTORY, { fresh }),
    readUsage(db, { from: historyBounds(input.now).cutoff, to: hourNow + 3_600, grain: "hour" }),
  ]);
  const report: SpendWatchReport = {
    status: "watching",
    apps: input.judge.length,
    newApps: 0,
    rowsWritten: 0,
    alerts: 0,
    pauses: 0,
    deferred: 0,
    subrequests: 0,
    history: history.source,
    pruned: null,
  };
  const overview = await checkInShards(
    env,
    db,
    {
      now: input.now,
      plan: input.plan,
      all: input.all,
      judge: new Set(input.judge),
      incomplete: new Set(input.incomplete),
      alarms: new Map(Object.entries(input.alarms)),
      sums: usageByInstall(history.series, recent),
      fresh,
      budget: input.budget,
      resumes: new Map(Object.entries(input.resumes) as Array<[string, ResumeWindow]>),
    },
    report,
  );
  return {
    overview,
    history: history.source,
    alerts: report.alerts,
    pauses: report.pauses,
    deferred: report.deferred,
    subrequests: report.subrequests,
    ...(report.parts === undefined ? {} : { parts: report.parts }),
  };
}

/** The `spendCheck` unit over `SELF`, or null when `SELF` does not serve it. */
export function checkUnit(env: {
  SELF?: unknown;
}): { spendCheck(input: unknown): Promise<CheckUnitResult> } | null {
  const self = env.SELF as { spendCheck?: unknown } | undefined | null;
  return self !== undefined && self !== null && typeof self.spendCheck === "function"
    ? (self as { spendCheck(input: unknown): Promise<CheckUnitResult> })
    : null;
}
