import { CloudflareApiError } from "@appflare/cf-api";
import { and, eq, inArray, isNull } from "drizzle-orm";
import { inConnectionWordsOf } from "../cloudflare/sign-in-words.server";
import { createDb, type Database } from "../db/client";
import { installs, jobs, resources } from "../db/schema";
import { type WorkersApi, workersLogsOn } from "./observability";
import { OBSERVABILITY_MESSAGES, type SetObservabilityInput } from "./observability-copy";
import { recordActivity } from "./store/activity.server";

/**
 * An app's Workers Logs, server side: read from Cloudflare for every Worker
 * of the app (Appflare stores no copy; deploys carry whatever Cloudflare
 * has, see observability.ts), and turned on or off by an admin with
 * `PATCH .../script-settings` on each of them, which creates no new version
 * and needs only the Workers Scripts permission Appflare deploys with.
 */

export class ObservabilityError extends Error {
  override name = "ObservabilityError";
}

export interface ObservabilityDeps {
  db: D1Database;
  /** The Cloudflare client; called only once the install is known. */
  api: () => Promise<WorkersApi>;
  now?: () => Date;
}

/** One Worker's Workers Logs; `on` is null when Cloudflare did not say. */
export interface WorkerLogs {
  workerName: string;
  on: boolean | null;
}

/**
 * The app as a whole: `mixed` when its Workers differ, `unknown` when any
 * of them could not be read (`problem` says why).
 */
export type AppLogsState = "on" | "off" | "mixed" | "unknown";

export interface AppObservability {
  installId: string;
  state: AppLogsState;
  workers: WorkerLogs[];
  problem: string | null;
}

/** Statuses whose Workers an admin may change: those that are deployed and not on their way out. */
const CHANGEABLE = new Set(["installed", "updating"]);

/** A refusal for want of a permission (403, or Cloudflare's authentication codes); never a 5xx. */
function isPermissionRefusal(error: unknown): boolean {
  return (
    error instanceof CloudflareApiError &&
    error.status < 500 &&
    (error.status === 403 || error.errors.some((e) => e.code === 10000 || e.code === 9109))
  );
}

