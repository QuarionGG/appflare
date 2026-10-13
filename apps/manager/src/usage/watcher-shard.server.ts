import { z } from "zod";
import { ACCOUNT_PLANS, type AccountPlan } from "../account/plan";
import { known, type Read, read, readTogether } from "../db/batch";
import { createDb, type Database } from "../db/client";
import { SETTING, settingsRead } from "../db/settings";
import { freeLimitWarnings, type LimitWarning } from "./evaluate";
import {
  accountOverage,
  LOOP_LEVEL_NAMES,
  loopCheck,
  monthBill,
  type ObjectAlarms,
  PERIODS,
  periodEnd,
  type ResumeWindow,
  spendInPeriod,
  type Usage,
} from "./math";
import {
  type SnapshotApp,
  type SpendSnapshot,
  snapshotText,
  spendSnapshotSchema,
  stoppedApps,
} from "./overview.server";
import {
  alarmsIn,
  appsIn,
  isRecord,
  need,
  numberIn,
  recordIn,
  resumesIn,
  stringsIn,
} from "./plain-input";
import { openPausesRead } from "./store/pauses.server";
import { usageRead } from "./store/series.server";
import { type UsageState, usageStatesRead } from "./store/usage-state.server";
import { historyBounds, loadHistory, partHistory, usageByInstall } from "./watcher-history.server";
import {
  judge,
  judgeReads,
  message,
  type SpendWatchDeps,
  type SpendWatchEnv,
  type SpendWatchReport,
  SUBREQUEST_BUDGET,
} from "./watcher-judge.server";

/**
 * A check on Workers Free in parts. The Free plan gives each invocation
 * 10 ms of CPU time, and judging an app and working out the numbers its
 * pages show takes about a millisecond of it per app. So a check that has
 * collected and stored the usage (watcher.server.ts) hands its apps, a few at
 * a time ({@link SHARD_APPS}), to the `spendShard` unit over `SELF`: each
 * part runs in an invocation of its own, reads the stored usage of its apps,
 * judges them, does what follows (states, activity, notifications, pauses)
 * and works out their pages' numbers. What concerns the whole account is
 * worked out from usage compacted for sums, by the `spendCheck` unit that
 * runs the parts (watcher-check.server.ts): the free daily limits before the
 * parts (each gets the warnings for its apps), the bill and each app's share
 * of the overage after, for the pages' numbers (`settings.spend_overview`), exactly what
 * `spendSnapshot` gives for all the apps at once.
 *
 * Each part keeps the history of its apps under a KV key of its own (read
 * from D1 only when its apps change, and brought up to date by the hour),
 * so no invocation reads every app's history. Parts are the apps in the
 * order the pages list them, a few at a time, so an install or an uninstall
 * changes only the parts after it.
 *
 * Each part costs the check one subrequest. When there are more parts than
 * the check has subrequests left, it runs as many as fit, starting further
 * along each check so every part gets its turn, and the apps left out keep
 * their last numbers. Workers Paid allows 30 seconds of CPU time, so a
 * check there judges every app itself, as one without `SELF` does on any
 * plan.
 */

/**
 * Apps per part: an app with eight days of usage reported every hour takes
 * about 1 ms of CPU time to judge and to work out its pages' numbers, on
 * top of a part's own 1 to 2 ms (its reads: one D1 batch and one KV read),
 * so a part stays near 5 ms, half the Free plan's allowance (measured on
 * Workers Free, 2026-10-13).
 */
export const SHARD_APPS = 4;

const alarmsSchema = z.array(z.object({ object: z.string(), alarms: z.number() }));
const warningSchema = z.object({
  product: z.string(),
  used: z.number(),
  share: z.number(),
  runsOutAt: z.number().nullable(),
  appShare: z.number(),
});

