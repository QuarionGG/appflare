import { reset } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { beforeEach, describe, expect, it } from "vitest";
import { writeAccountPlan } from "../account/plan.server";
import { createDb } from "../db/client";
import { createMigrator } from "../db/migrate";
import { migrations } from "../db/migrations/index";
import { readSettings, SETTING, writeSettings } from "../db/settings";
import type { UsageEvent, UsageEventOutcome } from "../notifications/usage-events.server";
import { ACC, TOKEN } from "../test/fake-account";
import { fakeCloudflare } from "../test/fake-cloudflare";
import { HOUR, LEVEL_PRODUCTS } from "./collect";
import { WATCHED_APPS_SQL } from "./collect.server";
import {
  type AnswerRow,
  answerRow,
  fakeGraphQL,
  RECORDED,
  RECORDED_IDS,
  RECORDED_NOW,
} from "./collect-fixtures";
import { spendSnapshotSchema } from "./overview.server";
import type { PauseRequest } from "./pause.server";
import { PauseActionError } from "./pause.server";
import { listActivity, recordActivity } from "./store/activity.server";
import { createAlertRule } from "./store/alert-rules.server";
import { writeAppSpendSettings } from "./store/app-settings.server";
import { writeSpendDefaults } from "./store/defaults.server";
import { readUsage, recordHourlyUsage } from "./store/series.server";
import { readUsageState } from "./store/usage-state.server";
import { recentRows, type SpendWatchDeps, spendWatchLog, watchSpend } from "./watcher.server";
import { HISTORY_KEY } from "./watcher-history.server";
import type { ShardInput } from "./watcher-shard.server";
import { readSpendWatchStatus } from "./watcher-status";
import { createSpendWatcherUnits } from "./watcher-unit";

const NOW = RECORDED_NOW * 1000; // 2026-10-12 16:50 UTC
const HOUR_NOW = Math.floor(RECORDED_NOW / HOUR) * HOUR;
const DAY_MS = 86_400_000;
const db = () => createDb(env.DB);
const A = `/accounts/${ACC}`;

beforeEach(async () => {
  await reset();
  await createMigrator(migrations).ensure(env.DB);
  await writeSettings(db(), { [SETTING.accountId]: ACC });
});

async function seedApp(
  id: string,
  opts: {
    worker: string;
    installedAt?: number;
    resources?: Array<{ kind: string; name: string; cfId?: string | null }>;
    manifest?: unknown;
  },
) {
  await env.DB.prepare(
    `INSERT INTO installs (id, app_slug, worker_name, instance_name, catalog_version, artifact_url,
       status, manifest_json, installed_at, updated_at)
     VALUES (?1, ?2, ?2, ?2, '1.0.0', 'https://artifacts.test/x.zip', 'installed', ?3, ?4, ?4)`,
  )
    .bind(
      id,
      opts.worker,
      JSON.stringify(opts.manifest ?? { worker: { bindings: [] } }),
      opts.installedAt ?? NOW - 30 * DAY_MS,
    )
    .run();
  for (const [i, r] of [
    { kind: "worker", name: opts.worker },
    ...(opts.resources ?? []),
  ].entries()) {
    await env.DB.prepare(
      `INSERT INTO resources (id, install_id, kind, binding, name, cf_id, created_at)
       VALUES (?1, ?2, ?3, NULL, ?4, ?5, 1)`,
    )
      .bind(`${id}-r${i}`, id, r.kind, r.name, "cfId" in r ? (r.cfId ?? null) : null)
      .run();
  }
}

/** The recorded app: a Worker, a D1 database, a KV namespace and a Durable Object namespace. */
async function seedRecordedApp(id = "notes", installedAt?: number) {
  await seedApp(id, {
    worker: RECORDED_IDS.worker,
    ...(installedAt === undefined ? {} : { installedAt }),
    resources: [
      { kind: "d1", name: "notes-db", cfId: RECORDED_IDS.d1 },
      { kind: "kv", name: "notes-kv", cfId: RECORDED_IDS.kv },
    ],
  });
}

