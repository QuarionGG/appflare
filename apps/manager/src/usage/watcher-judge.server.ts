import type { FetchLike } from "@appflare/cf-api";
import type { AccountPlan } from "../account/plan";
import { readAccountPlan } from "../account/plan.server";
import type { CfClientEnv } from "../cloudflare/client.server";
import type { Database } from "../db/client";
import { SETTING, writeSettings } from "../db/settings";
import type { JobWorkflows } from "../jobs/create-job.server";
import type { WorkflowLookup } from "../jobs/reconcile.server";
import { emitUsageEvent, type UsageEvent } from "../notifications/usage-events.server";
import {
  type ActivityDraft,
  evaluate,
  type LimitWarning,
  PAUSE_RETRY_MS,
  type PauseDraft,
} from "./evaluate";
import { DAY_MS, HOUR_MS, periodStart, type ResumeWindow, type Usage } from "./math";
import { spendSnapshot, spendSnapshotSchema } from "./overview.server";
import { PauseActionError, startPause } from "./pause.server";
import { resumeWindows } from "./resume.server";
import { countActivity, listActivity, recordActivity } from "./store/activity.server";
import { listAlertRules, recordAlertFiring } from "./store/alert-rules.server";
import { effectiveSpendSettingsOf } from "./store/app-settings.server";
import { readSpendDefaults } from "./store/defaults.server";
import { listOpenPauses } from "./store/pauses.server";
import { readUsage } from "./store/series.server";
import {
  type readUsageStates,
  updateUsageState,
  writeUsageStates,
} from "./store/usage-state.server";
import { ALL_HISTORY, loadHistory, usageByInstall } from "./watcher-history.server";
import type { SpendWatchStatus } from "./watcher-status";

/**
 * The spend watcher's judging of apps and what follows from it (the
 * actions, and the numbers the pages show), shared by a whole check
 * (watcher.server.ts) and by the parts a check on Workers Free splits its
 * apps into (watcher-shard.server.ts).
 */

const HOUR = 3_600;

export const message = (error: unknown) => (error instanceof Error ? error.message : String(error));

/**
 * Subrequests a check may make (the Workers Free plan allows 50 per
 * invocation; the watcher runs as a `SELF` unit with its own). Cloudflare
 * API requests, sends over `SELF` and pause starts count; D1 and KV are
 * within the separate allowance for Cloudflare's own services.
 */
export const SUBREQUEST_BUDGET = 45;
/** What starting a pause may cost: the job's Workflow, and a look at a running self-update. */
export const PAUSE_COST = 2;

export interface SpendWatchEnv extends CfClientEnv {
  DB: D1Database;
  KV?: KVNamespace;
  /** The manager's own service binding, to send notifications at once. */
  SELF?: unknown;
  /** The job Workflow binding, to start pause jobs. */
  JOBS: JobWorkflows & Partial<WorkflowLookup>;
}

export interface SpendWatchDeps {
  now?: () => number;
  /** The Cloudflare API's fetch (tests); the Worker's own by default. */
  fetch?: FetchLike;
  /** Starts a pause job ({@link startPause} by default). */
  startPause?: typeof startPause;
  /** Records and sends a notification ({@link emitUsageEvent} by default). */
  emit?: typeof emitUsageEvent;
  /** Subrequests this check may make; {@link SUBREQUEST_BUDGET} by default. */
  budget?: number;
}

export interface SpendWatchReport {
  status: SpendWatchStatus["state"] | "idle";
  /** Apps checked, and apps too new to read yet. */
  apps: number;
  newApps: number;
  /** Hourly rows written (changed hours). */
  rowsWritten: number;
  /** Alert-like news: unusual usage, usage alerts, free limits, the budget. */
  alerts: number;
  /** Pause jobs started. */
  pauses: number;
  /** Pauses or sends left for the next check (subrequests ran out, or the app was busy). */
  deferred: number;
  /** Subrequests made. */
  subrequests: number;
  /** Where the usage history came from this check. */
  history: "cache" | "update" | "database" | null;
  /** Rows pruned on a half-hour check. */
  pruned: number | null;
  /** The reads that failed this check (their apps keep their last values). */
  failedReads?: string[];
  /** Workers Free: the parts of the check, how many ran (the subrequests allowing), and how many failed. */
  parts?: { count: number; ran: number; failed: number };
  error?: string;
}

