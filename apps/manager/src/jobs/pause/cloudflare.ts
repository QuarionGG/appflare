import {
  CloudflareApiError,
  type CloudflareClient,
  isWorkflowNotFound,
  type WorkflowInstanceStatus,
} from "@appflare/cf-api";
import type { WorkerExports } from "@appflare/schema";
import { ObservabilityReadError, withCarriedObservability } from "../../usage/observability";
import { JobError } from "../errors";
import { isStandIn, standInFactsOf, standInUpload, versionExportsOf } from "./stand-in";

/**
 * The Cloudflare calls of pausing and resuming an app, one small function
 * each, so the pause and resume jobs make each one a step of its own. Every
 * call that changes something is safe to repeat: deploying a version that
 * already serves, setting a queue's delivery or a container application's
 * instances to what they are, pausing a paused Workflow instance.
 */

function isStatus(error: unknown, test: (status: number) => boolean): boolean {
  return error instanceof CloudflareApiError && test(error.status);
}

/** Whether the object is gone (404). */
function isGone(error: unknown): boolean {
  return isStatus(error, (s) => s === 404);
}

/** The version that serves a Worker's traffic, or null when the Worker is gone. */
export interface ServingVersion {
  versionId: string;
  /** Its share of traffic; below 100 while a gradual deployment is under way. */
  percentage: number;
}

export async function servingVersionOf(
  api: CloudflareClient,
  script: string,
): Promise<ServingVersion | null> {
  let deployments: Awaited<ReturnType<typeof api.versions.listDeployments>>;
  try {
    deployments = await api.versions.listDeployments(script);
  } catch (error) {
    if (isGone(error)) return null;
    throw error;
  }
  // Cloudflare lists the deployment that serves first; its largest share wins.
  const versions = [...(deployments[0]?.versions ?? [])].sort(
    (a, b) => b.percentage - a.percentage,
  );
  const top = versions[0];
  if (top === undefined) {
    throw new JobError(`Worker "${script}" has no deployment, so there is nothing to pause`);
  }
  return { versionId: top.version_id, percentage: top.percentage };
}

/** One container application behind a Durable Object class of the app. */
export interface AppContainerApp {
  id: string;
  name: string;
  /** The Worker whose Durable Object class it backs. */
  script: string;
  className: string;
  /** The most instances it allows now. */
  maxInstances: number;
}

/** The app's Durable Object classes, by Worker, and the container applications behind them. */
export interface AppDurableObjects {
  classes: Record<string, string[]>;
  containers: AppContainerApp[];
  /** Why containers were not read: the account has none (not on Workers Paid), or the token may not read them. */
  containersUnread: "no-containers" | "refused" | null;
}

/**
 * The Durable Object classes the account's namespaces say `scripts`
 * implement, and the container applications that back any of them. An app
 * with no Durable Object has no container, so the containers are read only
 * when it has one.
 */
export async function readAppDurableObjects(
  api: CloudflareClient,
  scripts: readonly string[],
): Promise<AppDurableObjects> {
  const names = new Set(scripts);
  const namespaces = (await api.workers.listDurableObjectNamespaces()).filter(
    (ns) => ns.script !== undefined && names.has(ns.script),
  );
  const classes: Record<string, string[]> = {};
  const byId = new Map<string, { script: string; className: string }>();
  for (const ns of namespaces) {
    const script = ns.script as string;
    const className = ns.class ?? ns.name;
    if (className === undefined) continue;
    classes[script] = [...new Set([...(classes[script] ?? []), className])].sort();
    byId.set(ns.id, { script, className });
  }
  if (byId.size === 0) return { classes, containers: [], containersUnread: null };
  let apps: Awaited<ReturnType<typeof api.containers.listApplications>>;
  try {
    apps = await api.containers.listApplications();
  } catch (error) {
    // Cloudflare refuses Containers off Workers Paid (401), and to a token
    // without the Containers permission (403).
    if (isStatus(error, (s) => s === 401)) {
      return { classes, containers: [], containersUnread: "no-containers" };
    }
    if (isStatus(error, (s) => s === 403)) {
      return { classes, containers: [], containersUnread: "refused" };
    }
    throw error;
  }
  const containers: AppContainerApp[] = [];
  for (const app of apps) {
    const owner = byId.get(app.durable_objects?.namespace_id ?? "");
    if (owner === undefined) continue;
    containers.push({
      id: app.id,
      name: app.name,
      script: owner.script,
      className: owner.className,
      maxInstances: app.max_instances ?? 0,
    });
  }
  return { classes, containers, containersUnread: null };
}

