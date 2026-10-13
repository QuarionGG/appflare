import { describe, expect, it } from "vitest";
import {
  isStandIn,
  STAND_IN_COMPATIBILITY_DATE,
  STAND_IN_MODULE,
  standInFactsOf,
  standInSource,
  standInUpload,
  versionExportsOf,
} from "./stand-in";

/**
 * The stand-in a paused Worker serves: it exports what the serving version
 * exports, as Cloudflare describes that version, and keeps its bindings and
 * its compatibility settings.
 */

/** `GET .../versions/{id}` of a Worker with a Durable Object, an entrypoint and a Workflow (as seen live). */
const SERVING = {
  id: "v1",
  resources: {
    script: {
      handlers: ["fetch", "queue", "email"],
      named_handlers: [
        { name: "Ticker", handlers: ["class"] },
        { name: "Api", handlers: ["fetch", "ping", "queue"] },
        { name: "Flow", handlers: ["__workflow_entrypoint", "run"] },
      ],
    },
    script_runtime: {
      migration_tag: "v1",
      compatibility_date: "2025-04-01",
      compatibility_flags: ["nodejs_compat"],
      usage_model: "standard",
    },
    bindings: [
      { class_name: "Flow", name: "FLOW", type: "workflow", workflow_name: "flow" },
      {
        class_name: "Other",
        name: "OTHER",
        type: "workflow",
        workflow_name: "x",
        script_name: "x",
      },
      { name: "Q", queue_name: "q", type: "queue" },
      { name: "S1", type: "secret_text" },
      {
        class_name: "Ticker",
        name: "TICKER",
        namespace_id: "ns",
        type: "durable_object_namespace",
      },
      { name: "V1", text: "hello", type: "plain_text" },
      { name: "ASSETS", type: "assets" },
    ],
  },
};

function facts(over: Partial<Parameters<typeof standInFactsOf>[0]> = {}) {
  return standInFactsOf({
    version: versionExportsOf(SERVING),
    namespaceClasses: ["Ticker", "Archived"],
    containers: [],
    exports: null,
    ...over,
  });
}

describe("versionExportsOf", () => {
  it("keeps of each binding only what the stand-in reads, never a var's value", () => {
    const read = versionExportsOf(SERVING);
    expect(read.bindings).toContainEqual({ type: "plain_text" });
    expect(JSON.stringify(read)).not.toContain("hello");
  });

  it("reads the version's compatibility date and flags, with a date of its own when none is given", () => {
    expect(versionExportsOf(SERVING).compatibility).toEqual({
      date: "2025-04-01",
      flags: ["nodejs_compat"],
    });
    expect(versionExportsOf({ resources: {} }).compatibility).toEqual({
      date: STAND_IN_COMPATIBILITY_DATE,
      flags: [],
    });
  });
});

describe("standInFactsOf", () => {
  it("exports every class and entrypoint the serving version exports, and keeps every binding but assets", () => {
    expect(facts()).toEqual({
      handlers: ["fetch", "queue", "email"],
      // A namespace the account lists for the Worker is exported too.
      durableObjects: ["Archived", "Ticker"],
      entrypoints: [{ name: "Api", methods: ["fetch", "ping", "queue"] }],
      workflows: ["Flow"],
      bindingTypes: ["durable_object_namespace", "plain_text", "queue", "secret_text", "workflow"],
      containers: [],
      exports: null,
      compatibility: { date: "2025-04-01", flags: ["nodejs_compat"] },
    });
  });

  it("adds the Durable Objects the app declares and the container classes", () => {
    const f = facts({
      exports: {
        Declared: { type: "durable-object" },
        Api: { type: "worker" },
      },
      containers: [{ name: "box", class_name: "Box" }],
    });
    expect(f.durableObjects).toEqual(["Archived", "Box", "Declared", "Ticker"]);
    expect(f.entrypoints.map((e) => e.name)).toEqual(["Api"]);
  });
});