export const shardInputSchema = z.object({
  now: z.number().int().positive(),
  plan: z.enum(ACCOUNT_PLANS),
  /** The part's place among the check's parts: its history's KV key. */
  part: z.number().int().nonnegative(),
  /** The check wrote hours its history holds: read it afresh from D1. */
  fresh: z.boolean().default(false),
  /** The apps whose pages' numbers the part works out, with their install time (epoch ms). */
  apps: z.array(z.object({ installId: z.string().min(1), installedAt: z.number() })).max(64),
  /** Of those, the ones the check read this time: the part judges these. */
  judge: z.array(z.string()),
  /** Of those, the ones some of whose usage could not be read. */
  incomplete: z.array(z.string()),
  alarms: z.record(z.string(), alarmsSchema),
  /** The account's free daily limit warnings for the part's apps. */
  limitWarnings: z.record(z.string(), warningSchema),
  /** The resume windows of its apps resumed lately (math/resume.ts), as the check worked them out. */
  resumes: z
    .record(z.string(), z.object({ at: z.number(), base: z.record(z.string(), z.number()) }))
    .default({}),
});
export type ShardInput = z.infer<typeof shardInputSchema>;

/**
 * A part's input, as `shardInputSchema.parse` reads it (the same result,
 * unknown keys left out; throws on what the schema refuses), without Zod:
 * the input comes from the check itself over `SELF`, and Zod's first parse
 * in an isolate costs milliseconds of the Workers Free plan's 10 ms of CPU
 * time per part. A test holds the two to the same result.
 */
export function parseShardInput(raw: unknown): ShardInput {
  need(isRecord(raw), "not an object");
  const r = raw as Record<string, unknown>;
  const now = numberIn(r.now, "now");
  need(Number.isInteger(now) && now > 0, "now is not a positive integer");
  need(ACCOUNT_PLANS.includes(r.plan as AccountPlan), "plan is not an account plan");
  const part = numberIn(r.part, "part");
  need(Number.isInteger(part) && part >= 0, "part is not a non-negative integer");
  need(r.fresh === undefined || typeof r.fresh === "boolean", "fresh is not a boolean");
  return {
    now,
    plan: r.plan as AccountPlan,
    part,
    fresh: (r.fresh as boolean | undefined) ?? false,
    apps: appsIn(r.apps, "apps", 64),
    judge: stringsIn(r.judge, "judge"),
    incomplete: stringsIn(r.incomplete, "incomplete"),
    alarms: alarmsIn(r.alarms, "alarms"),
    limitWarnings: recordIn(r.limitWarnings, "limitWarnings", (w, at) => {
      need(isRecord(w), `${at} is not an object`);
      const x = w as Record<string, unknown>;
      need(typeof x.product === "string", `${at}.product is not a string`);
      return {
        product: x.product as string,
        used: numberIn(x.used, `${at}.used`),
        share: numberIn(x.share, `${at}.share`),
        runsOutAt: x.runsOutAt === null ? null : numberIn(x.runsOutAt, `${at}.runsOutAt`),
        appShare: numberIn(x.appShare, `${at}.appShare`),
      };
    }),
    resumes: r.resumes === undefined ? {} : resumesIn(r.resumes, "resumes"),
  };
}

export interface ShardResult {
  alerts: number;
  pauses: number;
  deferred: number;
  /** Subrequests the part made itself. */
  subrequests: number;
  /** The pages' numbers of its apps (their share of the overage is the check's to fill in). */
  apps: SnapshotApp[];
  /** Where its history came from. */
  history: "cache" | "update" | "database";
}

