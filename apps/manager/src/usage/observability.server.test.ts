import { reset } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { createClient } from "@appflare/cf-api";
import { beforeEach, describe, expect, it } from "vitest";
import { createDb } from "../db/client";
import { createMigrator } from "../db/migrate";
import { migrations } from "../db/migrations/index";
import { ACC, type FakeAccount, fakeAccount, TOKEN } from "../test/fake-account";
import { INSTALL_ID, OLD_VERSION, seedInstall } from "../test/seed-install";
import { LOGS_OFF, LOGS_ON } from "../test/workers-logs";
import {
  ObservabilityError,
  readAppObservability,
  setAppObservability,
} from "./observability.server";
import { OBSERVABILITY_MESSAGES } from "./observability-copy";
import { listActivity } from "./store/activity.server";

/**
 * An app's Workers Logs against a fake account: read per Worker, and turned
 * on or off for every Worker of the app, recorded in its activity.
 */

const NOW = new Date("2026-10-12T10:00:00Z");

async function world(opts: { status?: string; jobs?: boolean; over?: Partial<FakeAccount> } = {}) {
  const fake = fakeAccount(null, {
    deployments: [{ id: "dep-0", versions: [{ version_id: OLD_VERSION, percentage: 100 }] }],
    ...(opts.jobs === true ? { otherScripts: ["cut-jobs"] } : {}),
    ...opts.over,
  });
  await seedInstall({
    ...(opts.status === undefined ? {} : { status: opts.status }),
    resources: [
      { kind: "worker", name: "cut", cfId: "cut" },
      ...(opts.jobs === true ? [{ kind: "worker", name: "cut-jobs", cfId: "cut-jobs" }] : []),
    ],
  });
  const deps = {
    db: env.DB,
    api: async () => createClient({ accountId: ACC, token: TOKEN, fetch: fake.fetch }),
    now: () => NOW,
  };
  return { fake, deps };
}

const activity = () => listActivity(createDb(env.DB), { installId: INSTALL_ID });

beforeEach(async () => {
  await reset();
  await createMigrator(migrations).ensure(env.DB);
});

describe("reading an app's Workers Logs", () => {
  it("reads each Worker of the app from Cloudflare, the app's own Worker first", async () => {
    const { deps } = await world({
      jobs: true,
      over: { observability: { "cut-jobs": LOGS_ON } },
    });
    expect(await readAppObservability(deps, INSTALL_ID)).toEqual({
      installId: INSTALL_ID,
      state: "mixed",
      workers: [
        // Never set: off.
        { workerName: "cut", on: false },
        { workerName: "cut-jobs", on: true },
      ],
      problem: null,
    });
  });

  it("says on or off for the app when its Workers agree", async () => {
    for (const [setting, state] of [
      [LOGS_ON, "on"],
      [LOGS_OFF, "off"],
    ] as const) {
      const { deps } = await world({
        jobs: true,
        over: { observability: { cut: setting, "cut-jobs": setting } },
      });
      expect((await readAppObservability(deps, INSTALL_ID)).state).toBe(state);
      await reset();
      await createMigrator(migrations).ensure(env.DB);
    }
  });

  it("says why when a Worker cannot be read, without failing", async () => {
    const { deps, fake } = await world({ jobs: true });
    fake.state.failOnce.set("GET /workers/scripts/cut/script-settings", 403);
    expect(await readAppObservability(deps, INSTALL_ID)).toEqual({
      installId: INSTALL_ID,
      state: "unknown",
      workers: [
        { workerName: "cut", on: null },
        { workerName: "cut-jobs", on: false },
      ],
      problem: OBSERVABILITY_MESSAGES.permission,
    });
    fake.state.failOnce.set("GET /workers/scripts/cut-jobs/script-settings", 500);
    const failed = await readAppObservability(deps, INSTALL_ID);
    expect(failed.state).toBe("unknown");
    expect(failed.problem).toMatch(
      /^Appflare could not read whether Workers Logs are on for cut-jobs \(.*500.*\)\.$/,
    );
    // A Worker no longer in the account.
    fake.state.otherScripts = [];
    expect((await readAppObservability(deps, INSTALL_ID)).problem).toBe(
      OBSERVABILITY_MESSAGES.workerGone("cut-jobs"),
    );
  });

  it("refuses an app it does not know", async () => {
    const { deps } = await world();
    await expect(readAppObservability(deps, "nope")).rejects.toThrow(
      new ObservabilityError(OBSERVABILITY_MESSAGES.noInstall),
    );
  });
});