export interface Judged {
  now: number;
  plan: Awaited<ReturnType<typeof readAccountPlan>>;
  apps: ReadonlyArray<{ installId: string; installedAt: number }>;
  usage: ReadonlyMap<string, Usage>;
  states: Awaited<ReturnType<typeof readUsageStates>>;
  alarms: ReadonlyMap<string, Array<{ object: string; alarms: number }>>;
  /** Apps some of whose usage could not be read this check. */
  incomplete: ReadonlySet<string>;
  /** The account's free daily limit warnings, when worked out for the whole account already. */
  limitWarnings?: ReadonlyMap<string, LimitWarning>;
  /** Every install not removed, when `usage` holds removed ones too (the budget's projection). */
  installed?: ReadonlySet<string>;
  /**
   * The resume windows, when the check worked them out already (from the
   * rows as stored before it wrote any); read here otherwise.
   */
  resumes?: ReadonlyMap<string, ResumeWindow>;
}

/**
 * Stores the numbers spend protection's pages show (`settings.spend_overview`,
 * overview.server.ts), last in every check. They are what
 * `writeSpendOverviewSnapshot` stores, computed by the same function
 * (`spendSnapshot`) from the same usage: this check's own when it collected
 * one, else the cached history and the recent hours, so a check never reads
 * the eight days of hourly rows again. Never fails the check.
 */
export async function writeOverview(
  env: SpendWatchEnv,
  db: Database,
  input: {
    now: number;
    all: ReadonlyArray<{ installId: string; installedAt: number }>;
    plan?: AccountPlan;
    usage?: ReadonlyMap<string, Usage>;
    paused?: ReadonlySet<string>;
    resumes?: ReadonlyMap<string, ResumeWindow>;
  },
): Promise<void> {
  const { now } = input;
  try {
    const [plan, usage, paused] = await Promise.all([
      input.plan ?? readAccountPlan(db),
      input.usage ?? storedUsage(db, env.KV, now),
      input.paused ?? listOpenPauses(db).then((p) => new Set(p.map((x) => x.installId))),
    ]);
    const snapshot = spendSnapshot({
      plan,
      now,
      usage,
      installs: input.all.map((a) => ({ installId: a.installId, installedAt: a.installedAt })),
      paused,
      ...(input.resumes === undefined ? {} : { resumes: input.resumes }),
    });
    await writeSettings(
      db,
      { [SETTING.spendOverview]: JSON.stringify(spendSnapshotSchema.parse(snapshot)) },
      new Date(now),
    );
  } catch (error) {
    console.error("spend watcher: overview not stored", { error: message(error) });
  }
}

/** Every install's stored usage: the history and the recent hours. */
export async function storedUsage(
  db: Database,
  kv: KVNamespace | undefined,
  now: number,
): Promise<Map<string, Usage>> {
  const history = await loadHistory(db, kv, now, ALL_HISTORY);
  const hourNow = Math.floor(now / HOUR_MS) * (HOUR_MS / 1000);
  const recent = await readUsage(db, {
    from: history.bounds.cutoff,
    to: hourNow + HOUR,
    grain: "hour",
  });
  return usageByInstall(history.series, recent);
}

/** What {@link judge} leaves for the pages' numbers. */
export interface JudgeResult {
  /** The apps paused before this check, and the ones it started pausing. */
  paused: Set<string>;
  /** The apps resumed lately, judged on what they did after (resume.server.ts). */
  resumes: Map<string, ResumeWindow>;
}

/**
 * Judges every app (evaluate.ts) and does what it decided, within the
 * subrequest budget.
 */
