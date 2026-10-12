import { ulid } from "ulidx";
import type { PauseReason } from "../db/schema";
import { type JobWorkflows, jobCreator } from "../jobs/create-job.server";
import type { PauseJobParams, ResumeJobParams } from "../jobs/pause/params";
import type { WorkflowLookup } from "../jobs/reconcile.server";
import {
  activeSelfJob,
  NO_ACTIVE_SELF_UPDATE_SQL,
  refuseDuringSelfUpdate,
  selfUpdateBusyMessage,
} from "../jobs/self-update/guard";
import { type PauseCause, pauseCauseSchema } from "./attention-cause";

/**
 * Starting the pause and resume jobs (../jobs/pause.ts, ../jobs/resume.ts):
 * by an admin from Home or the app's Usage tab, and by the spend watcher
 * when a trigger trips. Like every job of an install, one runs at a time:
 * the job row is inserted only when the install is installed and no job of
 * it is queued or running (nor a self-update of Appflare), then the job's
 * Workflow instance is created. Neither job changes the install's status:
 * the open pause is what says the app is paused.
 */

export class PauseActionError extends Error {
  override name = "PauseActionError";
}

export interface PauseStartEnv {
  DB: D1Database;
  /** The job Workflow binding (`JOBS`). */
  JOBS: JobWorkflows & Partial<WorkflowLookup>;
}

export interface PauseStartDeps {
  now?: () => Date;
  newId?: () => string;
}

/** Why a pause starts, with the facts its reason carries (`pauseCauseSchema` without `reason`). */
export type PauseRequestCause = {
  [R in PauseReason]: {
    reason: R;
    detail?: Omit<Extract<PauseCause, { reason: R }>, "reason"> | null;
  };
}[PauseReason];

export type PauseRequest = PauseRequestCause & {
  installId: string;
  /** The user id of who pauses it; null when a trigger does. */
  by: string | null;
};

export interface ResumeRequest {
  installId: string;
  /** The user id of who resumes it. */
  by: string;
  /** Set the spending cap aside until its period resets. */
  untilCapResets?: boolean;
}

const BUSY = "Another job of this app is queued or running. Wait for it to finish.";

interface InstallState {
  status: string;
  /** The open pause, if any, with the state of the job that made it. */
  pauseId: string | null;
  pauseJobStatus: string | null;
}

async function readState(db: D1Database, installId: string): Promise<InstallState> {
  const row = await db
    .prepare(
      `SELECT i.status, p.id AS pause_id, j.status AS job_status
       FROM installs i
       LEFT JOIN app_pauses p ON p.install_id = i.id AND p.resumed_at IS NULL
       LEFT JOIN jobs j ON j.id = p.job_id
       WHERE i.id = ?1`,
    )
    .bind(installId)
    .first<{ status: string; pause_id: string | null; job_status: string | null }>();
  if (row === null) throw new PauseActionError("There is no such app.");
  return { status: row.status, pauseId: row.pause_id, pauseJobStatus: row.job_status };
}

function statusRefusal(status: string, doing: "paused" | "resumed"): string | null {
  if (status === "installed") return null;
  if (status === "updating") {
    return "An update, rollback or settings change of this app is running. Wait for it to finish.";
  }
  if (status === "uninstalled") return "This app is uninstalled.";
  return `Only an installed app can be ${doing}.`;
}

/** Why the app cannot be paused now; null when it can. */
function pauseRefusal(state: InstallState): string | null {
  const status = statusRefusal(state.status, "paused");
  if (status !== null) return status;
  if (state.pauseId === null) return null;
  if (state.pauseJobStatus === "succeeded") return "This app is already paused.";
  if (state.pauseJobStatus === "queued" || state.pauseJobStatus === "running") {
    return "This app is being paused.";
  }
  // A pause whose job failed or was stopped before it finished: a new pause carries it on.
  return null;
}

/** Why the app cannot be resumed now; null when it can. */
function resumeRefusal(state: InstallState): string | null {
  const status = statusRefusal(state.status, "resumed");
  if (status !== null) return status;
  return state.pauseId === null ? "This app is not paused." : null;
}