/** One part of a check (the `spendShard` unit). */
export async function runShard(
  env: SpendWatchEnv,
  input: ShardInput,
  deps: SpendWatchDeps = {},
): Promise<ShardResult> {
  const db = createDb(env.DB);
  const ids = input.apps.map((a) => a.installId);
  const judgedIds = input.apps.filter((a) => input.judge.includes(a.installId));
  const hourNow = Math.floor(input.now / 3_600_000) * 3_600;
  // Everything the part reads from D1 in one round trip (db/batch.ts), its
  // history from KV alongside.
  const [history, [recent, states, reads]] = await Promise.all([
    loadHistory(db, env.KV, input.now, partHistory(input.part, ids), { fresh: input.fresh }),
    readTogether(db, [
      usageRead(db, {
        from: historyBounds(input.now).cutoff,
        to: hourNow + 3_600,
        grain: "hour",
        installIds: ids,
      }),
      judgedIds.length > 0
        ? usageStatesRead(
            db,
            judgedIds.map((a) => a.installId),
          )
        : known(new Map<string, UsageState>()),
      judgedIds.length > 0
        ? judgeReads(db, {
            now: input.now,
            plan: input.plan,
            installIds: judgedIds.map((a) => a.installId),
            resumesKnown: true,
          })
        : known(null),
    ] as const),
  ]);
  const usage = usageByInstall(history.series, recent);
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
  let resumes = new Map(Object.entries(input.resumes) as Array<[string, ResumeWindow]>);
  if (judgedIds.length > 0 && reads !== null) {
    ({ resumes } = await judge(
      env,
      db,
      {
        now: input.now,
        plan: input.plan,
        apps: judgedIds,
        usage,
        states,
        alarms: new Map(Object.entries(input.alarms)),
        incomplete: new Set(input.incomplete),
        limitWarnings: new Map(
          Object.entries(input.limitWarnings) as Array<[string, LimitWarning]>,
        ),
        resumes,
      },
      deps,
      SUBREQUEST_BUDGET,
      report,
      reads,
    ));
  }
  return {
    alerts: report.alerts,
    pauses: report.pauses,
    deferred: report.deferred,
    subrequests: report.subrequests,
    apps: input.apps.map((app) =>
      appNumbers(
        input.plan,
        input.now,
        usage.get(app.installId) ?? {},
        app.installedAt,
        app.installId,
        resumes.get(app.installId),
      ),
    ),
    history: history.source,
  };
}

/**
 * An app's pages' numbers as `spendSnapshot` works them out (overview.server.ts),
 * except its share of the overage, which needs the whole account and is the
 * check's to fill in (0 here). A test holds the two to the same numbers.
 */
export function appNumbers(
  plan: AccountPlan,
  now: number,
  usage: Usage,
  installedAt: number,
  installId?: string,
  resume?: ResumeWindow,
): SnapshotApp {
  const since = installedAt > 0 && installedAt < now ? installedAt : undefined;
  const checks = LOOP_LEVEL_NAMES.map((level) =>
    loopCheck({ plan, level, usage, now, since, ...(resume === undefined ? {} : { resume }) }),
  );
  const loop = Object.fromEntries(
    LOOP_LEVEL_NAMES.map((level, i) => {
      const c = checks[i];
      return [
        level,
        { money: c?.money ?? false, abnormal: c?.abnormal ?? false, trips: c?.trips ?? false },
      ];
    }),
  ) as SnapshotApp["loop"];
  const spend = Object.fromEntries(
    PERIODS.map((period) => {
      const s = spendInPeriod(usage, period, now, { since });
      return [period, { spent: s.spent, projected: s.projected, resetsAt: s.resetsAt }];
    }),
  ) as SnapshotApp["spend"];
  return {
    installId: installId ?? "",
    burnPerHour: checks[0]?.burn ?? 0,
    ratio: checks[0]?.ratio ?? null,
    loop,
    spend,
    overageUsd: 0,
  };
}

const QUIET = { money: false, abnormal: false, trips: false };

/** Numbers for an app nothing is known of yet: nothing used. */
function emptyNumbers(installId: string, now: number): SnapshotApp {
  return {
    installId,
    burnPerHour: 0,
    ratio: null,
    loop: { relaxed: QUIET, standard: QUIET, strict: QUIET },
    spend: Object.fromEntries(
      PERIODS.map((p) => [p, { spent: 0, projected: 0, resetsAt: periodEnd(p, now) }]),
    ) as SnapshotApp["spend"],
    overageUsd: 0,
  };
}