function world(
  answers: Readonly<Record<string, readonly AnswerRow[]>>,
  opts: {
    namespaces?: Array<{ id: string; script: string }>;
    refuse?: { message: string; code?: string; datasets?: readonly string[] };
  } = {},
) {
  const rest = fakeCloudflare({
    [`GET ${A}/workers/durable_objects/namespaces`]: {
      result: (
        opts.namespaces ?? [{ id: RECORDED_IDS.durableObject, script: RECORDED_IDS.worker }]
      ).map((n) => ({
        ...n,
        class: "Store",
      })),
    },
    [`GET ${A}/containers/applications`]: { result: [] },
  });
  const graphql = fakeGraphQL(answers, rest.fetch, opts.refuse);
  const events: UsageEvent[] = [];
  const pauses: PauseRequest[] = [];
  let refusePauses = new Set<string>();
  const deps = (now = NOW): SpendWatchDeps => ({
    now: () => now,
    fetch: graphql.fetch,
    emit: async (_env, event): Promise<UsageEventOutcome> => {
      events.push(event);
      return { status: "skipped", reason: "no-channel" };
    },
    startPause: async (_env, request) => {
      if (refusePauses.has(request.installId)) {
        throw new PauseActionError("Another job of this app is queued or running.");
      }
      pauses.push(request);
      return { jobId: `job-${pauses.length}` };
    },
  });
  return {
    deps,
    events,
    pauses,
    graphql: graphql.sent,
    rest: rest.calls,
    refusePause: (ids: string[]) => {
      refusePauses = new Set(ids);
    },
  };
}

const watchEnv = () => ({ ...env, CF_API_TOKEN: TOKEN, SELF: undefined });

async function hourly(installId: string, product: string) {
  const rows = await readUsage(db(), {
    from: HOUR_NOW - 10 * 24 * HOUR,
    to: HOUR_NOW + HOUR,
    grain: "hour",
    installIds: [installId],
  });
  return rows.filter((r) => r.product === product).map((r) => [r.t - HOUR_NOW, r.value]);
}

describe("watchSpend: collect and store", () => {
  it("stores the recorded usage, then writes only hours that changed", async () => {
    await seedRecordedApp();
    const w = world(RECORDED);
    const first = await watchSpend(watchEnv(), {}, w.deps());
    expect(first).toMatchObject({ status: "watching", apps: 1, newApps: 0, history: "database" });
    // The namespace list, then one request per dataset.
    expect(first.subrequests).toBe(1 + 9);
    expect(new Set(w.graphql.map((s) => s.dataset)).size).toBe(w.graphql.length);
    expect(await hourly("notes", "workers_requests")).toEqual([
      [-4 * HOUR, 2],
      [-3 * HOUR, 2],
      [-2 * HOUR, 2],
      [-HOUR, 2],
      [0, 1],
    ]);
    // Storage has a point for every hour from the first sample on.
    expect(await hourly("notes", "do_storage")).toHaveLength(5);
    expect(first.rowsWritten).toBeGreaterThan(20);
    expect(await readSpendWatchStatus(db())).toEqual({ state: "watching", at: NOW });

    // Five minutes later the analytics say the same: nothing to write.
    const second = await watchSpend(watchEnv(), {}, w.deps(NOW + 5 * 60_000));
    expect(second.rowsWritten).toBe(0);
    expect(second.history).toBe("cache");
    // Only the recent hours are read again.
    const workers = w.graphql.filter((s) => s.dataset === "workersInvocationsAdaptive");
    expect(workers[1]?.filter.datetime_geq).toBe(
      new Date((HOUR_NOW - 3 * HOUR - 3 * HOUR) * 1000).toISOString(),
    );
    expect(spendWatchLog(second)).toMatch(
      /^spend watcher: watching, 1 app\(s\), 0 row\(s\) written/,
    );
  });

  it("writes an hour again when the analytics' number grew", async () => {
    await seedRecordedApp();
    await watchSpend(watchEnv(), {}, world(RECORDED).deps());
    const grown = {
      ...RECORDED,
      workersInvocationsAdaptive: [
        ...(RECORDED.workersInvocationsAdaptive ?? []).filter(
          (r) => r.dimensions.datetimeHour !== "2026-10-12T16:00:00Z",
        ),
        answerRow("scriptName", "notes", HOUR_NOW, { sum: { requests: 7, cpuTimeUs: 136516 } }),
      ],
    };
    const report = await watchSpend(watchEnv(), {}, world(grown).deps(NOW + 5 * 60_000));
    expect(report.rowsWritten).toBe(1);
    expect((await hourly("notes", "workers_requests")).at(-1)).toEqual([0, 7]);
  });

  it("leaves an app younger than 15 minutes for later", async () => {
    await seedRecordedApp("notes", NOW - 5 * 60_000);
    const w = world(RECORDED);
    const report = await watchSpend(watchEnv(), {}, w.deps());
    expect(report).toMatchObject({ status: "watching", apps: 0, newApps: 1, rowsWritten: 0 });
    expect(w.graphql).toEqual([]);
    expect((await readUsageState(db(), "notes")).lastCheckedAt).toBeNull();

    // Its first check reads from its install on.
    const later = await watchSpend(watchEnv(), {}, w.deps(NOW + 20 * 60_000));
    expect(later.apps).toBe(1);
    expect(w.graphql[0]?.filter.datetime_geq).toBe(
      new Date((HOUR_NOW - 3 * HOUR) * 1000).toISOString(),
    );
  });
});

