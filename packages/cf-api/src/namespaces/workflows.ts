import { CloudflareApiError } from "../errors";
import type { HttpApi } from "../http";
import type {
  WorkflowInfo,
  WorkflowInstance,
  WorkflowInstanceStatus,
  WorkflowInstanceStatusChange,
  WorkflowPutBody,
} from "../types";

const enc = encodeURIComponent;

/** The most instances `GET /workflows/{name}/instances` returns per page (1,000 is refused). */
export const WORKFLOW_INSTANCES_PER_PAGE = 100;

/** `GET /workflows/{name}` of a Workflow that does not exist (`workflow.not_found`, HTTP 404). */
export const WORKFLOW_NOT_FOUND_CODE = 10200;

/**
 * `PUT /workflows/{name}` with `schedules` on an account without Workers Paid:
 * scheduled Workflows need a paid plan. The code wrangler 4.136.2 maps
 * (`WORKFLOW_CRON_REQUIRES_PAID_PLAN_CODE` in its triggers deploy).
 */
export const WORKFLOW_CRON_REQUIRES_PAID_PLAN_CODE = 10208;

/** True when `error` is Cloudflare saying the Workflow does not exist. */
export function isWorkflowNotFound(error: unknown): boolean {
  return (
    error instanceof CloudflareApiError &&
    (error.status === 404 || error.errors.some((e) => e.code === WORKFLOW_NOT_FOUND_CODE))
  );
}

/** True when `error` is Cloudflare refusing a scheduled Workflow on an account without Workers Paid. */
export function isWorkflowCronPaidOnly(error: unknown): boolean {
  return (
    error instanceof CloudflareApiError &&
    error.errors.some((e) => e.code === WORKFLOW_CRON_REQUIRES_PAID_PLAN_CODE)
  );
}

/**
 * Workflows (account-scoped names). Uploading a Worker never creates one: a
 * `workflow` binding only points at a Workflow by name, and the Workflow
 * exists once `PUT /workflows/{name}` says which script and class run it,
 * which is what `wrangler deploy` does after every upload for each Workflow
 * the Worker defines. Until then the binding's `create()` fails.
 */
export function createWorkflows(http: HttpApi) {
  return {
    /** `GET /workflows/{workflow_name}`; throws `CloudflareApiError` (404, code 10200, when absent). */
    getWorkflow(name: string): Promise<WorkflowInfo> {
      return http.result("GET", http.acct(`/workflows/${enc(name)}`));
    },

    /**
     * `PUT /workflows/{workflow_name}`: creates the Workflow, or updates the
     * one of that name, to run `class_name` of `script_name`. Idempotent, so a
     * retried call is harmless; it also takes the name over from another
     * script, so callers check a new name is free first. Throws
     * `CloudflareApiError`; `schedules` on an account without Workers Paid is
     * refused with {@link WORKFLOW_CRON_REQUIRES_PAID_PLAN_CODE}.
     */
    putWorkflow(name: string, body: WorkflowPutBody): Promise<WorkflowInfo> {
      return http.result("PUT", http.acct(`/workflows/${enc(name)}`), { json: body });
    },

    /**
     * `GET /workflows/{workflow_name}/instances[?status=]`: every instance
     * (with `status`, only those in it), following the list's cursor
     * (`result_info.cursor`, absent on the last page) as wrangler
     * does. With `limit`, at most that many: no page is read once they are in.
     */
    async listInstances(
      name: string,
      opts: { status?: WorkflowInstanceStatus; limit?: number } = {},
    ): Promise<WorkflowInstance[]> {
      const all: WorkflowInstance[] = [];
      const limit = opts.limit ?? Number.POSITIVE_INFINITY;
      if (limit <= 0) return all;
      let cursor: string | undefined;
      // Defensive cap: 1,000 pages is 100,000 instances.
      for (let page = 0; page < 1000; page++) {
        const envelope = await http.send("GET", http.acct(`/workflows/${enc(name)}/instances`), {
          query: { status: opts.status, per_page: WORKFLOW_INSTANCES_PER_PAGE, cursor },
        });
        const rows = Array.isArray(envelope.result) ? (envelope.result as WorkflowInstance[]) : [];
        all.push(...rows.slice(0, limit - all.length));
        cursor = envelope.result_info?.cursor;
        if (!cursor || rows.length === 0 || all.length >= limit) break;
      }
      return all;
    },

    /**
     * `PATCH /workflows/{workflow_name}/instances/{instance_id}/status` with
     * `{ status: "pause" }`. A running instance finishes its current step
     * and waits (`waitingForPause`, then `paused`). Instances stay on the
     * Worker version they started on, so pausing them is how their work
     * stops while another version is deployed.
     */
    pauseInstance(name: string, instanceId: string): Promise<WorkflowInstanceStatusChange> {
      return http.result(
        "PATCH",
        http.acct(`/workflows/${enc(name)}/instances/${enc(instanceId)}/status`),
        { json: { status: "pause" } },
      );
    },

    /** The same call with `{ status: "resume" }`: a paused instance carries on. */
    resumeInstance(name: string, instanceId: string): Promise<WorkflowInstanceStatusChange> {
      return http.result(
        "PATCH",
        http.acct(`/workflows/${enc(name)}/instances/${enc(instanceId)}/status`),
        { json: { status: "resume" } },
      );
    },

    /**
     * `DELETE /workflows/{workflow_name}`: the Workflow and its instances.
     * Deleting the Worker that runs a Workflow leaves the Workflow in place,
     * so whoever removes the Worker for good deletes its Workflow too.
     * Throws `CloudflareApiError` (404 when absent).
     */
    deleteWorkflow(name: string): Promise<unknown> {
      return http.result("DELETE", http.acct(`/workflows/${enc(name)}`));
    },
  };
}
