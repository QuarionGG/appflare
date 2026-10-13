import type { VersionMetadata, WorkerModule } from "@appflare/cf-api";
import { durableObjectExports, type WorkerExports } from "@appflare/schema";
import { JobError } from "../errors";

/**
 * The stand-in a paused app's Workers serve: a version of each Worker that
 * does nothing that costs money, deployed at 100% in place of the app's own
 * code, so the app stops within seconds and Resume brings the recorded
 * version back with one deployment.
 *
 * It is uploaded with `keep_bindings` naming every binding type the serving
 * version has (its secrets included), so the Worker keeps every binding, and
 * with no Durable Object migrations, so no class or its data is touched. It
 * exports every class the serving version exports, under the same names,
 * since Cloudflare refuses a version that drops a class a Durable Object
 * namespace or a binding needs:
 *
 * - each Durable Object class answers requests with the paused page,
 *   reschedules any alarm an hour out (an alarm loop stops costing, and the
 *   object keeps its alarm for when the app runs again), and closes a
 *   hibernating WebSocket that sends a message with 1012 "Paused";
 * - each named entrypoint answers requests with the paused page, and each of
 *   its methods throws;
 * - each Workflow class fails a new instance at once (running instances stay
 *   on the version they started on, and the pause job pauses them);
 * - the default export answers every request with a 503 "This app is paused
 *   by its owner" page, does nothing on its cron triggers, and asks for its
 *   queue messages again an hour later (delivery is paused too, so this only
 *   covers the seconds before that takes effect).
 *
 * What the serving version exports comes from Cloudflare's own description
 * of it (`resources.script` of `GET .../versions/{id}`: `handlers` and
 * `named_handlers`, which name each class and entrypoint with its methods),
 * completed with the account's Durable Object namespaces and the app's
 * declared exports.
 */

/** The `workers/tag` annotation of a stand-in version. */
export const STAND_IN_TAG = "appflare-paused";

/** What a visitor of a paused app reads. */
export const PAUSED_MESSAGE = "This app is paused by its owner";

/** The stand-in's one module. */
export const STAND_IN_MODULE = "appflare-paused.mjs";

/**
 * The stand-in's compatibility date when the serving version names none. A
 * stand-in otherwise carries the app's own date and flags, so a binding that
 * needs one of them still validates.
 */
export const STAND_IN_COMPATIBILITY_DATE = "2026-09-01";

/** How long a Durable Object alarm, or a queue message, is put off. */
export const PUT_OFF_SECONDS = 3_600;

/** Binding types the stand-in never keeps: static assets would answer in its place. */
const DROPPED_BINDING_TYPES: ReadonlySet<string> = new Set(["assets"]);

/** What the stand-in of one Worker needs to know about the version it replaces. */
export interface StandInFacts {
  /** Handlers of the default export (`fetch`, `queue`, `scheduled`, `email`, ...). */
  handlers: string[];
  /** Durable Object classes the Worker implements. */
  durableObjects: string[];
  /** Named entrypoints, each with its handlers and methods. */
  entrypoints: Array<{ name: string; methods: string[] }>;
  /** Workflow classes the Worker implements. */
  workflows: string[];
  /** Binding types of the serving version, kept as they are. */
  bindingTypes: string[];
  /** Container applications behind its Durable Object classes, as wrangler names them. */
  containers: Array<{ name: string; class_name: string }>;
  /**
   * The Worker's declared `exports` (from the app's manifest), uploaded as
   * they are so its declared Durable Objects stay declared.
   */
  exports: WorkerExports | null;
  /** The serving version's compatibility date and flags. */
  compatibility: { date: string; flags: string[] };
}

/** One entry of `resources.script.named_handlers`. */
interface NamedHandler {
  name: string;
  handlers: string[];
}

function stringArray(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((v): v is string => typeof v === "string") : [];
}