/** What uploading a Worker's stand-in reads about the version it replaces. */
export interface ServingFacts {
  /** The serving version is itself a stand-in (an earlier pause left it). */
  standIn: boolean;
  version: ReturnType<typeof versionExportsOf>;
}

export async function servingFactsOf(
  api: CloudflareClient,
  script: string,
  versionId: string,
): Promise<ServingFacts> {
  const version = await api.versions.getVersion(script, versionId);
  return {
    standIn: isStandIn(version),
    version: versionExportsOf(version),
  };
}

/**
 * Uploads a Worker's stand-in (it serves nothing until deployed) and
 * returns its version id, with the Worker's Workers Logs setting carried
 * like every other upload Appflare makes (`withCarriedObservability`).
 *
 * A setting that cannot be read does not stop the pause: a version upload
 * and its deployment leave the script's setting as it is whatever the
 * metadata says (seen live), so the stand-in goes without the block
 * (`observability: "unread"`) rather than leave the app running. A read
 * Cloudflare may answer next time (429, 5xx) is thrown, for the step to retry.
 */
export async function uploadStandIn(
  api: CloudflareClient,
  script: string,
  input: {
    serving: ServingFacts;
    durableObjects: AppDurableObjects;
    exports: WorkerExports | null;
  },
): Promise<{ versionId: string; observability: "carried" | "none" | "unread" }> {
  const facts = standInFactsOf({
    version: input.serving.version,
    namespaceClasses: input.durableObjects.classes[script] ?? [],
    containers: input.durableObjects.containers
      .filter((c) => c.script === script)
      .map((c) => ({ name: c.name, class_name: c.className })),
    exports: input.exports,
  });
  const upload = standInUpload(facts);
  let metadata = upload.metadata;
  let observability: "carried" | "none" | "unread";
  try {
    metadata = await withCarriedObservability(api, script, upload.metadata);
    observability = metadata.observability === undefined ? "none" : "carried";
  } catch (error) {
    if (!(error instanceof ObservabilityReadError)) throw error;
    if (isStatus(error.cause, (s) => s === 429 || s >= 500)) throw error.cause;
    observability = "unread";
  }
  const result = await api.versions.uploadVersion(script, { ...upload, metadata });
  if (typeof result.id !== "string" || result.id.length === 0) {
    throw new JobError(`Cloudflare did not answer with the stand-in's version id for "${script}"`);
  }
  return { versionId: result.id, observability };
}

/**
 * Deploys a version of a Worker at 100% of its traffic. Forced, so a secret
 * changed since the version was made never blocks it: the version is put
 * back exactly as it was.
 */
export async function serveVersion(
  api: CloudflareClient,
  script: string,
  versionId: string,
  message: string,
): Promise<void> {
  await api.versions.createDeployment(script, {
    versions: [{ version_id: versionId, percentage: 100 }],
    annotations: { "workers/message": message },
    force: true,
  });
}

/** A queue as Cloudflare names it now, and whether its delivery is paused; null when it is gone. */
export async function queueStateOf(
  api: CloudflareClient,
  queueId: string,
): Promise<{ name: string; paused: boolean } | null> {
  try {
    const queue = await api.queues.getQueue(queueId);
    return { name: queue.queue_name, paused: queue.settings?.delivery_paused === true };
  } catch (error) {
    if (isGone(error)) return null;
    throw error;
  }
}