describe("turning an app's Workers Logs on or off", () => {
  it("changes every Worker of the app and records who did it", async () => {
    const { deps, fake } = await world({ jobs: true });
    const on = await setAppObservability(deps, {
      installId: INSTALL_ID,
      enabled: true,
      by: "user-admin",
    });
    expect(on).toEqual({
      installId: INSTALL_ID,
      state: "on",
      workers: [
        { workerName: "cut", on: true },
        { workerName: "cut-jobs", on: true },
      ],
      problem: null,
    });
    expect(fake.state.calls).toEqual([
      "PATCH /workers/scripts/cut/script-settings",
      "PATCH /workers/scripts/cut-jobs/script-settings",
    ]);
    // No new version: only the setting changed.
    expect(fake.state.versions).toEqual([]);
    expect(fake.state.observability.cut).toMatchObject({ enabled: true });

    const off = await setAppObservability(deps, {
      installId: INSTALL_ID,
      enabled: false,
      by: "user-other",
    });
    expect(off.state).toBe("off");
    expect(await activity()).toEqual([
      expect.objectContaining({
        kind: "observability_changed",
        by: "user-other",
        facts: { enabled: false, workers: ["cut", "cut-jobs"] },
      }),
      expect.objectContaining({
        kind: "observability_changed",
        installId: INSTALL_ID,
        by: "user-admin",
        at: NOW.getTime(),
        facts: { enabled: true, workers: ["cut", "cut-jobs"] },
      }),
    ]);
  });

  it("refuses an app that is not installed, before calling Cloudflare", async () => {
    for (const status of ["installing", "uninstalling", "uninstalled", "failed"]) {
      const { deps, fake } = await world({ status });
      await expect(
        setAppObservability(deps, { installId: INSTALL_ID, enabled: true, by: "u" }),
      ).rejects.toThrow(OBSERVABILITY_MESSAGES.notInstalled);
      expect(fake.state.calls).toEqual([]);
      await reset();
      await createMigrator(migrations).ensure(env.DB);
    }
  });

  it("says which permission is missing, and records nothing", async () => {
    const { deps, fake } = await world();
    fake.state.failOnce.set("PATCH /workers/scripts/cut/script-settings", 403);
    await expect(
      setAppObservability(deps, { installId: INSTALL_ID, enabled: true, by: "u" }),
    ).rejects.toThrow(new ObservabilityError(OBSERVABILITY_MESSAGES.permission));
    expect(await activity()).toEqual([]);
  });

  it("names the Worker Cloudflare refused and records what it changed before", async () => {
    const { deps, fake } = await world({ jobs: true });
    fake.state.failOnce.set("PATCH /workers/scripts/cut-jobs/script-settings", 500);
    const error = await setAppObservability(deps, {
      installId: INSTALL_ID,
      enabled: true,
      by: "u",
    }).catch((e) => e);
    expect(error).toBeInstanceOf(ObservabilityError);
    expect(error.message).toMatch(
      /^Cloudflare did not change Workers Logs for cut-jobs \(.*500.*\)\. Workers Logs are changed for cut already\. Try again\.$/,
    );
    expect(await activity()).toEqual([
      expect.objectContaining({
        kind: "observability_changed",
        by: "u",
        facts: { enabled: true, workers: ["cut"], partial: true },
      }),
    ]);
    // Trying again changes the rest.
    expect(
      (await setAppObservability(deps, { installId: INSTALL_ID, enabled: true, by: "u" })).state,
    ).toBe("on");
    expect((await activity())[0]?.facts).toEqual({ enabled: true, workers: ["cut", "cut-jobs"] });
  });

  it("records a partial change before a missing permission, and says both", async () => {
    const { deps, fake } = await world({ jobs: true });
    fake.state.failOnce.set("PATCH /workers/scripts/cut-jobs/script-settings", 403);
    await expect(
      setAppObservability(deps, { installId: INSTALL_ID, enabled: false, by: "u" }),
    ).rejects.toThrow(
      `${OBSERVABILITY_MESSAGES.permission} ${OBSERVABILITY_MESSAGES.partlyChanged(["cut"])}`,
    );
    expect((await activity()).map((a) => a.facts)).toEqual([
      { enabled: false, workers: ["cut"], partial: true },
    ]);
  });

  it("refuses while a job runs on the app, before calling Cloudflare", async () => {
    for (const status of ["queued", "running"]) {
      const { deps, fake } = await world();
      await env.DB.prepare(
        "INSERT INTO jobs (id, install_id, kind, status) VALUES ('j1', ?1, 'update', ?2)",
      )
        .bind(INSTALL_ID, status)
        .run();
      await expect(
        setAppObservability(deps, { installId: INSTALL_ID, enabled: true, by: "u" }),
      ).rejects.toThrow(
        new ObservabilityError("Wait for the running job to finish, then try again."),
      );
      expect(fake.state.calls).toEqual([]);
      expect(await activity()).toEqual([]);
      await reset();
      await createMigrator(migrations).ensure(env.DB);
    }
    // A finished job does not stand in the way.
    const { deps } = await world();
    await env.DB.prepare(
      "INSERT INTO jobs (id, install_id, kind, status) VALUES ('j0', ?1, 'update', 'succeeded')",
    )
      .bind(INSTALL_ID)
      .run();
    expect(
      (await setAppObservability(deps, { installId: INSTALL_ID, enabled: true, by: "u" })).state,
    ).toBe("on");
  });

  it("says when a Worker of the app is gone from the account", async () => {
    const { deps } = await world({ jobs: true, over: { otherScripts: [] } });
    await expect(
      setAppObservability(deps, { installId: INSTALL_ID, enabled: true, by: "u" }),
    ).rejects.toThrow(OBSERVABILITY_MESSAGES.workerGone("cut-jobs"));
  });
});