export async function judge(
  env: SpendWatchEnv,
  db: Database,
  input: Judged,
  deps: SpendWatchDeps,
  budget: number,
  report: SpendWatchReport,
): Promise<JudgeResult> {
  const { now, plan } = input;
  const ids = input.apps.map((a) => a.installId);
  const today = new Date(Math.floor(now / DAY_MS) * DAY_MS);
  const monthStart = new Date(periodStart("month", now));
  const [settings, defaults, rules, pauses, resumes] = await Promise.all([
    effectiveSpendSettingsOf(db, ids),
    readSpendDefaults(db),
    listAlertRules(db),
    listOpenPauses(db),
    input.resumes !== undefined
      ? Promise.resolve(new Map(input.resumes))
      : resumeWindows(db, env.KV, { now, installIds: ids, usage: input.usage, keep: true }),
  ]);
  const budgetOn = plan === "paid" && defaults.budget.on ? defaults.budget.amount : null;
  const [limitEntries, budgetTold, failedPauses] = await Promise.all([
    plan === "free"
      ? listActivity(db, { since: today, kinds: ["limit_near"], limit: 200 })
      : Promise.resolve([]),
    budgetOn === null
      ? Promise.resolve(0)
      : countActivity(db, { installId: null, kinds: ["budget_reached"], since: monthStart }),
    listActivity(db, {
      since: new Date(now - PAUSE_RETRY_MS),
      kinds: ["pause_failed"],
      limit: 200,
    }),
  ]);
  const pauseFailed = new Set(
    failedPauses.flatMap((a) => (a.installId === null ? [] : [a.installId])),
  );
  const limitSharesToday = new Map<string, number>();
  for (const entry of limitEntries) {
    // Newest first: the first entry of each install is its latest.
    if (entry.kind !== "limit_near" || entry.installId === null) continue;
    if (!limitSharesToday.has(entry.installId))
      limitSharesToday.set(entry.installId, entry.facts.share);
  }
  const paused = new Set(pauses.map((p) => p.installId));
  const decisions = evaluate({
    now,
    plan,
    apps: input.apps.map((a) => {
      const state = input.states.get(a.installId);
      const effective = settings.get(a.installId);
      if (state === undefined || effective === undefined) {
        throw new Error(`No state or settings for ${a.installId}`);
      }
      return {
        installId: a.installId,
        installedAt: a.installedAt,
        usage: input.usage.get(a.installId) ?? {},
        settings: effective,
        state,
        paused: paused.has(a.installId),
        pauseFailedRecently: pauseFailed.has(a.installId),
        incomplete: input.incomplete.has(a.installId),
        objectAlarms: input.alarms.get(a.installId) ?? [],
        rules: rules.filter((r) => r.installId === a.installId),
        resume: resumes.get(a.installId) ?? null,
      };
    }),
    accountUsage: input.usage,
    budget: budgetOn,
    budgetToldThisMonth: budgetTold > 0,
    limitSharesToday,
    ...(input.limitWarnings === undefined ? {} : { limitWarnings: input.limitWarnings }),
    ...(input.installed === undefined ? {} : { installed: input.installed }),
  });

  // Checked now: the apps whose usage was all read. The others keep their
  // last check's time, so the next check reads again what this one missed.
  await writeUsageStates(
    db,
    decisions.states.filter((s) => !input.incomplete.has(s.installId)),
    new Date(now),
  );
  for (const state of decisions.states) {
    if (!input.incomplete.has(state.installId)) continue;
    const { installId, ...patch } = state;
    await updateUsageState(db, installId, patch);
  }

  const at = new Date(now);
  const emit = deps.emit ?? emitUsageEvent;
  const record = async (draft: ActivityDraft) => {
    try {
      await recordActivity(db, { ...draft, at });
    } catch (error) {
      console.error("spend watcher: activity not recorded", {
        kind: draft.kind,
        error: message(error),
      });
    }
  };
  const send = async (event: UsageEvent) => {
    report.alerts += 1;
    // Sending at once costs a subrequest; without one to spare the event
    // waits in the outbox for the scheduled run.
    const atOnce = report.subrequests + 1 <= budget;
    if (atOnce) report.subrequests += 1;
    else report.deferred += 1;
    await emit(atOnce ? { DB: env.DB, SELF: env.SELF } : { DB: env.DB }, event, { now: () => now });
  };

  const start = deps.startPause ?? startPause;
  const pause = async (draft: PauseDraft): Promise<boolean> => {
    if (report.subrequests + PAUSE_COST > budget) {
      report.deferred += 1;
      return false;
    }
    report.subrequests += PAUSE_COST;
    try {
      await start({ DB: env.DB, JOBS: env.JOBS }, {
        installId: draft.installId,
        reason: draft.reason,
        detail: draft.detail,
        by: null,
      } as Parameters<typeof startPause>[1]);
      report.pauses += 1;
      // Stopped from now on: the numbers this check stores project nothing more for it.
      paused.add(draft.installId);
      return true;
    } catch (error) {
      // Already being paused, another job of it is running, or not installed:
      // the next check judges it again.
      report.deferred += 1;
      const level = error instanceof PauseActionError ? "warn" : "error";
      console[level](`spend watcher: could not pause ${draft.installId} (${draft.reason})`, {
        error: message(error),
      });
      return false;
    }
  };
  // Pauses first, so notifications never use up the subrequests a pause needs.
  for (const draft of decisions.pauses) await pause(draft);
  // The budget's pick only: when it is busy, the next check decides again.
  if (decisions.budgetPause !== null) await pause(decisions.budgetPause);

  for (const draft of decisions.activities) await record(draft);
  for (const event of decisions.events) await send(event);
  for (const firing of decisions.firings) {
    const first = await recordAlertFiring(db, {
      ruleId: firing.ruleId,
      periodStart: firing.periodStart,
      value: firing.value,
      firedAt: at,
    });
    if (!first) continue;
    await record(firing.activity);
    await send(firing.event);
  }
  return { paused, resumes };
}