describe("standInSource", () => {
  it("answers with the paused page, puts alarms and messages off, and throws from methods", () => {
    const source = standInSource(facts());
    expect(source).toContain(
      'import { DurableObject as __appflareDurableObject, WorkerEntrypoint as __appflareWorkerEntrypoint, WorkflowEntrypoint as __appflareWorkflowEntrypoint } from "cloudflare:workers";',
    );
    expect(source).toContain("This app is paused by its owner");
    expect(source).toContain("status: 503");
    expect(source).toContain(
      "await this.ctx.storage.setAlarm(Date.now() + __appflarePUT_OFF_SECONDS * 1000);",
    );
    expect(source).toContain('ws.close(1012, "Paused");');
    expect(source).toContain("export class Ticker extends __appflarePausedObject {}");
    expect(source).toContain("export class Archived extends __appflarePausedObject {}");
    expect(source).toContain('  async "ping"() {\n    __appflareRefuse();\n  }');
    expect(source).toContain("export class Flow extends __appflareWorkflowEntrypoint {");
    expect(source).toContain("batch.retryAll({ delaySeconds: __appflarePUT_OFF_SECONDS });");
    expect(source).toContain("async scheduled() {}");
    // Mail to a paused app is refused with the same words.
    expect(source).toContain("message.setReject(__appflareMESSAGE);");
  });

  it("exports classes named like the runtime's or like its own helpers without a clash", () => {
    const source = standInSource(
      facts({ namespaceClasses: ["PausedObject", "DurableObject", "WorkerEntrypoint"] }),
    );
    expect(source).toContain("export class PausedObject extends __appflarePausedObject {}");
    expect(source).toContain("export class DurableObject extends __appflarePausedObject {}");
    expect(source).toContain("export class WorkerEntrypoint extends __appflarePausedObject {}");
    // The stand-in's own declarations are the only ones under its prefix.
    const own = [...source.matchAll(/^(?:class|function|const) (\w+)/gm)].map((m) => m[1]);
    expect(own.every((name) => name?.startsWith("__appflare"))).toBe(true);
  });

  it("refuses a class named with the stand-in's own prefix", () => {
    expect(() => standInSource(facts({ namespaceClasses: ["__appflarePaused"] }))).toThrow(
      'the Worker exports "__appflarePaused", a name the stand-in keeps for itself',
    );
  });

  it("quotes method names, so no name can change the code", () => {
    const source = standInSource(
      facts({
        version: {
          handlers: ["fetch"],
          named: [{ name: "Api", handlers: ['x"(){}; globalThis.y = 1; //'] }],
          bindings: [],
          compatibility: { date: STAND_IN_COMPATIBILITY_DATE, flags: [] },
        },
        namespaceClasses: [],
      }),
    );
    expect(source).toContain('async "x\\"(){}; globalThis.y = 1; //"() {');
  });

  it("refuses a class name it could not export", () => {
    expect(() => standInSource(facts({ namespaceClasses: ["Not a name"] }))).toThrow(
      'the Worker exports "Not a name", which is not a name a stand-in can export',
    );
  });
});

describe("standInUpload", () => {
  it("keeps the bindings, declared exports and compatibility settings, and adds no migrations", () => {
    const upload = standInUpload(
      facts({
        exports: { Ticker: { type: "durable-object" } },
        containers: [{ name: "box", class_name: "Ticker" }],
      }),
    );
    expect(upload.metadata).toEqual({
      main_module: STAND_IN_MODULE,
      // The app's own, so a binding that needs a flag still validates.
      compatibility_date: "2025-04-01",
      compatibility_flags: ["nodejs_compat"],
      bindings: [],
      keep_bindings: ["durable_object_namespace", "plain_text", "queue", "secret_text", "workflow"],
      annotations: { "workers/message": "Appflare: paused", "workers/tag": "appflare-paused" },
      exports: { Ticker: { type: "durable-object" } },
      containers: [{ name: "box", class_name: "Ticker" }],
    });
    expect(upload.modules).toHaveLength(1);
    expect(upload.modules[0]).toMatchObject({
      name: STAND_IN_MODULE,
      contentType: "application/javascript+module",
    });
    expect(isStandIn({ annotations: upload.metadata.annotations })).toBe(true);
    expect(isStandIn({ annotations: { "workers/tag": "v2" } })).toBe(false);
  });
});
