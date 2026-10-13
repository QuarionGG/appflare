import { ACC, TOKEN } from "../../test/fake-account";

/**
 * Test-only stateful fake of the Cloudflare API calls the pause and resume
 * jobs make: an account with several Workers (deployments, versions as
 * `GET .../versions/{id}` describes them, Workers Logs settings), Durable
 * Object namespaces, container applications, queues and Workflows with
 * their instances.
 */

export interface FakeVersion {
  annotations?: Record<string, string>;
  /** `resources.script.handlers`. */
  handlers: string[];
  /** `resources.script.named_handlers`. */
  named: Array<{ name: string; handlers: string[] }>;
  bindings: Array<Record<string, unknown>>;
  /** `resources.script_runtime` (compatibility date and flags). */
  runtime?: Record<string, unknown>;
}

export interface FakeScript {
  /** Newest first; the first serves. */
  deployments: Array<{ id: string; versions: Array<{ version_id: string; percentage: number }> }>;
  versions: Map<string, FakeVersion>;
  observability: Record<string, unknown> | null;
}

export type InstanceStatus =
  | "queued"
  | "running"
  | "waiting"
  | "paused"
  | "complete"
  | "errored"
  | "waitingForPause";

export interface PauseWorld {
  scripts: Map<string, FakeScript>;
  namespaces: Array<{ id: string; script: string; class: string }>;
  /** Container applications; `free` on Workers Free (401), `refused` without the permission (403). */
  containers:
    | Array<{ id: string; name: string; namespaceId: string; maxInstances: number }>
    | "free"
    | "refused";
  queues: Map<string, { name: string; paused: boolean }>;
  /** Instances by Workflow name. */
  workflows: Map<string, Map<string, InstanceStatus>>;
  /** Each stand-in upload: the Worker, its metadata and its code. */
  uploads: Array<{ script: string; metadata: Record<string, unknown>; source: string }>;
  /** Each deployment: the Worker and the version. */
  deploys: Array<{ script: string; versionId: string; force: boolean }>;
  /** The most stand-in uploads that were under way at the same time. */
  mostUploadsAtOnce: number;
  calls: string[];
  /** `METHOD /path` keys answered once with this status instead of doing the work. */
  failOnce: Map<string, number>;
  /** `METHOD /path` keys answered with this status every time. */
  failAlways: Map<string, number>;
}

export function servingOf(world: PauseWorld, script: string): string | undefined {
  return world.scripts.get(script)?.deployments[0]?.versions[0]?.version_id;
}

/** A Worker serving `versionId`, described by `version`. */
export function fakeScript(
  versionId: string,
  version: Partial<FakeVersion> = {},
  observability: Record<string, unknown> | null = { enabled: true, head_sampling_rate: 1 },
): FakeScript {
  return {
    deployments: [
      { id: `dep-${versionId}`, versions: [{ version_id: versionId, percentage: 100 }] },
    ],
    versions: new Map([[versionId, { handlers: ["fetch"], named: [], bindings: [], ...version }]]),
    observability,
  };
}

