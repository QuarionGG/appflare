import { CloudflareApiError, type WorkerObservability } from "@appflare/cf-api";
import { JobError } from "../jobs/errors";
import type { JobSteps } from "../jobs/steps";
import {
  type ObservabilityBlock,
  ObservabilityReadError,
  observabilityToCarry,
  type WorkersApi,
  workersLogsOn,
} from "./observability";

/**
 * Workers Logs kept through work Appflare does not upload itself, and the
 * carried block for an upload a job makes inside one of its steps.
 */

/**
 * The error a job step throws for a failed read: final for a refusal (a 4xx
 * other than 429), retried otherwise, with the words that say why nothing
 * was deployed.
 */
export function observabilityReadStepError(error: ObservabilityReadError): Error {
  const cause = error.cause;
  const final = cause instanceof CloudflareApiError && cause.status < 500 && cause.status !== 429;
  return final ? new JobError(error.message) : new Error(error.message);
}

/**
 * {@link observabilityToCarry} inside a job step: the `observability` block
 * an upload of `scriptName` sends (null: send none), or the step fails with
 * {@link observabilityReadStepError}. For a job that uploads a Worker
 * version itself, outside the upload unit.
 */
export async function observabilityToCarryInStep(
  api: WorkersApi,
  scriptName: string,
  whenNew: ObservabilityBlock | null | undefined,
): Promise<ObservabilityBlock | null> {
  try {
    return await observabilityToCarry(api, scriptName, whenNew);
  } catch (error) {
    if (error instanceof ObservabilityReadError) throw observabilityReadStepError(error);
    throw error;
  }
}

/**
 * Workers Logs of an app's Workers as Cloudflare reported them before its
 * own installer ran (a self-deploying app), by Worker; a Worker that did
 * not exist yet is left out (the installer gives it the app's own setting).
 * Null: no block, which is how Cloudflare reports them off.
 */
export type WorkersLogsBefore = Record<string, WorkerObservability | null>;

function onOrOff(block: WorkerObservability | null | undefined): string {
  return workersLogsOn(block) ? "on" : "off";
}

/** Whether two blocks say the same, whatever the order of their keys. */
function sameBlock(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (typeof a !== "object" || typeof b !== "object" || a === null || b === null) return false;
  if (Array.isArray(a) !== Array.isArray(b)) return false;
  const ka = Object.keys(a);
  const kb = Object.keys(b);
  return (
    ka.length === kb.length &&
    ka.every((k) => sameBlock((a as Record<string, unknown>)[k], (b as Record<string, unknown>)[k]))
  );
}

/**
 * Before an app's own installer deploys its Workers (a self-deploying app):
 * each existing Worker's whole Workers Logs block. The installer deploys
 * with the app's own configuration, which may turn them off (or on, or
 * change their sampling); {@link keepWorkersLogsPhase} puts them back
 * afterwards. A failed read fails the job before the installer runs.
 *
 * One step per Worker, each one Cloudflare call, within the requests a job
 * plans for one step (`STEP_SUBREQUESTS`).
 */
export async function readWorkersLogsPhase(
  steps: JobSteps,
  workers: readonly string[],
): Promise<WorkersLogsBefore> {
  const before: WorkersLogsBefore = {};
  for (const name of workers) {
    const read = await steps.run(`read Workers Logs of ${name}`, async ({ log, cf }) => {
      try {
        const block = (await cf().workers.getScriptSettings(name)).observability ?? null;
        log.info(`Workers Logs of ${name} before the installer runs: ${onOrOff(block)}.`);
        return { exists: true, block };
      } catch (error) {
        if (error instanceof CloudflareApiError && error.status === 404) {
          return { exists: false, block: null };
        }
        throw observabilityReadStepError(new ObservabilityReadError(name, error));
      }
    });
    if (read.exists) before[name] = read.block;
  }
  return before;
}

/**
 * What to tell the admin when Appflare could not put a Worker's Workers
 * Logs back: the Worker, and the setting to restore.
 */
export function workersLogsRestoreAdvice(name: string, block: WorkerObservability | null): string {
  return `Turn Workers Logs ${onOrOff(block)} for ${name} in the app's Usage tab: the installer may have changed them, and Appflare could not put them back.`;
}

/**
 * After the installer ran, also when the job fails after it started: puts
 * each Worker's Workers Logs back to the block it had before
 * ({@link readWorkersLogsPhase}) where they changed: the whole block
 * (sampling, logs and traces) when they were on, off when they were off.
 * Best effort: the app is deployed by then, so this never throws, and a
 * Worker it cannot put back gets a warning that names it and the setting
 * to restore. Returns the advice for each Worker whose step could not run
 * at all (its own warning could not be written), for the caller's log.
 *
 * One step per Worker, each at most two Cloudflare calls (a read, then the
 * change), within the requests a job plans for one step (`STEP_SUBREQUESTS`).
 */
export async function keepWorkersLogsPhase(
  steps: JobSteps,
  before: Readonly<WorkersLogsBefore>,
): Promise<string[]> {
  const unchecked: string[] = [];
  for (const [name, block] of Object.entries(before)) {
    try {
      await steps.run(`keep Workers Logs of ${name}`, async ({ log, cf }) => {
        try {
          const api = cf();
          const now = (await api.workers.getScriptSettings(name)).observability ?? null;
          if (block?.enabled === true) {
            if (sameBlock(now, block)) return {};
            await api.workers.setObservabilitySettings(name, block);
          } else {
            // Off: Cloudflare keeps no block for that, so only "on" is a change.
            if (now?.enabled !== true) return {};
            await api.workers.setObservability(name, false);
          }
          log.info(
            `The installer changed Workers Logs of ${name} (${onOrOff(now)} after it ran); they are ${onOrOff(block)} again, as they were.`,
          );
        } catch (error) {
          log.warn(
            `${workersLogsRestoreAdvice(name, block)} (${error instanceof Error ? error.message : String(error)})`,
          );
        }
        return {};
      });
    } catch {
      unchecked.push(workersLogsRestoreAdvice(name, block));
    }
  }
  return unchecked;
}