async function claimAndStart<P extends PauseJobParams | ResumeJobParams>(
  env: PauseStartEnv,
  deps: PauseStartDeps,
  input: {
    params: P;
    inputJson: string;
    startedBy: "admin" | "schedule";
    /** More conditions on the install (`?2`) for the claim. */
    conditions: string;
    refusal: (state: InstallState) => string | null;
  },
): Promise<{ jobId: string }> {
  const db = env.DB;
  const workflows = env.JOBS.get === undefined ? undefined : (env.JOBS as WorkflowLookup);
  await refuseDuringSelfUpdate(db, workflows, (m) => new PauseActionError(m));
  const { params } = input;
  const before = input.refusal(await readState(db, params.installId));
  if (before !== null) throw new PauseActionError(before);
  const claimed = await db
    .prepare(
      `INSERT INTO jobs (id, install_id, kind, status, input_json, started_by)
       SELECT ?1, ?2, ?3, 'queued', ?4, ?5
       WHERE EXISTS (SELECT 1 FROM installs WHERE id = ?2 AND status = 'installed')
         AND NOT EXISTS (
           SELECT 1 FROM jobs WHERE install_id = ?2 AND status IN ('queued', 'running')
         )
         AND ${input.conditions}
         AND ${NO_ACTIVE_SELF_UPDATE_SQL}`,
    )
    .bind(params.jobId, params.installId, params.kind, input.inputJson, input.startedBy)
    .run();
  if (claimed.meta.changes !== 1) {
    const self = await activeSelfJob(db);
    if (self !== null) throw new PauseActionError(selfUpdateBusyMessage(self));
    throw new PauseActionError(input.refusal(await readState(db, params.installId)) ?? BUSY);
  }
  const now = (deps.now ?? (() => new Date()))();
  let instanceId: string;
  try {
    instanceId = (await jobCreator(env.JOBS)(params.jobId, params)).id;
  } catch (error) {
    const reason = `start: could not create the job: ${error instanceof Error ? error.message : String(error)}`;
    await db
      .prepare("UPDATE jobs SET status = 'failed', error = ?2, finished_at = ?3 WHERE id = ?1")
      .bind(params.jobId, reason, now.getTime())
      .run();
    throw new PauseActionError(reason);
  }
  await db
    .prepare("UPDATE jobs SET workflow_instance_id = ?2 WHERE id = ?1")
    .bind(params.jobId, instanceId)
    .run();
  return { jobId: params.jobId };
}

/**
 * Starts pausing an app: by an admin (`by` is their user id, `reason`
 * `manual`), or by a spend protection trigger (`by` null, with the
 * trigger's reason and facts). Returns the job's id; throws
 * `PauseActionError` with a sentence for the admin when it cannot start (the
 * app is paused already, another job of it runs, it is not installed).
 */
export async function startPause(
  env: PauseStartEnv,
  request: PauseRequest,
  deps: PauseStartDeps = {},
): Promise<{ jobId: string }> {
  const cause = pauseCauseSchema.safeParse({ ...(request.detail ?? {}), reason: request.reason });
  if (!cause.success) throw new PauseActionError("The reason for the pause is not valid.");
  const { reason, ...detail } = cause.data;
  const jobId = (deps.newId ?? ulid)();
  const params: PauseJobParams = {
    kind: "pause",
    jobId,
    installId: request.installId,
    reason,
    detail: Object.keys(detail).length === 0 ? null : detail,
    by: request.by,
  };
  return claimAndStart(env, deps, {
    params,
    inputJson: JSON.stringify({
      installId: request.installId,
      reason,
      detail: params.detail,
      by: request.by,
    }),
    startedBy: request.by === null ? "schedule" : "admin",
    // Not while a pause of it that finished is open.
    conditions: `NOT EXISTS (
      SELECT 1 FROM app_pauses p JOIN jobs j ON j.id = p.job_id
      WHERE p.install_id = ?2 AND p.resumed_at IS NULL AND j.status = 'succeeded'
    )`,
    refusal: pauseRefusal,
  });
}

/**
 * Starts resuming a paused app. Returns the job's id; throws
 * `PauseActionError` when it cannot start (it is not paused, another job
 * of it runs).
 */
export async function startResume(
  env: PauseStartEnv,
  request: ResumeRequest,
  deps: PauseStartDeps = {},
): Promise<{ jobId: string }> {
  const jobId = (deps.newId ?? ulid)();
  const params: ResumeJobParams = {
    kind: "resume",
    jobId,
    installId: request.installId,
    by: request.by,
    untilCapResets: request.untilCapResets === true,
  };
  return claimAndStart(env, deps, {
    params,
    inputJson: JSON.stringify({
      installId: request.installId,
      by: request.by,
      untilCapResets: params.untilCapResets,
    }),
    startedBy: "admin",
    conditions: "EXISTS (SELECT 1 FROM app_pauses WHERE install_id = ?2 AND resumed_at IS NULL)",
    refusal: resumeRefusal,
  });
}