export function fakePauseAccount(over: Partial<PauseWorld> = {}) {
  const world: PauseWorld = {
    scripts: new Map(),
    namespaces: [],
    containers: "free",
    queues: new Map(),
    workflows: new Map(),
    uploads: [],
    mostUploadsAtOnce: 0,
    deploys: [],
    calls: [],
    failOnce: new Map(),
    failAlways: new Map(),
    ...over,
  };
  let uploaded = 0;
  let uploading = 0;
  const ok = (result: unknown, extra: Record<string, unknown> = {}) =>
    Response.json({ success: true, errors: [], messages: [], result, ...extra });
  const fail = (status: number, message: string, code = 10000) =>
    Response.json({ success: false, errors: [{ code, message }], messages: [] }, { status });

  async function answer(request: Request): Promise<Response> {
    const url = new URL(request.url);
    const path = url.pathname.replace(`/client/v4/accounts/${ACC}`, "");
    const key = `${request.method} ${path}`;
    world.calls.push(key);
    if (request.headers.get("authorization") !== `Bearer ${TOKEN}`) return fail(403, "auth");
    const once = world.failOnce.get(key);
    if (once !== undefined) {
      world.failOnce.delete(key);
      return fail(once, "injected failure");
    }
    const always = world.failAlways.get(key);
    if (always !== undefined) return fail(always, "injected failure");

    if (key === "GET /workers/durable_objects/namespaces") return ok(world.namespaces);
    if (key === "GET /containers/applications") {
      if (world.containers === "free") {
        return fail(401, "Deploying containers requires the Workers Paid plan.", 1000);
      }
      if (world.containers === "refused") return fail(403, "Authentication error", 10000);
      return ok(
        world.containers.map((c) => ({
          id: c.id,
          name: c.name,
          max_instances: c.maxInstances,
          durable_objects: { namespace_id: c.namespaceId },
        })),
      );
    }
    let m = /^PATCH \/containers\/applications\/([^/]+)$/.exec(key);
    if (m?.[1] !== undefined) {
      const app = Array.isArray(world.containers)
        ? world.containers.find((c) => c.id === m?.[1])
        : undefined;
      if (app === undefined) return fail(404, "application not found");
      const body = (await request.json()) as { max_instances: number };
      app.maxInstances = body.max_instances;
      return ok({ id: app.id, name: app.name, max_instances: app.maxInstances });
    }
    if (key === "GET /queues") {
      return ok([...world.queues].map(([id, q]) => ({ queue_id: id, queue_name: q.name })));
    }
    m = /^(GET|PATCH) \/queues\/([^/]+)$/.exec(key);
    if (m?.[2] !== undefined) {
      const queue = world.queues.get(m[2]);
      if (queue === undefined) return fail(404, "queue not found");
      if (m[1] === "PATCH") {
        const body = (await request.json()) as {
          queue_name: string;
          settings: { delivery_paused: boolean };
        };
        if (body.queue_name !== queue.name) return fail(400, "queue_name does not match");
        queue.paused = body.settings.delivery_paused;
      }
      return ok({
        queue_id: m[2],
        queue_name: queue.name,
        settings: queue.paused ? { delivery_paused: true } : {},
      });
    }
    m = /^GET \/workflows\/([^/]+)$/.exec(key);
    if (m?.[1] !== undefined) {
      const instances = world.workflows.get(m[1]);
      if (instances === undefined) {
        return fail(404, "workflows.api.error.workflow.not_found", 10200);
      }
      const counts: Record<string, number> = { queued: 0, running: 0, waiting: 0, paused: 0 };
      for (const status of instances.values()) counts[status] = (counts[status] ?? 0) + 1;
      return ok({ id: `wf-${m[1]}`, name: m[1], instances: counts });
    }
    m = /^GET \/workflows\/([^/]+)\/instances$/.exec(key);
    if (m?.[1] !== undefined) {
      const instances = world.workflows.get(m[1]);
      if (instances === undefined) return fail(404, "not found", 10200);
      const status = url.searchParams.get("status");
      return ok(
        [...instances]
          .filter(([, s]) => status === null || s === status)
          .map(([id, s]) => ({ id, status: s })),
      );
    }
    m = /^PATCH \/workflows\/([^/]+)\/instances\/([^/]+)\/status$/.exec(key);
    if (m?.[1] !== undefined && m[2] !== undefined) {
      const instances = world.workflows.get(m[1]);
      const status = instances?.get(m[2]);
      if (instances === undefined || status === undefined) return fail(404, "instance not found");
      const body = (await request.json()) as { status: "pause" | "resume" };
      if (body.status === "pause" && ["queued", "running", "waiting"].includes(status)) {
        instances.set(m[2], "paused");
        return ok({ status: "paused" });
      }
      if (body.status === "resume" && status === "paused") {
        instances.set(m[2], "running");
        return ok({ status: "running" });
      }
      return fail(400, `Cannot ${body.status} an instance that is ${status}`);
    }
    m = /^(GET|POST) \/workers\/scripts\/([^/]+)\/(deployments|versions|script-settings)$/.exec(
      key,
    );
    if (m?.[2] !== undefined) {
      const name = m[2];
      const script = world.scripts.get(name);
      if (script === undefined) return fail(404, "This Worker does not exist on your account.");
      if (m[3] === "script-settings") return ok({ observability: script.observability });
      if (key.startsWith("GET") && m[3] === "deployments") {
        return ok({ deployments: script.deployments });
      }
      if (m[3] === "deployments") {
        const body = (await request.json()) as {
          versions: Array<{ version_id: string; percentage: number }>;
        };
        const versionId = body.versions[0]?.version_id ?? "";
        if (!script.versions.has(versionId)) return fail(404, "version not found");
        script.deployments.unshift({
          id: `dep-${script.deployments.length + 1}`,
          versions: body.versions,
        });
        world.deploys.push({
          script: name,
          versionId,
          force: url.searchParams.get("force") === "true",
        });
        return ok(script.deployments[0]);
      }
      if (m[3] === "versions" && key.startsWith("POST")) {
        // An upload takes a while, as on Cloudflare: overlapping ones are counted.
        uploading += 1;
        world.mostUploadsAtOnce = Math.max(world.mostUploadsAtOnce, uploading);
        await new Promise((resolve) => setTimeout(resolve, 5));
        uploading -= 1;
        const form = await request.formData();
        const metadata = JSON.parse(String(form.get("metadata"))) as Record<string, unknown>;
        const main = String(metadata.main_module);
        const part = form.get(main);
        const source = part instanceof File ? await part.text() : String(part);
        uploaded += 1;
        const id = `standin-${name}-${uploaded}`;
        world.uploads.push({ script: name, metadata, source });
        script.versions.set(id, {
          annotations: metadata.annotations as Record<string, string>,
          handlers: ["fetch", "scheduled", "queue"],
          named: [],
          bindings: [],
        });
        return ok({ id, number: script.versions.size });
      }
    }
    m = /^GET \/workers\/scripts\/([^/]+)\/versions\/([^/]+)$/.exec(key);
    if (m?.[1] !== undefined && m[2] !== undefined) {
      const version = world.scripts.get(m[1])?.versions.get(m[2]);
      if (version === undefined) return fail(404, "version not found");
      return ok({
        id: m[2],
        ...(version.annotations === undefined ? {} : { annotations: version.annotations }),
        resources: {
          script: { handlers: version.handlers, named_handlers: version.named },
          ...(version.runtime === undefined ? {} : { script_runtime: version.runtime }),
          bindings: version.bindings,
        },
      });
    }
    return fail(404, `no route ${key}`);
  }

  const fetch = async (input: string, init?: RequestInit): Promise<Response> => {
    if (input.startsWith("https://api.cloudflare.com/")) return answer(new Request(input, init));
    return new Response("not found", { status: 404 });
  };
  return { world, fetch };
}
