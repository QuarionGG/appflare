import {
  CloudflareApiError,
  type CloudflareClient,
  CloudflareGraphQLError,
  missingSpendProtectionScopes,
} from "@appflare/cf-api";
import { readAccountPlan } from "../account/plan.server";
import { getCfClient } from "../cloudflare/client.server";
import { readGrant } from "../cloudflare/grant-store.server";
import { createDb, type Database } from "../db/client";
import {
  type CollectSource,
  type CollectTarget,
  collectUsage,
  HOUR,
  LEVEL_PRODUCTS,
} from "./collect";
import { addAccountResources, changedHours, readWatchedApps, storedIndex } from "./collect.server";
import { DAY_MS, HOUR_MS, type ProductKey, type Usage } from "./math";
import { pruneActivity } from "./store/activity.server";
import { pruneAlertFirings } from "./store/alert-rules.server";
import {
  type HourlyUsage,
  pruneUsage,
  readUsage,
  recordHourlyUsage,
  type UsageRow,
} from "./store/series.server";
import { readUsageStates } from "./store/usage-state.server";
import {
  ALL_HISTORY,
  historyBounds,
  loadHistory,
  SUMS_HISTORY,
  usageByInstall,
} from "./watcher-history.server";
import {
  judge,
  message,
  type SpendWatchDeps,
  type SpendWatchEnv,
  type SpendWatchReport,
  SUBREQUEST_BUDGET,
  writeOverview,
} from "./watcher-judge.server";
import { checkInShards, shardUnit } from "./watcher-shard.server";
import { type SpendWatchStatus, writeSpendWatchStatus } from "./watcher-status";

export type { SpendWatchDeps, SpendWatchEnv, SpendWatchReport } from "./watcher-judge.server";
export { SUBREQUEST_BUDGET } from "./watcher-judge.server";

/**
 * The spend watcher: every five minutes, what each installed app used, kept
 * in Appflare's own hourly snapshots, then judged by the spend protection
 * rules (evaluate.ts), which alert, record what happened, and pause apps.
 *
 * One check, in order:
 * 1. Without the analytics permission (an OAuth grant from before it was
 *    asked for, or an API token without "Account Analytics"), nothing else
 *    happens: the status says so and pages show "Reconnect to see usage".
 * 2. Apps installed less than 15 minutes ago are left for later: the
 *    analytics show a brand-new Durable Object namespace only after about
 *    13 minutes, so an early read would store hours that look like nothing
 *    happened. Their first check reads from their install on.
 * 3. Collect (collect.ts): each dataset once for all apps, for the hours
 *    that can still change (the last three) and any missed since the app's
 *    last check (up to eight days back for an app never checked, enough
 *    for its normal hour). Only hours whose value changed are written:
 *    each write rolls the touched days up again, and rows read count on
 *    the Workers Free plan.
 * 4. Judge every app and act: states, activity, notifications (sent at once
 *    over `SELF` while this invocation has subrequests to spare, else by
 *    the scheduled run), alert firings, pauses.
 *    On Workers Free (10 ms of CPU time per run) this happens in parts of
 *    a few apps, each an invocation of its own (watcher-shard.server.ts).
 *
 * On the half-hour checks it also prunes the usage history, activity and
 * alert firings past their retention (each delete reads through an index on
 * time, so only the rows it deletes).
 *
 * A check never throws: what failed is in the report and the status.
 */

/** An app this young is not read yet (the analytics' blind spot for new apps). */
export const NEW_APP_MS = 15 * 60_000;
/** Hours read again on every check: the analytics may still change them. */
export const RECENT_HOURS = 3;
/** The furthest back a check reads (an app never checked, or a long gap). */
export const MAX_BACKFILL_DAYS = 8;
/**
 * Whether Cloudflare refused a read for lack of permission, by what it
 * says in codes: the GraphQL API's `authz` extension code, or the REST
 * envelope's 401/403 status and authentication codes (9106 missing or bad
 * credentials, 9109 unauthorized, 10000 authentication error).
 */
export function isAccessRefusal(error: unknown): boolean {
  if (error instanceof CloudflareGraphQLError) return error.codes.includes("authz");
  if (error instanceof CloudflareApiError) {
    return (
      error.status === 401 ||
      error.status === 403 ||
      error.errors.some((e) => e.code === 9106 || e.code === 9109 || e.code === 10000)
    );
  }
  return false;
}

/**
 * The recent hours a check lays over the history: those from the
 * history's cut-off on, with what the check wrote in place of what was
 * stored, oldest first. Earlier hours are in the history already (it is
 * read afresh when the check wrote any of them), compacted into days where
 * the math needs no hours: laying them over it again would count them twice.
 */
export function recentRows(
  stored: readonly UsageRow[],
  written: readonly HourlyUsage[],
  cutoff: number,
): UsageRow[] {
  const rows = new Map<string, UsageRow>();
  const key = (r: { installId: string; product: string }, t: number) =>
    `${r.installId}\u0000${r.product}\u0000${t}`;
  for (const row of stored) if (row.t >= cutoff) rows.set(key(row, row.t), row);
  for (const c of written) {
    if (c.hour >= cutoff)
      rows.set(key(c, c.hour), {
        installId: c.installId,
        product: c.product,
        t: c.hour,
        value: c.value,
      });
  }
  return [...rows.values()].sort((a, b) => a.t - b.t);
}