export type ShardUnitResult = { ok: true; value: ShardResult } | { ok: false; error: string };

/** The `spendShard` unit over `SELF`, or null on a manager without it. */
export function shardUnit(env: {
  SELF?: unknown;
}): { spendShard(input: unknown): Promise<ShardUnitResult> } | null {
  const self = env.SELF as { spendShard?: unknown } | undefined | null;
  return self !== undefined && self !== null && typeof self.spendShard === "function"
    ? (self as { spendShard(input: unknown): Promise<ShardUnitResult> })
    : null;
}

/**
 * The pages' numbers of the whole account from the parts' numbers of each
 * app: the bill and each app's projected share of the month's overage, from
 * every install's usage compacted for sums, as `spendSnapshot` works them out.
 */
export function mergeSnapshot(input: {
  plan: AccountPlan;
  now: number;
  /** Every install's usage (removed apps included), compacted for sums. */
  sums: ReadonlyMap<string, Usage>;
  apps: readonly SnapshotApp[];
  paused: ReadonlySet<string>;
}): SpendSnapshot {
  const { plan, now } = input;
  const all = Object.fromEntries(input.sums);
  const soFar = accountOverage(all, plan, now);
  const ahead = accountOverage(all, plan, now, {
    projected: true,
    stopped: stoppedApps(input.sums.keys(), input.apps, input.paused),
  });
  return {
    computedAt: now,
    plan,
    bill: { now: monthBill(plan, soFar.usd), projected: monthBill(plan, ahead.usd) },
    apps: input.apps.map((app) => {
      const paused = input.paused.has(app.installId);
      // A paused app burns nothing and spends nothing more (as spendSnapshot has it).
      const spend = paused
        ? (Object.fromEntries(
            Object.entries(app.spend).map(([period, s]) => [period, { ...s, projected: s.spent }]),
          ) as SnapshotApp["spend"])
        : app.spend;
      return {
        ...app,
        burnPerHour: paused ? 0 : app.burnPerHour,
        spend,
        overageUsd: ahead.byApp[app.installId]?.usd ?? 0,
      };
    }),
    stopped: [...input.paused].sort(),
  };
}

/** Which parts run when only `room` of them fit: a window that moves on each check, in turn. */
export function partsToRun(count: number, room: number, now: number): number[] {
  if (room >= count) return Array.from({ length: count }, (_, i) => i);
  if (room <= 0) return [];
  const tick = Math.floor(now / 300_000);
  const first = (tick * room) % count;
  return Array.from({ length: room }, (_, i) => (first + i) % count);
}

/** The stored pages' numbers by app, to keep for the apps a check could not work out. */
function previousNumbers(db: Database): Read<Map<string, SnapshotApp>> {
  const rows = settingsRead(db, [SETTING.spendOverview]);
  return read(rows.queries, (results) => {
    try {
      const raw = rows.decode(results)[SETTING.spendOverview];
      const parsed = raw === undefined ? null : spendSnapshotSchema.safeParse(JSON.parse(raw));
      return new Map((parsed?.success ? parsed.data.apps : []).map((a) => [a.installId, a]));
    } catch {
      return new Map();
    }
  });
}

/**
 * Judges the checked apps and works out every app's pages' numbers in parts
 * over `SELF` (see the module comment), and returns the numbers as the
 * pages read them (`settings.spend_overview`), for the check to store with
 * its status in one statement; null when they could not be worked out. The
 * apps of a part that failed or did not fit this check keep their last
 * numbers and are judged by a later one. Never throws.
 */
