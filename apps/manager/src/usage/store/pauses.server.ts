import { and, desc, eq, isNull } from "drizzle-orm";
import { ulid } from "ulidx";
import { z } from "zod";
import type { Database } from "../../db/client";
import { app_pauses, type PauseReason } from "../../db/schema";

/**
 * Pauses of installs. A pause is open from the moment it is recorded until
 * Resume closes it, and an install has at most one open pause (a unique
 * index over the open rows enforces it). What the pause changed is recorded
 * on the row as the pause job does it, so Resume restores exactly that.
 */

/**
 * The version each Worker of the app served before its stand-in, by Worker
 * name: every Worker the app deployed, so an app of several Workers resumes
 * all of them.
 */
export const pauseWorkerVersionsSchema = z
  .record(z.string().min(1), z.string().min(1))
  .refine((v) => Object.keys(v).length > 0, "At least one Worker's version is needed");
export type PauseWorkerVersions = z.infer<typeof pauseWorkerVersionsSchema>;

/** A stored value that does not parse reads as not recorded. */
function parseWorkerVersions(raw: string | null): PauseWorkerVersions | null {
  if (raw === null) return null;
  try {
    return pauseWorkerVersionsSchema.safeParse(JSON.parse(raw)).data ?? null;
  } catch {
    return null;
  }
}

/** Validates (throws a ZodError on a bad value) and serializes; undefined leaves the column alone. */
function serializeWorkerVersions(value: PauseWorkerVersions | null | undefined) {
  if (value === undefined || value === null) return value;
  return JSON.stringify(pauseWorkerVersionsSchema.parse(value));
}

export interface AppPause {
  id: string;
  installId: string;
  /** Epoch ms. */
  pausedAt: number;
  /** `auto` (a trigger), or the user id of who paused it. */
  pausedBy: string;
  reason: PauseReason;
  detailJson: string | null;
  /** Null until recorded. */
  workerVersions: PauseWorkerVersions | null;
  containersJson: string | null;
  queuesJson: string | null;
  workflowsJson: string | null;
  jobId: string | null;
  resumeJobId: string | null;
  /** Epoch ms; null while open. */
  resumedAt: number | null;
  resumedBy: string | null;
}

/** What the pause job records as it goes; each field is written only when given. */
export interface PauseProgress {
  detailJson?: string | null;
  workerVersions?: PauseWorkerVersions | null;
  containersJson?: string | null;
  queuesJson?: string | null;
  workflowsJson?: string | null;
  jobId?: string | null;
  /** The resume job, once one started (a failed resume leaves the pause open). */
  resumeJobId?: string | null;
}

type Row = typeof app_pauses.$inferSelect;

function fromRow(row: Row): AppPause {
  return {
    id: row.id,
    installId: row.install_id,
    pausedAt: row.paused_at.getTime(),
    pausedBy: row.paused_by,
    reason: row.reason,
    detailJson: row.detail_json,
    workerVersions: parseWorkerVersions(row.worker_versions_json),
    containersJson: row.containers_json,
    queuesJson: row.queues_json,
    workflowsJson: row.workflows_json,
    jobId: row.job_id,
    resumeJobId: row.resume_job_id,
    resumedAt: row.resumed_at?.getTime() ?? null,
    resumedBy: row.resumed_by,
  };
}

function progressColumns(p: PauseProgress) {
  return {
    detail_json: p.detailJson,
    worker_versions_json: serializeWorkerVersions(p.workerVersions),
    containers_json: p.containersJson,
    queues_json: p.queuesJson,
    workflows_json: p.workflowsJson,
    job_id: p.jobId,
    resume_job_id: p.resumeJobId,
  };
}

/**
 * Opens a pause of the install. When one is already open, nothing is
 * written and that one is returned with `opened: false`, so a retried step
 * or a second trigger never pauses an app twice.
 */
export async function openPause(
  db: Database,
  input: {
    installId: string;
    pausedBy: string;
    reason: PauseReason;
    pausedAt?: Date;
  } & PauseProgress,
): Promise<{ opened: boolean; pause: AppPause }> {
  const [row] = await db
    .insert(app_pauses)
    .values({
      id: ulid(),
      install_id: input.installId,
      paused_at: input.pausedAt ?? new Date(),
      paused_by: input.pausedBy,
      reason: input.reason,
      ...progressColumns(input),
    })
    .onConflictDoNothing()
    .returning();
  if (row) return { opened: true, pause: fromRow(row) };
  const open = await findOpenPause(db, input.installId);
  if (!open) throw new Error("The pause was neither stored nor found open");
  return { opened: false, pause: open };
}

/** Records what the pause changed so far; returns null when the pause is not open. */
export async function recordPauseProgress(
  db: Database,
  pauseId: string,
  progress: PauseProgress,
): Promise<AppPause | null> {
  const set = progressColumns(progress);
  if (Object.values(set).every((v) => v === undefined)) {
    const [row] = await db
      .select()
      .from(app_pauses)
      .where(and(eq(app_pauses.id, pauseId), isNull(app_pauses.resumed_at)));
    return row ? fromRow(row) : null;
  }
  const [row] = await db
    .update(app_pauses)
    .set(set)
    .where(and(eq(app_pauses.id, pauseId), isNull(app_pauses.resumed_at)))
    .returning();
  return row ? fromRow(row) : null;
}

/** The install's open pause, or null when it is not paused. */
export async function findOpenPause(db: Database, installId: string): Promise<AppPause | null> {
  const [row] = await db
    .select()
    .from(app_pauses)
    .where(and(eq(app_pauses.install_id, installId), isNull(app_pauses.resumed_at)));
  return row ? fromRow(row) : null;
}

/** Every open pause (every paused install), oldest first. */
export async function listOpenPauses(db: Database): Promise<AppPause[]> {
  const rows = await db
    .select()
    .from(app_pauses)
    .where(isNull(app_pauses.resumed_at))
    .orderBy(app_pauses.paused_at);
  return rows.map(fromRow);
}

/** The install's pauses, newest first (for its recent activity). */
export async function listPauses(db: Database, installId: string, limit = 50): Promise<AppPause[]> {
  const rows = await db
    .select()
    .from(app_pauses)
    .where(eq(app_pauses.install_id, installId))
    .orderBy(desc(app_pauses.paused_at), desc(app_pauses.id))
    .limit(limit);
  return rows.map(fromRow);
}

/**
 * Closes the install's open pause on resume and returns it as closed; null
 * when it had none open (already resumed).
 */
export async function closePause(
  db: Database,
  installId: string,
  by: { resumedBy: string; resumedAt?: Date; resumeJobId?: string },
): Promise<AppPause | null> {
  const [row] = await db
    .update(app_pauses)
    .set({
      resumed_at: by.resumedAt ?? new Date(),
      resumed_by: by.resumedBy,
      resume_job_id: by.resumeJobId,
    })
    .where(and(eq(app_pauses.install_id, installId), isNull(app_pauses.resumed_at)))
    .returning();
  return row ? fromRow(row) : null;
}