/** The first hour a check reads for an app (unix seconds). */
export function readFrom(
  app: { installedAt: number },
  lastCheckedAt: number | null,
  now: number,
): number {
  const hourOf = (t: number) => Math.floor(t / HOUR_MS) * HOUR_MS;
  const floor = Math.max(
    Math.floor(now / DAY_MS) * DAY_MS - MAX_BACKFILL_DAYS * DAY_MS,
    hourOf(app.installedAt),
  );
  const recent = hourOf(now) - RECENT_HOURS * HOUR_MS;
  const from =
    lastCheckedAt === null
      ? floor
      : Math.min(recent, hourOf(lastCheckedAt) - RECENT_HOURS * HOUR_MS);
  return Math.max(from, floor) / 1000;
}

/** Each storage product's level in the hour before `from`, from the stored usage. */
function levelsBefore(usage: Usage | undefined, from: number): Partial<Record<ProductKey, number>> {
  const out: Partial<Record<ProductKey, number>> = {};
  if (usage === undefined) return out;
  for (const product of LEVEL_PRODUCTS) {
    const series = usage[product];
    if (series === undefined) continue;
    let latest: number | undefined;
    for (const point of series) if (point.hour < from * 1000) latest = point.value;
    if (latest !== undefined) out[product] = latest;
  }
  return out;
}

async function prune(db: Database, now: number): Promise<number> {
  const at = new Date(now);
  const [usage, activity, firings] = await Promise.all([
    pruneUsage(db, at),
    pruneActivity(db, at),
    pruneAlertFirings(db, at),
  ]);
  return usage.hourly + usage.daily + activity + firings;
}

