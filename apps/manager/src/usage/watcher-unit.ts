import { z } from "zod";
import {
  type SpendWatchDeps,
  type SpendWatchEnv,
  type SpendWatchReport,
  spendWatchLog,
  watchSpend,
} from "./watcher.server";
import { runShard, type ShardUnitResult, shardInputSchema } from "./watcher-shard.server";

/**
 * The spend watcher as a unit of the manager's `JobUnits` entrypoint,
 * reached over the `SELF` service binding like the notification units: the
 * cron's call costs it one subrequest and the check runs in an invocation of
 * its own, with its own subrequest limit and CPU time. On Workers Free a
 * check judges its apps in parts through the `spendShard` unit, each part
 * with CPU time of its own (watcher-shard.server.ts). Without the binding
 * (a manager deployed before it existed) the whole check runs in place.
 *
 * The cron runs every five minutes. The spend watcher runs on every run; the
 * rest of the scheduled work (catalogs, release feed, notifications, ...)
 * only on the runs scheduled at minute 0 and 30, as before the cron ran
 * more often. The scheduled time decides, not the clock: a run that starts
 * late still counts as the run it was scheduled as.
 */

export type SpendWatcherResult =
  | { ok: true; value: SpendWatchReport }
  | { ok: false; error: string };

export interface SpendWatcherUnitsApi {
  watchSpend(input: unknown): Promise<SpendWatcherResult>;
  /** Judges a few apps of a check on Workers Free, and works out their pages' numbers. */
  spendShard(input: unknown): Promise<ShardUnitResult>;
}

const input = z.object({
  /** A half-hour run: prune what is past its retention too. */
  maintenance: z.boolean().default(false),
});

export function createSpendWatcherUnits(
  env: SpendWatchEnv,
  deps: SpendWatchDeps = {},
): SpendWatcherUnitsApi {
  return {
    async watchSpend(raw) {
      try {
        const { maintenance } = input.parse(raw ?? {});
        return { ok: true, value: await watchSpend(env, { maintenance }, deps) };
      } catch (error) {
        return { ok: false, error: error instanceof Error ? error.message : String(error) };
      }
    },
    async spendShard(raw) {
      try {
        return { ok: true, value: await runShard(env, shardInputSchema.parse(raw), deps) };
      } catch (error) {
        return { ok: false, error: error instanceof Error ? error.message : String(error) };
      }
    },
  };
}

/** The unit over `SELF`, or undefined on a manager without the binding. */
export function selfSpendWatcher(env: { SELF?: unknown }): SpendWatcherUnitsApi | undefined {
  const self: unknown = env.SELF;
  // The binding's generated type knows only the job units; `JobUnits` serves this one too.
  return self === undefined || self === null ? undefined : (self as SpendWatcherUnitsApi);
}

/** Whether a run scheduled at `scheduledTime` (epoch ms) is a half-hour run (minute 0 or 30). */
export function isHalfHourRun(scheduledTime: number): boolean {
  return new Date(Math.round(scheduledTime / 60_000) * 60_000).getUTCMinutes() % 30 === 0;
}

/**
 * One scheduled run: the spend watcher, then on half-hour runs the rest of
 * the scheduled work. The watcher never fails the run.
 */
export async function runScheduled(
  scheduledTime: number,
  work: {
    watch: (options: { maintenance: boolean }) => Promise<void>;
    halfHourly: () => Promise<void>;
  },
): Promise<void> {
  const halfHour = isHalfHourRun(scheduledTime);
  try {
    await work.watch({ maintenance: halfHour });
  } catch (error) {
    console.error("spend watcher failed", {
      error: error instanceof Error ? error.message : String(error),
    });
  }
  if (halfHour) await work.halfHourly();
}

/** The scheduled check: over `SELF` when the manager has it, else in place; logs one line. */
export async function scheduledSpendWatch(
  env: SpendWatchEnv,
  options: { maintenance: boolean },
  deps: SpendWatchDeps = {},
): Promise<void> {
  const units = selfSpendWatcher(env) ?? createSpendWatcherUnits(env, deps);
  const result = await units.watchSpend(options);
  if (!result.ok) {
    console.error("spend watcher failed", { error: result.error });
    return;
  }
  const line = spendWatchLog(result.value);
  if (result.value.status === "failed") console.error(line);
  else console.log(line);
}
