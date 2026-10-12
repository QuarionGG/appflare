import { describe, expect, it } from "vitest";
import { createClient } from "./client";
import { type FakeHandler, type FakeResponseSpec, makeFakeFetch } from "./fake-fetch";

/** The calls that pause and resume an app's parts, and turn its Workers Logs on or off. */

const ACCOUNT = "acc-123";
const A = `https://api.cloudflare.com/client/v4/accounts/${ACCOUNT}`;

function make(spec?: FakeResponseSpec | FakeHandler) {
  const fake = makeFakeFetch(spec);
  const client = createClient({ accountId: ACCOUNT, token: "t", fetch: fake.fetch });
  return { fake, client };
}

describe("script settings", () => {
  it("getScriptSettings -> GET /workers/scripts/{name}/script-settings", async () => {
    // The real shape for a Worker with Workers Logs on.
    const observability = {
      enabled: true,
      head_sampling_rate: 1,
      redact_query_string: false,
      logs: { enabled: true, head_sampling_rate: 1, persist: true, invocation_logs: true },
      traces: { enabled: false, persist: true, head_sampling_rate: 1 },
    };
    const { fake, client } = make({
      result: { logpush: false, tags: null, tail_consumers: null, observability },
    });
    const settings = await client.workers.getScriptSettings("my app");
    expect(settings.observability?.logs?.enabled).toBe(true);
    expect(fake.last().method).toBe("GET");
    expect(fake.last().url).toBe(`${A}/workers/scripts/my%20app/script-settings`);
  });

  it("setObservability -> PATCH with { observability: { enabled } } and nothing else", async () => {
    const { fake, client } = make({ result: { observability: { enabled: true } } });
    await client.workers.setObservability("cut", true);
    const call = fake.last();
    expect(call.method).toBe("PATCH");
    expect(call.url).toBe(`${A}/workers/scripts/cut/script-settings`);
    expect(call.headers.get("content-type")).toBe("application/json");
    expect(await call.request.json()).toEqual({ observability: { enabled: true } });
    await client.workers.setObservability("cut", false);
    expect(await fake.last().request.json()).toEqual({ observability: { enabled: false } });
  });

  it("setObservabilitySettings -> PATCH with { observability: <the whole block> } and nothing else", async () => {
    const block = {
      enabled: true,
      head_sampling_rate: 0.1,
      logs: { enabled: false, invocation_logs: true, head_sampling_rate: 1 },
      traces: { enabled: true, persist: true, head_sampling_rate: 0.5 },
    };
    const { fake, client } = make({ result: { observability: block } });
    expect((await client.workers.setObservabilitySettings("my app", block)).observability).toEqual(
      block,
    );
    const call = fake.last();
    expect(call.method).toBe("PATCH");
    expect(call.url).toBe(`${A}/workers/scripts/my%20app/script-settings`);
    expect(call.headers.get("content-type")).toBe("application/json");
    expect(await call.request.json()).toEqual({ observability: block });
  });
});

describe("containers max_instances", () => {
  it("setMaxInstances -> PATCH /containers/applications/{id} with max_instances alone", async () => {
    const { fake, client } = make({ result: { id: "app1", name: "a", max_instances: 0 } });
    expect((await client.containers.setMaxInstances("app1", 0)).max_instances).toBe(0);
    expect(fake.last().method).toBe("PATCH");
    expect(fake.last().url).toBe(`${A}/containers/applications/app1`);
    expect(await fake.last().request.json()).toEqual({ max_instances: 0 });
  });
});

describe("queue delivery", () => {
  it("getQueue -> GET /queues/{id}, with its settings", async () => {
    const { fake, client } = make({
      result: { queue_id: "q1", queue_name: "jobs", settings: { delivery_paused: true } },
    });
    expect((await client.queues.getQueue("q1")).settings?.delivery_paused).toBe(true);
    expect(fake.last().url).toBe(`${A}/queues/q1`);
  });

  it("setDeliveryPaused -> PATCH /queues/{id} with the name and settings.delivery_paused", async () => {
    const { fake, client } = make({ result: { queue_id: "q1", queue_name: "jobs" } });
    await client.queues.setDeliveryPaused({ queueId: "q1", queueName: "jobs", paused: true });
    expect(fake.last().method).toBe("PATCH");
    expect(fake.last().url).toBe(`${A}/queues/q1`);
    expect(await fake.last().request.json()).toEqual({
      queue_name: "jobs",
      settings: { delivery_paused: true },
    });
    await client.queues.setDeliveryPaused({ queueId: "q1", queueName: "jobs", paused: false });
    expect(await fake.last().request.json()).toEqual({
      queue_name: "jobs",
      settings: { delivery_paused: false },
    });
  });
});

describe("workflow instances", () => {
  it("listInstances follows the cursor until a page has none", async () => {
    const { fake, client } = make((req) => {
      const cursor = req.query.get("cursor");
      return cursor === null
        ? {
            result: [{ id: "i1", status: "running" }],
            result_info: { count: 1, cursor: "AQAA-next", per_page: 100, total_count: 2 },
          }
        : {
            result: [{ id: "i2", status: "running" }],
            result_info: { count: 1, per_page: 100, total_count: 2 },
          };
    });
    const instances = await client.workflows.listInstances("jobs flow", { status: "running" });
    expect(instances.map((i) => i.id)).toEqual(["i1", "i2"]);
    expect(fake.calls).toHaveLength(2);
    expect(fake.calls[0]?.path).toBe(
      `/client/v4/accounts/${ACCOUNT}/workflows/jobs%20flow/instances`,
    );
    expect(fake.calls[0]?.query.get("status")).toBe("running");
    expect(fake.calls[0]?.query.get("per_page")).toBe("100");
    expect(fake.calls[0]?.query.has("cursor")).toBe(false);
    expect(fake.calls[1]?.query.get("cursor")).toBe("AQAA-next");
  });

  it("listInstances leaves the status out when none is asked for", async () => {
    const { fake, client } = make({ result: [], result_info: { count: 0, per_page: 100 } });
    expect(await client.workflows.listInstances("jobs")).toEqual([]);
    expect(fake.last().query.has("status")).toBe(false);
  });

  it("pauseInstance and resumeInstance -> PATCH .../instances/{id}/status", async () => {
    const { fake, client } = make({
      result: { status: "waitingForPause", timestamp: "2026-10-12T10:00:00Z" },
    });
    expect((await client.workflows.pauseInstance("jobs", "i1")).status).toBe("waitingForPause");
    expect(fake.last().method).toBe("PATCH");
    expect(fake.last().url).toBe(`${A}/workflows/jobs/instances/i1/status`);
    expect(await fake.last().request.json()).toEqual({ status: "pause" });
    await client.workflows.resumeInstance("jobs", "i1");
    expect(await fake.last().request.json()).toEqual({ status: "resume" });
  });
});