describe("watchSpend: access", () => {
  it("does nothing without the analytics scopes, and says so", async () => {
    await seedRecordedApp();
    await env.DB.prepare(
      `INSERT INTO cloudflare_grant (id, client_id, scopes_json, refresh_token, access_token,
         access_expires_at, key_id, status, connected_at, refreshed_at)
       VALUES ('g', 'c', ?1, 'sealed', 'sealed', ?2, 'k', 'connected', 1, 1)`,
    )
      .bind(JSON.stringify(["account-settings.read", "workers-scripts.write"]), NOW + 3_600_000)
      .run();
    const w = world(RECORDED);
    const report = await watchSpend(watchEnv(), {}, w.deps());
    expect(report.status).toBe("needs_access");
    expect(w.graphql).toEqual([]);
    expect(w.rest).toEqual([]);
    expect(await readSpendWatchStatus(db())).toEqual({
      state: "needs_access",
      at: NOW,
      via: "oauth",
      missing: ["account-analytics.read", "workers-observability.read"],
    });
  });

  it("says so when Cloudflare refuses the token the analytics", async () => {
    await seedRecordedApp();
    const w = world(RECORDED, {
      refuse: { message: "not authorized for that account", code: "authz" },
    });
    const report = await watchSpend(watchEnv(), {}, w.deps());
    expect(report.status).toBe("needs_access");
    expect(await readSpendWatchStatus(db())).toMatchObject({ state: "needs_access", via: "token" });
    expect(await hourly("notes", "workers_requests")).toEqual([]);
  });

  it("does not take a refusal without Cloudflare's permission code for missing access", async () => {
    await seedRecordedApp();
    const w = world(RECORDED, { refuse: { message: "access to this dataset is limited" } });
    const report = await watchSpend(watchEnv(), {}, w.deps());
    expect(report.status).toBe("watching");
    expect(report.failedReads?.length).toBeGreaterThan(0);
    // Nothing was read: the app keeps its last check's time, so the next reads it all again.
    expect((await readUsageState(db(), "notes")).lastCheckedAt).toBeNull();
  });

  it("records a failure of the check itself without throwing", async () => {
    await seedRecordedApp();
    await env.DB.prepare("DROP TABLE app_usage_state").run();
    const report = await watchSpend(watchEnv(), {}, world(RECORDED).deps());
    expect(report.status).toBe("failed");
    expect(await readSpendWatchStatus(db())).toMatchObject({ state: "failed" });
  });
});