function record(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

/** What the serving version exports, from `GET .../versions/{id}`. */
export function versionExportsOf(version: { resources?: Record<string, unknown> }): {
  handlers: string[];
  named: NamedHandler[];
  bindings: Array<Record<string, unknown>>;
  compatibility: { date: string; flags: string[] };
} {
  const script = record(version.resources?.script);
  const runtime = record(version.resources?.script_runtime);
  const date =
    typeof runtime?.compatibility_date === "string" && runtime.compatibility_date !== ""
      ? runtime.compatibility_date
      : STAND_IN_COMPATIBILITY_DATE;
  const named: NamedHandler[] = [];
  const list = script?.named_handlers;
  if (Array.isArray(list)) {
    for (const entry of list) {
      const e = record(entry);
      if (e !== null && typeof e.name === "string" && e.name.length > 0) {
        named.push({ name: e.name, handlers: stringArray(e.handlers) });
      }
    }
  }
  // Only what the stand-in reads of each binding: never a var's value.
  const bindings = Array.isArray(version.resources?.bindings)
    ? (version.resources.bindings as unknown[]).flatMap((b) => {
        const r = record(b);
        if (r === null || typeof r.type !== "string") return [];
        return [
          {
            type: r.type,
            ...(typeof r.class_name === "string" ? { class_name: r.class_name } : {}),
            ...(typeof r.script_name === "string" ? { script_name: r.script_name } : {}),
          },
        ];
      })
    : [];
  return {
    handlers: stringArray(script?.handlers),
    named,
    bindings,
    compatibility: { date, flags: stringArray(runtime?.compatibility_flags) },
  };
}

/** The Workflow handler names Cloudflare lists for a `WorkflowEntrypoint` class. */
const WORKFLOW_MARK = "__workflow_entrypoint";

/**
 * Everything the stand-in of `scriptName` exports and keeps, from the
 * serving version (`versionExportsOf`), the Durable Object namespaces the
 * account says the Worker implements, the container applications behind
 * them, and the app's declared exports for it.
 */
export function standInFactsOf(input: {
  version: ReturnType<typeof versionExportsOf>;
  /** Classes of the account's Durable Object namespaces whose `script` is this Worker. */
  namespaceClasses: readonly string[];
  containers: ReadonlyArray<{ name: string; class_name: string }>;
  exports: WorkerExports | null;
}): StandInFacts {
  const durableObjects = new Set<string>();
  const workflows = new Set<string>();
  const entrypoints = new Map<string, Set<string>>();
  for (const entry of input.version.named) {
    if (entry.handlers.includes("class")) durableObjects.add(entry.name);
    else if (entry.handlers.includes(WORKFLOW_MARK)) workflows.add(entry.name);
    else entrypoints.set(entry.name, new Set(entry.handlers));
  }
  for (const name of input.namespaceClasses) durableObjects.add(name);
  for (const name of Object.keys(durableObjectExports(input.exports))) durableObjects.add(name);
  for (const c of input.containers) durableObjects.add(c.class_name);
  for (const b of input.version.bindings) {
    // A Workflow this Worker runs: its binding names no other script.
    if (b.type === "workflow" && typeof b.class_name === "string" && b.script_name == null) {
      workflows.add(b.class_name);
    }
  }
  for (const name of [...durableObjects, ...workflows]) entrypoints.delete(name);
  for (const name of durableObjects) workflows.delete(name);
  const bindingTypes = [
    ...new Set(
      input.version.bindings
        .map((b) => b.type)
        .filter((t): t is string => typeof t === "string" && !DROPPED_BINDING_TYPES.has(t)),
    ),
  ].sort();
  return {
    handlers: input.version.handlers,
    durableObjects: [...durableObjects].sort(),
    entrypoints: [...entrypoints]
      .map(([name, methods]) => ({ name, methods: [...methods].sort() }))
      .sort((a, b) => (a.name < b.name ? -1 : 1)),
    workflows: [...workflows].sort(),
    bindingTypes,
    containers: [...input.containers].sort((a, b) => (a.class_name < b.class_name ? -1 : 1)),
    exports: input.exports !== null && Object.keys(input.exports).length > 0 ? input.exports : null,
    compatibility: input.version.compatibility,
  };
}

const IDENTIFIER = /^[A-Za-z_$][A-Za-z0-9_$]*$/;

/**
 * The stand-in's own names start with this, so no class the app exports can
 * clash with them; a class whose name starts with it is refused.
 */
const OWN_PREFIX = "__appflare";

/** Names that are not methods a stub can define on a class. */
const NOT_METHODS: ReadonlySet<string> = new Set(["constructor", "fetch", "class", WORKFLOW_MARK]);

/** A class name the stand-in exports; anything else would not be a valid export, or would clash. */
function exportName(name: string): string {
  if (!IDENTIFIER.test(name)) {
    throw new JobError(`the Worker exports "${name}", which is not a name a stand-in can export`);
  }
  if (name.startsWith(OWN_PREFIX)) {
    throw new JobError(
      `the Worker exports "${name}", a name the stand-in keeps for itself (it starts with ${OWN_PREFIX})`,
    );
  }
  return name;
}

const PAGE = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex">
<title>${PAUSED_MESSAGE}</title>
<style>
  body { margin: 0; min-height: 100vh; display: grid; place-items: center; font: 14px/1.5 system-ui, sans-serif; color: #1f2937; background: #f9fafb; }
  main { max-width: 28rem; padding: 2rem; text-align: center; }
  h1 { font-size: 1rem; font-weight: 600; margin: 0 0 0.5rem; }
  p { margin: 0; color: #4b5563; }
  @media (prefers-color-scheme: dark) { body { color: #f3f4f6; background: #111827; } p { color: #9ca3af; } }
</style>
</head>
<body>
<main>
<h1>${PAUSED_MESSAGE}</h1>
<p>It is not available right now. Try again later.</p>
</main>
</body>
</html>
`;

/** The stand-in's code for one Worker. Its own names all start with {@link OWN_PREFIX}. */
export function standInSource(facts: StandInFacts): string {
  const P = OWN_PREFIX;
  const lines: string[] = [
    `import { DurableObject as ${P}DurableObject, WorkerEntrypoint as ${P}WorkerEntrypoint, WorkflowEntrypoint as ${P}WorkflowEntrypoint } from "cloudflare:workers";`,
    "",
    `const ${P}MESSAGE = ${JSON.stringify(`${PAUSED_MESSAGE}.`)};`,
    `const ${P}PAGE = ${JSON.stringify(PAGE)};`,
    `const ${P}PUT_OFF_SECONDS = ${PUT_OFF_SECONDS};`,
    "",
    `function ${P}Paused() {`,
    `  return new Response(${P}PAGE, {`,
    "    status: 503,",
    "    headers: {",
    `      "content-type": "text/html; charset=utf-8",`,
    `      "cache-control": "no-store",`,
    `      "retry-after": String(${P}PUT_OFF_SECONDS),`,
    "    },",
    "  });",
    "}",
    "",
    `function ${P}Refuse() {`,
    `  throw new Error(${P}MESSAGE);`,
    "}",
    "",
    `class ${P}PausedObject extends ${P}DurableObject {`,
    "  async fetch() {",
    `    return ${P}Paused();`,
    "  }",
    "  async alarm() {",
    `    await this.ctx.storage.setAlarm(Date.now() + ${P}PUT_OFF_SECONDS * 1000);`,
    "  }",
    "  async webSocketMessage(ws) {",
    `    ws.close(1012, "Paused");`,
    "  }",
    "}",
  ];
  for (const name of facts.durableObjects) {
    lines.push("", `export class ${exportName(name)} extends ${P}PausedObject {}`);
  }
  for (const entry of facts.entrypoints) {
    lines.push(
      "",
      `export class ${exportName(entry.name)} extends ${P}WorkerEntrypoint {`,
      "  async fetch() {",
      `    return ${P}Paused();`,
      "  }",
    );
    for (const method of entry.methods) {
      if (NOT_METHODS.has(method)) continue;
      if (method === "scheduled") lines.push("  async scheduled() {}");
      else if (method === "queue") {
        lines.push(
          "  async queue(batch) {",
          `    batch.retryAll({ delaySeconds: ${P}PUT_OFF_SECONDS });`,
          "  }",
        );
      } else lines.push(`  async ${JSON.stringify(method)}() {`, `    ${P}Refuse();`, "  }");
    }
    lines.push("}");
  }
  // A Workflow instance created while the app is paused runs this and fails
  // for good (an instance keeps the version it started on). Only the
  // Workflow's own cron schedule or the API can create one then: the app's
  // code, which creates them through fetch or cron, does not run.
  for (const name of facts.workflows) {
    lines.push(
      "",
      `export class ${exportName(name)} extends ${P}WorkflowEntrypoint {`,
      "  async run() {",
      `    ${P}Refuse();`,
      "  }",
      "}",
    );
  }
  lines.push(
    "",
    "export default {",
    "  async fetch() {",
    `    return ${P}Paused();`,
    "  },",
    "  async scheduled() {},",
    "  async queue(batch) {",
    `    batch.retryAll({ delaySeconds: ${P}PUT_OFF_SECONDS });`,
    "  },",
  );
  if (facts.handlers.includes("email")) {
    lines.push("  async email(message) {", `    message.setReject(${P}MESSAGE);`, "  },");
  }
  if (facts.handlers.includes("tail")) lines.push("  async tail() {},");
  lines.push("};", "");
  return lines.join("\n");
}

/**
 * The stand-in's upload for one Worker: its metadata and its one module.
 * The Worker's Workers Logs setting is added when it is uploaded
 * (`withCarriedObservability`).
 */
export function standInUpload(facts: StandInFacts): {
  metadata: VersionMetadata;
  modules: WorkerModule[];
} {
  const metadata: VersionMetadata = {
    main_module: STAND_IN_MODULE,
    compatibility_date: facts.compatibility.date,
    compatibility_flags: [...facts.compatibility.flags],
    bindings: [],
    keep_bindings: facts.bindingTypes,
    annotations: {
      "workers/message": "Appflare: paused",
      "workers/tag": STAND_IN_TAG,
    },
  };
  if (facts.exports !== null) metadata.exports = { ...facts.exports };
  if (facts.containers.length > 0) metadata.containers = facts.containers.map((c) => ({ ...c }));
  return {
    metadata,
    modules: [
      {
        name: STAND_IN_MODULE,
        content: new TextEncoder().encode(standInSource(facts)),
        contentType: "application/javascript+module",
      },
    ],
  };
}

/** Whether a version's annotations mark it as a stand-in. */
export function isStandIn(version: { annotations?: Record<string, string> }): boolean {
  return version.annotations?.["workers/tag"] === STAND_IN_TAG;
}