/** One check; see the module comment. */
export async function watchSpend(
  env: SpendWatchEnv,
  options: { maintenance?: boolean } = {},
  deps: SpendWatchDeps = {},
): Promise<SpendWatchReport> {
  const now = (deps.now ?? Date.now)();
  const db = createDb(env.DB);
  const budget = deps.budget ?? SUBREQUEST_BUDGET;
  const report: SpendWatchReport = {
    status: "idle",
    apps: 0,
    newApps: 0,
    rowsWritten: 0,
    alerts: 0,
    pauses: 0,
    deferred: 0,
    subrequests: 0,
    history: null,
    pruned: null,
  };
  const finish = async (status: SpendWatchStatus | null) => {
    if (status !== null) {
      report.status = status.state;
      if (status.state === "failed") report.error = status.error;
      try {
        await writeSpendWatchStatus(db, status);
      } catch (error) {
        console.error("spend watcher: status not stored", { error: message(error) });
      }
    }
    return report;
  };

  if (options.maintenance) {
    try {
      report.pruned = await prune(db, now);
    } catch (error) {
      console.error("spend watcher: pruning failed", { error: message(error) });
    }
  }

  try {
    const all = await readWatchedApps(env.DB);
    /** The pages' numbers from what is stored, for a check that collects nothing. */
    const storedOverview = async () => {
      const plan = await readAccountPlan(db);
      if (plan !== "free" || shardUnit(env) === null) {
        await writeOverview(env, db, { now, all });
        return;
      }
      const history = await loadHistory(db, env.KV, now, SUMS_HISTORY);
      const recent = await readUsage(db, {
        from: history.bounds.cutoff,
        to: Math.floor(now / HOUR_MS) * HOUR + HOUR,
        grain: "hour",
      });
      await checkInShards(
        env,
        db,
        {
          now,
          plan,
          all,
          judge: new Set(),
          incomplete: new Set(),
          alarms: new Map(),
          sums: usageByInstall(history.series, recent),
          fresh: new Set(),
          budget,
        },
        report,
      );
    };
    if (all.length === 0) {
      await storedOverview();
      return await finish({ state: "watching", at: now });
    }
    const grant = await readGrant(env.DB);
    if (grant !== null) {
      const missing = missingSpendProtectionScopes(grant.scopes);
      if (missing.length > 0) {
        await storedOverview();
        return await finish({ state: "needs_access", at: now, via: "oauth", missing });
      }
    }
    const apps = all.filter((a) => now - a.installedAt >= NEW_APP_MS);
    report.newApps = all.length - apps.length;
    report.apps = apps.length;
    if (apps.length === 0) {
      await storedOverview();
      return await finish({ state: "watching", at: now });
    }

    const plan = await readAccountPlan(db);
    const api: CloudflareClient = await getCfClient(env, {
      grant,
      ...(deps.fetch === undefined ? {} : { fetch: deps.fetch }),
      onRequest: () => {
        report.subrequests += 1;
      },
    });
    const states = await readUsageStates(
      db,
      apps.map((a) => a.installId),
    );

    // What is stored for the hours this check reads again, and the hour
    // before them (each storage level to carry forward).
    const froms = new Map(
      apps.map((a) => [
        a.installId,
        readFrom(a, states.get(a.installId)?.lastCheckedAt ?? null, now),
      ]),
    );
    const { cutoff } = historyBounds(now);
    const recentFrom = Math.min(cutoff, ...froms.values());
    const hourNow = Math.floor(now / HOUR_MS) * (HOUR_MS / 1000);
    const stored = await readUsage(db, {
      from: recentFrom - HOUR,
      to: hourNow + HOUR,
      grain: "hour",
    });
    const before = usageByInstall([], stored);

    // The account's Durable Object namespaces and containers: without
    // them, those products are left out for this check (not the rest).
    let unread: CollectSource[] = [];
    try {
      await addAccountResources(api, apps, plan);
    } catch (error) {
      unread = ["durableObjects", "containers", "alarms"];
      console.warn("spend watcher: Durable Object namespaces not listed", {
        error: message(error),
      });
    }
    const targets: CollectTarget[] = apps.map((a) => {
      const from = froms.get(a.installId) ?? hourNow;
      return {
        ...a.resources,
        from,
        levelsBefore: levelsBefore(before.get(a.installId), from),
        unread,
      };
    });
    const collected = await collectUsage(api.usage, targets, Math.floor(now / 1000));
    if (collected.failures.length > 0) {
      // Every read refused for lack of permission: the connection cannot read analytics.
      if (collected.succeeded === 0 && collected.failures.every((f) => isAccessRefusal(f.error))) {
        await storedOverview();
        return await finish({
          state: "needs_access",
          at: now,
          via: grant === null ? "token" : "oauth",
          missing: [],
        });
      }
      report.failedReads = collected.failures.map((f) => f.source);
      console.warn(
        `spend watcher: ${collected.failures.length} read(s) failed; their apps keep their last values this check`,
        {
          failed: collected.failures.map((f) => ({
            source: f.source,
            apps: f.installIds.length,
            error: message(f.error),
          })),
        },
      );
    }

    const changes = changedHours(collected.hours, storedIndex(stored));
    // The apps the check wrote hours of that cached histories hold already:
    // their histories are read afresh.
    const rewritten = new Set<string>();
    if (changes.length > 0) {
      const written = await recordHourlyUsage(db, changes, {
        levels: LEVEL_PRODUCTS,
        now: new Date(now),
      });
      report.rowsWritten = written.written;
      for (const c of changes) if (c.hour < cutoff) rewritten.add(c.installId);
    }
    const recent = recentRows(stored, changes, cutoff);
    const sharded = plan === "free" && shardUnit(env) !== null;
    const history = await loadHistory(db, env.KV, now, sharded ? SUMS_HISTORY : ALL_HISTORY, {
      fresh: rewritten,
    });
    report.history = history.source;

    if (sharded) {
      // Workers Free: the apps are judged in parts, each with CPU time of
      // its own (watcher-shard.server.ts); the account's sums are worked
      // out here.
      await checkInShards(
        env,
        db,
        {
          now,
          plan,
          all,
          judge: new Set(apps.map((a) => a.installId)),
          incomplete: collected.incomplete,
          alarms: collected.alarms,
          sums: usageByInstall(history.series, recent),
          fresh: rewritten,
          budget,
        },
        report,
      );
    } else {
      const usage = usageByInstall(history.series, recent);
      const paused = await judge(
        env,
        db,
        {
          now,
          plan,
          apps,
          usage,
          states,
          alarms: collected.alarms,
          incomplete: collected.incomplete,
        },
        deps,
        budget,
        report,
      );
      await writeOverview(env, db, { now, all, plan, usage, paused });
    }
    return await finish({ state: "watching", at: now });
  } catch (error) {
    console.error("spend watcher: check failed", { error: message(error) });
    return await finish({ state: "failed", at: now, error: message(error) });
  }
}

/** The one-line summary of a check for the Worker's logs. */
export function spendWatchLog(report: SpendWatchReport): string {
  const parts = [
    `spend watcher: ${report.status}`,
    `${report.apps} app(s)`,
    ...(report.newApps > 0 ? [`${report.newApps} too new`] : []),
    `${report.rowsWritten} row(s) written`,
    `${report.alerts} alert(s)`,
    `${report.pauses} pause(s)`,
    ...(report.deferred > 0 ? [`${report.deferred} left for the next check`] : []),
    `${report.subrequests} subrequest(s)`,
    ...(report.history === null ? [] : [`history from ${report.history}`]),
    ...(report.pruned === null ? [] : [`${report.pruned} old row(s) pruned`]),
    ...(report.failedReads === undefined ? [] : [`failed reads: ${report.failedReads.join(", ")}`]),
    ...(report.parts === undefined
      ? []
      : [
          `${report.parts.count} part(s)` +
            (report.parts.ran < report.parts.count
              ? ` (${report.parts.count - report.parts.ran} left for the next check)`
              : "") +
            (report.parts.failed > 0 ? ` (${report.parts.failed} failed)` : ""),
        ]),
  ];
  return parts.join(", ") + (report.error === undefined ? "" : `: ${report.error}`);
}