describe("watchSpend: a read that fails", () => {
  it("leaves out only what it covers; the rest is stored and judged", async () => {
    await seedRecordedApp();
    await seedApp("other", { worker: "other" });
    const answers = {
      ...RECORDED,
      workersInvocationsAdaptive: [
        ...(RECORDED.workersInvocationsAdaptive ?? []),
        answerRow("scriptName", "other", HOUR_NOW, { sum: { requests: 9, cpuTimeUs: 1000 } }),
      ],
    };
    const w = world(answers, {
      refuse: { message: "timeout", datasets: ["d1AnalyticsAdaptiveGroups"] },
    });
    const report = await watchSpend(watchEnv(), {}, w.deps());
    expect(report).toMatchObject({ status: "watching", failedReads: ["d1"] });
    expect(spendWatchLog(report)).toContain("failed reads: d1");
    // The rest of the app's usage, and the other app's, are stored.
    expect(await hourly("notes", "workers_requests")).toHaveLength(5);
    expect(await hourly("notes", "kv_storage")).toHaveLength(5);
    expect(await hourly("other", "workers_requests")).toEqual([[0, 9]]);
    // Not the products of the failed read, not even storage carried forward.
    expect(await hourly("notes", "d1_rows_read")).toEqual([]);
    expect(await hourly("notes", "d1_storage")).toEqual([]);
    // Only the app fully read counts as checked now.
    expect((await readUsageState(db(), "other")).lastCheckedAt).toBe(NOW);
    expect((await readUsageState(db(), "notes")).lastCheckedAt).toBeNull();
  });
});

/** Ten calm days of Durable Object use, stored as the watcher would have. */
async function seedCalmHistory(installId: string) {
  const rows = [];
  for (let h = HOUR_NOW - 10 * 24 * HOUR; h < HOUR_NOW - 8 * HOUR; h += HOUR) {
    rows.push({ installId, product: "do_requests", hour: h, value: 1_440 });
    rows.push({ installId, product: "do_rows_written", hour: h, value: 2_880 });
  }
  await recordHourlyUsage(db(), rows, { levels: LEVEL_PRODUCTS, now: new Date(NOW) });
}

/** A Durable Object alarm loop over the last three hours: about $10 an hour. */
function loopAnswers(namespace: string): Record<string, AnswerRow[]> {
  const hours = [HOUR_NOW - 2 * HOUR, HOUR_NOW - HOUR, HOUR_NOW];
  return {
    durableObjectsInvocationsAdaptiveGroups: hours.map((h) =>
      answerRow("namespaceId", namespace, h, { sum: { requests: 5e6 } }),
    ),
    durableObjectsPeriodicGroups: hours.map((h) =>
      answerRow("namespaceId", namespace, h, { sum: { rowsWritten: 10e6, duration: 0 } }),
    ),
    alarms: hours.map((h) =>
      answerRow("namespaceId", namespace, h, { sum: { requests: 5e6 } }, { objectId: "obj" }),
    ),
  };
}