function said(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** The install's status and its Workers, the one it is named after first. */
async function installWorkers(
  orm: Database,
  installId: string,
): Promise<{ status: string; workers: string[] }> {
  const [install] = await orm
    .select({ status: installs.status, workerName: installs.worker_name })
    .from(installs)
    .where(eq(installs.id, installId))
    .limit(1);
  if (install === undefined) throw new ObservabilityError(OBSERVABILITY_MESSAGES.noInstall);
  const rows = await orm
    .select({ name: resources.name })
    .from(resources)
    .where(
      and(
        eq(resources.install_id, installId),
        eq(resources.kind, "worker"),
        isNull(resources.deleted_at),
      ),
    );
  const others = new Set(rows.map((r) => r.name).filter((name) => name !== install.workerName));
  return { status: install.status, workers: [install.workerName, ...[...others].sort()] };
}

function appState(workers: readonly WorkerLogs[]): AppLogsState {
  if (workers.length === 0 || workers.some((w) => w.on === null)) return "unknown";
  if (workers.every((w) => w.on === true)) return "on";
  if (workers.every((w) => w.on === false)) return "off";
  return "mixed";
}

/**
 * Whether Workers Logs are on for each Worker of the app, read from
 * Cloudflare. Never throws for Cloudflare's answers: a Worker it cannot
 * read is `on: null`, and `problem` says why (a missing permission in the
 * words for how Appflare connects).
 */
export async function readAppObservability(
  deps: ObservabilityDeps,
  installId: string,
): Promise<AppObservability> {
  const orm = createDb(deps.db);
  const { workers } = await installWorkers(orm, installId);
  const api = await deps.api();
  let problem: string | null = null;
  const out: WorkerLogs[] = [];
  for (const workerName of workers) {
    try {
      const settings = await api.workers.getScriptSettings(workerName);
      out.push({ workerName, on: workersLogsOn(settings.observability) });
    } catch (error) {
      out.push({ workerName, on: null });
      if (problem !== null) continue;
      if (isPermissionRefusal(error)) {
        problem = await inConnectionWordsOf(deps.db, OBSERVABILITY_MESSAGES.permission);
      } else if (error instanceof CloudflareApiError && error.status === 404) {
        problem = OBSERVABILITY_MESSAGES.workerGone(workerName);
      } else {
        problem = OBSERVABILITY_MESSAGES.readFailed(workerName, said(error));
      }
    }
  }
  return { installId, state: appState(out), workers: out, problem };
}

/** A job running on the install (queued or running), if any. */
async function activeJobOf(orm: Database, installId: string): Promise<string | null> {
  const [active] = await orm
    .select({ id: jobs.id })
    .from(jobs)
    .where(and(eq(jobs.install_id, installId), inArray(jobs.status, ["queued", "running"])))
    .limit(1);
  return active?.id ?? null;
}

/** Why Cloudflare did not change `workerName`, in words for the admin. */
async function changeRefusal(
  db: D1Database,
  error: unknown,
  workerName: string,
  done: readonly string[],
): Promise<string> {
  const partly = done.length === 0 ? "" : ` ${OBSERVABILITY_MESSAGES.partlyChanged(done)}`;
  if (isPermissionRefusal(error)) {
    return `${await inConnectionWordsOf(db, OBSERVABILITY_MESSAGES.permission)}${partly}`;
  }
  if (error instanceof CloudflareApiError && error.status === 404) {
    return `${OBSERVABILITY_MESSAGES.workerGone(workerName)}${partly}`;
  }
  return OBSERVABILITY_MESSAGES.changeFailed(workerName, said(error), done);
}

/**
 * Turns Workers Logs on or off for every Worker of the app, one by one, and
 * records it in the app's activity (`observability_changed`, by the admin).
 * Refused while a job runs on the app: a deploy reads the setting just
 * before it uploads, and a change in between would be lost.
 *
 * Throws {@link ObservabilityError} with words for the admin when the app
 * cannot be changed or Cloudflare refuses. Workers changed before a refusal
 * stay changed (it says which) and are recorded as a partial change
 * (`partial: true`, `workers` the ones changed); trying again changes the
 * rest.
 */
export async function setAppObservability(
  deps: ObservabilityDeps,
  input: SetObservabilityInput & { by: string },
): Promise<AppObservability> {
  const orm = createDb(deps.db);
  const { status, workers } = await installWorkers(orm, input.installId);
  if (!CHANGEABLE.has(status)) throw new ObservabilityError(OBSERVABILITY_MESSAGES.notInstalled);
  if ((await activeJobOf(orm, input.installId)) !== null) {
    throw new ObservabilityError(OBSERVABILITY_MESSAGES.jobRunning);
  }
  const api = await deps.api();
  const out: WorkerLogs[] = [];
  const record = (changed: readonly string[], partial: boolean) =>
    recordActivity(orm, {
      installId: input.installId,
      kind: "observability_changed",
      facts: { enabled: input.enabled, workers: [...changed], ...(partial ? { partial } : {}) },
      by: input.by,
      ...(deps.now === undefined ? {} : { at: deps.now() }),
    });
  for (const workerName of workers) {
    try {
      const settings = await api.workers.setObservability(workerName, input.enabled);
      out.push({ workerName, on: workersLogsOn(settings.observability) });
    } catch (error) {
      const done = out.map((w) => w.workerName);
      const message = await changeRefusal(deps.db, error, workerName, done);
      if (done.length > 0) await record(done, true);
      throw new ObservabilityError(message);
    }
  }
  await record(workers, false);
  return { installId: input.installId, state: appState(out), workers: out, problem: null };
}