export async function checkInShards(
  env: SpendWatchEnv,
  db: Database,
  input: {
    now: number;
    plan: AccountPlan;
    /** Every app (not uninstalled), in the order the pages list them. */
    all: ReadonlyArray<{ installId: string; installedAt: number }>;
    /** The apps read this check. */
    judge: ReadonlySet<string>;
    incomplete: ReadonlySet<string>;
    alarms: ReadonlyMap<string, readonly ObjectAlarms[]>;
    /** Every install's usage compacted for sums (watcher-history.server.ts). */
    sums: ReadonlyMap<string, Usage>;
    /** Apps the check wrote history hours of: their parts read their history afresh. */
    fresh: ReadonlySet<string>;
    /** Subrequests the check may make in all; each part takes one. */
    budget: number;
    /** The apps resumed lately, as the check worked them out (resume.server.ts). */
    resumes?: ReadonlyMap<string, ResumeWindow>;
  },
  report: SpendWatchReport,
): Promise<string | null> {
  const unit = shardUnit(env);
  if (unit === null) throw new Error("the spendShard unit is not available");
  const warnings =
    input.plan === "free"
      ? freeLimitWarnings(input.sums, input.judge, input.now)
      : new Map<string, LimitWarning>();
  const parts: Array<Array<{ installId: string; installedAt: number }>> = [];
  for (let i = 0; i < input.all.length; i += SHARD_APPS) {
    parts.push(input.all.slice(i, i + SHARD_APPS));
  }
  const run = partsToRun(parts.length, input.budget - report.subrequests, input.now);
  if (run.length < parts.length) {
    console.warn(
      `spend watcher: ${parts.length - run.length} of ${parts.length} part(s) left for the next check (subrequests)`,
    );
  }
  report.subrequests += run.length;
  const results = await Promise.all(
    run.map(async (index): Promise<ShardUnitResult> => {
      const apps = parts[index] ?? [];
      const ids = apps.map((a) => a.installId);
      const pick = <T>(map: ReadonlyMap<string, T>) =>
        Object.fromEntries(ids.flatMap((id) => (map.has(id) ? [[id, map.get(id) as T]] : [])));
      const shard: ShardInput = {
        now: input.now,
        plan: input.plan,
        part: index,
        fresh: ids.some((id) => input.fresh.has(id)),
        apps: apps.map((a) => ({ installId: a.installId, installedAt: a.installedAt })),
        judge: ids.filter((id) => input.judge.has(id)),
        incomplete: ids.filter((id) => input.incomplete.has(id)),
        alarms: pick(input.alarms) as Record<string, ObjectAlarms[]>,
        limitWarnings: pick(warnings),
        resumes: pick(input.resumes ?? new Map()),
      };
      try {
        return await unit.spendShard(shard);
      } catch (error) {
        return { ok: false, error: message(error) };
      }
    }),
  );
  const worked = new Map<string, SnapshotApp>();
  let failed = 0;
  for (const result of results) {
    if (!result.ok) {
      failed += 1;
      console.error("spend watcher: a part of the check failed", { error: result.error });
      continue;
    }
    report.alerts += result.value.alerts;
    report.pauses += result.value.pauses;
    report.deferred += result.value.deferred;
    for (const app of result.value.apps) worked.set(app.installId, app);
  }
  report.parts = { count: parts.length, ran: run.length, failed };
  try {
    // One round trip: the open pauses (some may have started in a part just
    // now) and, when some apps were not worked out, their last numbers.
    const [pauses, before] = await readTogether(db, [
      openPausesRead(db),
      worked.size < input.all.length ? previousNumbers(db) : known(new Map<string, SnapshotApp>()),
    ] as const);
    const paused = new Set(pauses.map((p) => p.installId));
    const snapshot = mergeSnapshot({
      plan: input.plan,
      now: input.now,
      sums: input.sums,
      apps: input.all.map(
        (a) =>
          worked.get(a.installId) ??
          before.get(a.installId) ??
          emptyNumbers(a.installId, input.now),
      ),
      paused,
    });
    return snapshotText(snapshot);
  } catch (error) {
    console.error("spend watcher: overview not stored", { error: message(error) });
    return null;
  }
}