describe("watchSpend: judging", () => {
  async function seedLoopingApp(id: string, ns: string) {
    await seedApp(id, { worker: id });
    await seedCalmHistory(id);
    return { id: ns, script: id };
  }

  it("alerts unusual usage once and pauses a loop on the second check in a row", async () => {
    const ns = await seedLoopingApp("loopy", "ns-loopy");
    await writeAppSpendSettings(
      db(),
      "loopy",
      { autoPause: "on", customTriggers: true, loopOn: true, loopLevel: "strict", capOn: false },
      { userId: "u", now: new Date(NOW - DAY_MS) },
    );
    const w = world(loopAnswers("ns-loopy"), { namespaces: [ns] });

    const first = await watchSpend(watchEnv(), {}, w.deps());
    expect(w.events.filter((e) => e.type === "usage_unusual")).toHaveLength(1);
    expect(w.pauses).toEqual([]);
    expect((await readUsageState(db(), "loopy")).loopChecks).toBe(1);
    const started = await listActivity(db(), { installId: "loopy", kinds: ["unusual_started"] });
    expect(started).toHaveLength(1);
    expect(started[0]?.facts).toMatchObject({ factor: 20, product: expect.stringMatching(/^do_/) });
    expect(first.alerts).toBe(w.events.length);

    const second = await watchSpend(watchEnv(), {}, w.deps(NOW + 5 * 60_000));
    expect(w.events.filter((e) => e.type === "usage_unusual")).toHaveLength(1);
    expect(w.pauses).toEqual([
      {
        installId: "loopy",
        reason: "loop",
        by: null,
        detail: expect.objectContaining({
          level: "strict",
          plan: "free",
          alarms: expect.any(Number),
        }),
      },
    ]);
    expect(second.pauses).toBe(1);
  });

  it("does not pause with auto-pause off (the default)", async () => {
    const ns = await seedLoopingApp("loopy", "ns-loopy");
    const w = world(loopAnswers("ns-loopy"), { namespaces: [ns] });
    await watchSpend(watchEnv(), {}, w.deps());
    await watchSpend(watchEnv(), {}, w.deps(NOW + 5 * 60_000));
    expect(w.pauses).toEqual([]);
    expect((await readUsageState(db(), "loopy")).loopChecks).toBe(2);
  });

  it("sends a usage alert once per period", async () => {
    const ns = await seedLoopingApp("loopy", "ns-loopy");
    await createAlertRule(
      db(),
      "loopy",
      { kind: "spent", unit: "usd", amount: 5, period: "day" },
      { userId: "u", now: new Date(NOW - DAY_MS) },
    );
    await writeAccountPlan(db(), "paid");
    const w = world(loopAnswers("ns-loopy"), { namespaces: [ns] });
    await watchSpend(watchEnv(), {}, w.deps());
    await watchSpend(watchEnv(), {}, w.deps(NOW + 5 * 60_000));
    expect(w.events.filter((e) => e.type === "usage_alert")).toEqual([
      expect.objectContaining({ sentence: "When it has spent $5.00 today", period: "day" }),
    ]);
    const sent = await listActivity(db(), { installId: "loopy", kinds: ["alert_sent"] });
    expect(sent).toHaveLength(1);
  });

  it("pauses one app per check for the budget, and waits while the biggest is busy", async () => {
    await writeAccountPlan(db(), "paid");
    await writeSpendDefaults(db(), { budget: { on: true, amount: 10 } });
    const big = await seedLoopingApp("big", "ns-big");
    const small = await seedLoopingApp("small", "ns-small");
    const answers = loopAnswers("ns-big");
    for (const [k, rows] of Object.entries(loopAnswers("ns-small"))) {
      answers[k] = [
        ...(answers[k] ?? []),
        ...rows.map((r) => ({ ...r, sum: { requests: 1e6, rowsWritten: 2e6, duration: 0 } })),
      ];
    }
    const w = world(answers, { namespaces: [big, small] });
    await watchSpend(watchEnv(), {}, w.deps());
    expect(w.pauses).toEqual([
      expect.objectContaining({ installId: "big", reason: "budget", by: null }),
    ]);
    expect(w.events.filter((e) => e.type === "budget_reached")).toHaveLength(1);

    w.refusePause(["big"]);
    const second = await watchSpend(watchEnv(), {}, w.deps(NOW + 5 * 60_000));
    expect(w.pauses.map((p) => p.installId)).toEqual(["big"]);
    expect(second.deferred).toBe(1);
    // The budget is told once a month.
    expect(w.events.filter((e) => e.type === "budget_reached")).toHaveLength(1);
  });

  it("holds off pausing an app for an hour after its pause failed", async () => {
    const ns = await seedLoopingApp("loopy", "ns-loopy");
    await writeAppSpendSettings(
      db(),
      "loopy",
      { autoPause: "on", customTriggers: true, loopOn: true, loopLevel: "strict", capOn: false },
      { userId: "u", now: new Date(NOW - DAY_MS) },
    );
    await env.DB.prepare(
      "INSERT INTO app_usage_state (install_id, loop_checks) VALUES ('loopy', 1)",
    ).run();
    await recordActivity(db(), {
      installId: "loopy",
      kind: "pause_failed",
      facts: { reason: "loop", jobId: "j1", error: "the stand-in did not deploy" },
      at: new Date(NOW - 30 * 60_000),
    });
    const w = world(loopAnswers("ns-loopy"), { namespaces: [ns] });
    await watchSpend(watchEnv(), {}, w.deps());
    expect(w.pauses).toEqual([]);
    // An hour after the failure, it is paused again.
    await watchSpend(watchEnv(), {}, w.deps(NOW + 31 * 60_000));
    expect(w.pauses.map((p) => p.installId)).toEqual(["loopy"]);
  });

  it("starts pauses before it sends notifications", async () => {
    const ns = await seedLoopingApp("loopy", "ns-loopy");
    await writeAppSpendSettings(
      db(),
      "loopy",
      { autoPause: "on", customTriggers: true, loopOn: true, loopLevel: "strict", capOn: false },
      { userId: "u", now: new Date(NOW - DAY_MS) },
    );
    await env.DB.prepare(
      "INSERT INTO app_usage_state (install_id, loop_checks) VALUES ('loopy', 1)",
    ).run();
    const order: string[] = [];
    const w = world(loopAnswers("ns-loopy"), { namespaces: [ns] });
    const deps = w.deps();
    const report = await watchSpend(
      watchEnv(),
      {},
      {
        ...deps,
        // Room for the reads and one more subrequest only.
        budget: 11,
        startPause: async (e, r) => {
          order.push("pause");
          return (deps.startPause ?? (() => Promise.reject(new Error("no"))))(e, r);
        },
        emit: async (e, ev, d) => {
          order.push(`send ${ev.type}`);
          return (deps.emit ?? (() => Promise.reject(new Error("no"))))(e, ev, d);
        },
      },
    );
    expect(order[0]).toBe("pause");
    expect(report.pauses).toBe(1);
  });

  it("stores the pages' numbers every check", async () => {
    await seedRecordedApp();
    await watchSpend(watchEnv(), {}, world(RECORDED).deps());
    const raw = (await readSettings(db(), [SETTING.spendOverview]))[SETTING.spendOverview];
    const snapshot = spendSnapshotSchema.parse(JSON.parse(raw ?? "null"));
    expect(snapshot.computedAt).toBe(NOW);
    expect(snapshot.apps.map((a) => a.installId)).toEqual(["notes"]);
  });

  describe("on Workers Free, in parts over SELF", () => {
    /** A `SELF` whose `spendShard` runs the unit here, recording each part's input. */
    function selfFor(deps: SpendWatchDeps) {
      const parts: ShardInput[] = [];
      const units = createSpendWatcherUnits(watchEnv(), deps);
      return {
        parts,
        self: {
          spendShard: (input: unknown) => {
            parts.push(input as ShardInput);
            return units.spendShard(structuredClone(input));
          },
        },
      };
    }
    const snapshot = async () =>
      spendSnapshotSchema.parse(
        JSON.parse(
          (await readSettings(db(), [SETTING.spendOverview]))[SETTING.spendOverview] ?? "null",
        ),
      );

    it("judges a few apps per part and stores the numbers a whole check would", async () => {
      await seedRecordedApp();
      for (const id of ["b", "c", "d", "e"]) await seedApp(id, { worker: id });
      const w = world(RECORDED);
      await watchSpend(watchEnv(), {}, w.deps());
      const whole = await snapshot();

      const { self, parts } = selfFor(w.deps());
      const report = await watchSpend({ ...watchEnv(), SELF: self }, {}, w.deps());
      // In the order Home lists them (by install time, then id).
      expect(parts.map((p) => p.apps.map((a) => a.installId))).toEqual([
        ["b", "c", "d", "e"],
        ["notes"],
      ]);
      expect(parts.map((p) => p.judge)).toEqual([["b", "c", "d", "e"], ["notes"]]);
      expect(report.parts).toEqual({ count: 2, ran: 2, failed: 0 });
      expect(spendWatchLog(report)).toContain("2 part(s)");
      expect(await snapshot()).toEqual(whole);
    });

    it("pauses a loop from a part, on the second check in a row", async () => {
      await seedApp("loopy", { worker: "loopy" });
      await seedCalmHistory("loopy");
      await writeAppSpendSettings(
        db(),
        "loopy",
        { autoPause: "on", customTriggers: true, loopOn: true, loopLevel: "strict", capOn: false },
        { userId: "u", now: new Date(NOW - DAY_MS) },
      );
      const w = world(loopAnswers("ns-loopy"), {
        namespaces: [{ id: "ns-loopy", script: "loopy" }],
      });
      const first = selfFor(w.deps());
      await watchSpend({ ...watchEnv(), SELF: first.self }, {}, w.deps());
      expect(first.parts[0]?.alarms.loopy).toBeDefined();
      expect(w.events.filter((e) => e.type === "usage_unusual")).toHaveLength(1);
      expect(w.pauses).toEqual([]);
      const second = selfFor(w.deps(NOW + 5 * 60_000));
      const report = await watchSpend(
        { ...watchEnv(), SELF: second.self },
        {},
        w.deps(NOW + 5 * 60_000),
      );
      expect(w.pauses.map((p) => [p.installId, p.reason])).toEqual([["loopy", "loop"]]);
      expect(report.pauses).toBe(1);
    });

    it("keeps an app's last numbers when its part fails", async () => {
      await seedRecordedApp();
      const w = world(RECORDED);
      await watchSpend(watchEnv(), {}, w.deps());
      const before = await snapshot();
      const self = { spendShard: async () => ({ ok: false as const, error: "boom" }) };
      const report = await watchSpend({ ...watchEnv(), SELF: self }, {}, w.deps(NOW + 5 * 60_000));
      expect(report.parts).toEqual({ count: 1, ran: 1, failed: 1 });
      const after = await snapshot();
      expect(after.apps).toEqual(before.apps);
      expect(after.computedAt).toBe(NOW + 5 * 60_000);
    });

    it("runs as many parts as its subrequests allow, a different window each check", async () => {
      for (const id of ["a1", "a2", "a3", "a4", "a5", "a6", "a7", "a8", "a9"]) {
        await seedApp(id, { worker: id });
      }
      const w = world(RECORDED, { namespaces: [] });
      const ran: string[][] = [];
      const units = createSpendWatcherUnits(watchEnv(), w.deps());
      const self = {
        spendShard: (input: unknown) => {
          ran.push((input as ShardInput).apps.map((a) => a.installId));
          return units.spendShard(input);
        },
      };
      // The reads take 2 subrequests (the namespace list and the Workers
      // dataset): a budget of 4 leaves room for 2 of the 3 parts.
      const first = await watchSpend({ ...watchEnv(), SELF: self }, {}, { ...w.deps(), budget: 4 });
      expect(first.parts).toEqual({ count: 3, ran: 2, failed: 0 });
      expect(spendWatchLog(first)).toContain("3 part(s) (1 left for the next check)");
      const next = await watchSpend(
        { ...watchEnv(), SELF: self },
        {},
        { ...w.deps(NOW + 5 * 60_000), budget: 4 },
      );
      expect(next.parts?.ran).toBe(2);
      // Over the two checks every part ran.
      expect(new Set(ran.flat())).toEqual(
        new Set(["a1", "a2", "a3", "a4", "a5", "a6", "a7", "a8", "a9"]),
      );
      // The pages still list every app.
      expect((await snapshot()).apps).toHaveLength(9);
    });
  });

  it("prunes on half-hour checks", async () => {
    await seedRecordedApp();
    const report = await watchSpend(watchEnv(), { maintenance: true }, world(RECORDED).deps());
    expect(report.pruned).toBe(0);
    const plain = await watchSpend(watchEnv(), {}, world(RECORDED).deps(NOW + 300_000));
    expect(plain.pruned).toBeNull();
  });
});