/** Pauses or resumes a queue's delivery; "gone" when the queue no longer exists. */
export async function setQueueDelivery(
  api: CloudflareClient,
  queue: { id: string; name: string },
  paused: boolean,
): Promise<"set" | "gone"> {
  try {
    await api.queues.setDeliveryPaused({ queueId: queue.id, queueName: queue.name, paused });
    return "set";
  } catch (error) {
    if (isGone(error)) return "gone";
    throw error;
  }
}

/** Sets a container application's most instances; "gone" when it no longer exists. */
export async function setContainerInstances(
  api: CloudflareClient,
  id: string,
  maxInstances: number,
): Promise<"set" | "gone"> {
  try {
    await api.containers.setMaxInstances(id, maxInstances);
    return "set";
  } catch (error) {
    if (isGone(error)) return "gone";
    throw error;
  }
}

/** Workflow instances that run or will run: what a pause pauses. */
export const ACTIVE_INSTANCE_STATUSES: readonly WorkflowInstanceStatus[] = [
  "queued",
  "running",
  "waiting",
];

/** The most instances of one Workflow a pause pauses (each is a call of its own). */
export const MAX_PAUSED_INSTANCES = 1_000;

/**
 * The ids of a Workflow's instances that run or are about to, at most
 * {@link MAX_PAUSED_INSTANCES}; null when the Workflow is gone.
 */
export async function activeInstancesOf(
  api: CloudflareClient,
  workflow: string,
): Promise<{ ids: string[]; capped: boolean } | null> {
  let info: Awaited<ReturnType<typeof api.workflows.getWorkflow>>;
  try {
    info = await api.workflows.getWorkflow(workflow);
  } catch (error) {
    if (isWorkflowNotFound(error)) return null;
    throw error;
  }
  // Cloudflare counts the Workflow's instances by status: none active, no list to read.
  const counts = (info as { instances?: Record<string, unknown> }).instances;
  if (
    counts !== undefined &&
    ACTIVE_INSTANCE_STATUSES.every((s) => typeof counts[s] === "number" && counts[s] === 0)
  ) {
    return { ids: [], capped: false };
  }
  const ids = new Set<string>();
  let capped = false;
  for (const status of ACTIVE_INSTANCE_STATUSES) {
    // Enough already: the statuses after it are not listed.
    if (ids.size >= MAX_PAUSED_INSTANCES) {
      capped = true;
      break;
    }
    // No page past what is still wanted (one more tells whether there are others).
    const room = MAX_PAUSED_INSTANCES - ids.size;
    const listed = await api.workflows.listInstances(workflow, { status, limit: room + 1 });
    for (const instance of listed) {
      if (ids.size >= MAX_PAUSED_INSTANCES) {
        capped = true;
        break;
      }
      ids.add(instance.id);
    }
  }
  return { ids: [...ids], capped };
}

/**
 * Pauses or resumes one Workflow instance. An instance that ended, or is
 * already in the asked state, is refused by Cloudflare with a 4xx: nothing
 * to do, so it counts as skipped. A refused permission (401, 403) is thrown,
 * as are 429 and 5xx, to be retried.
 */
export async function setInstanceStatus(
  api: CloudflareClient,
  workflow: string,
  instanceId: string,
  to: "pause" | "resume",
): Promise<"done" | "skipped"> {
  try {
    if (to === "pause") await api.workflows.pauseInstance(workflow, instanceId);
    else await api.workflows.resumeInstance(workflow, instanceId);
    return "done";
  } catch (error) {
    if (isStatus(error, (s) => s >= 400 && s < 500 && ![401, 403, 429].includes(s))) {
      return "skipped";
    }
    throw error;
  }
}