describe("rows read", () => {
  /** Every SQL statement a check sends, through a recording D1 binding. */
  function recording(): { d1: D1Database; sql: string[] } {
    const sql: string[] = [];
    const d1 = new Proxy(env.DB, {
      get(target, prop) {
        if (prop === "prepare") {
          return (query: string) => {
            sql.push(query);
            return target.prepare(query);
          };
        }
        const value = Reflect.get(target, prop);
        return typeof value === "function" ? value.bind(target) : value;
      },
    });
    return { d1, sql };
  }

  async function plans(statements: readonly string[]): Promise<string[]> {
    const out: string[] = [];
    for (const sql of new Set(statements)) {
      if (!/^\s*(select|insert|update|delete|with)/i.test(sql)) continue;
      const count = (sql.match(/\?(\d*)/g) ?? []).length;
      const numbered = Math.max(0, ...[...sql.matchAll(/\?(\d+)/g)].map((m) => Number(m[1])));
      const params = Array.from({ length: Math.max(count, numbered) }, () => 0);
      const { results } = await env.DB.prepare(`EXPLAIN QUERY PLAN ${sql}`)
        .bind(...params)
        .all<{ detail: string }>();
      out.push(...results.map((r) => r.detail));
    }
    return out;
  }

  it("reads the large tables through their indexes only", async () => {
    await writeAccountPlan(db(), "paid");
    await writeSpendDefaults(db(), { budget: { on: true, amount: 10 } });
    const ns = { id: "ns-big", script: "big" };
    await seedApp("big", { worker: "big" });
    await seedCalmHistory("big");
    const { d1, sql } = recording();
    const w = world(loopAnswers("ns-big"), { namespaces: [ns] });
    await watchSpend({ ...watchEnv(), DB: d1 }, { maintenance: true }, w.deps());
    await watchSpend({ ...watchEnv(), DB: d1 }, {}, w.deps(NOW + 300_000));
    const lines = await plans(sql);
    expect(lines.length).toBeGreaterThan(10);
    const scans = lines.filter((l) =>
      /\bSCAN (usage_hourly|usage_daily|usage_activity|resources|jobs|job_logs|app_usage_state|app_spend_settings)\b/.test(
        l,
      ),
    );
    expect(scans).toEqual([]);
  });

  it("reads each install's resources through their index", async () => {
    const { results } = await env.DB.prepare(`EXPLAIN QUERY PLAN ${WATCHED_APPS_SQL}`).all<{
      detail: string;
    }>();
    const lines = results.map((r) => r.detail);
    expect(lines).toContainEqual(
      expect.stringMatching(/SEARCH r USING INDEX resources_install_id_idx/),
    );
    // The installs table is read whole (one row per install ever made), as Home reads it.
    expect(lines.filter((l) => /^SCAN/.test(l) && !/^SCAN (i|b|w|wb|json_each)\b/.test(l))).toEqual(
      [],
    );
  });

  it("caches the history in KV for the hour", async () => {
    await seedRecordedApp();
    await watchSpend(watchEnv(), {}, world(RECORDED).deps());
    expect(await env.KV.get(HISTORY_KEY)).not.toBeNull();
  });
});

describe("recentRows", () => {
  it("leaves out hours the history holds already, so none counts twice", () => {
    const hourlyFrom = HOUR_NOW - 3 * HOUR;
    const row = (t: number, value: number) => ({
      installId: "a",
      product: "workers_requests",
      t,
      value,
    });
    expect(
      recentRows(
        [row(hourlyFrom - HOUR, 5), row(hourlyFrom, 6), row(hourlyFrom + HOUR, 7)],
        [{ installId: "a", product: "workers_requests", hour: hourlyFrom + HOUR, value: 8 }],
        hourlyFrom,
      ),
    ).toEqual([row(hourlyFrom, 6), row(hourlyFrom + HOUR, 8)]);
  });
});
