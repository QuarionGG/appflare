import { reset } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  AutoUpdateError,
  readAutoUpdateSettings,
  writeAutoUpdateDefaults,
} from "../auto-update/auto-update.server";
import { runScheduledUpdates, type ScheduledUpdatesEnv } from "../auto-update/cron.server";
import { MANAGER_LATEST_KEY } from "../catalog/manager-releases.server";
import { createDb } from "../db/client";
import { createMigrator } from "../db/migrate";
import { migrations } from "../db/migrations/index";
import { readSettings, SETTING, writeSettings } from "../db/settings";
import { runSelfUpdate } from "../jobs/self-update";
import { SelfUpdateError, startSelfUpdateCore } from "../jobs/self-update/start.server";
import { buildArtifactFixture } from "../test/artifact-fixture";
import { fakeStep } from "../test/fake-step";
import { cacheIndex, INSTALL_ID, seedInstall } from "../test/seed-install";
import {
  FORK_MANAGER_UPDATE_MESSAGE,
  MANAGER_BUILD_CHANNEL,
  managerSelfUpdateBlock,
} from "./manager-update-policy";

beforeEach(async () => {
  await reset();
  await createMigrator(migrations).ensure(env.DB);
});

describe("the source-baked fork update policy", () => {
  it("refuses a manual manager update before queuing a Workflow", async () => {
    const createJob = vi.fn();
    expect(MANAGER_BUILD_CHANNEL).toBe("quariongg-fork");
    expect(managerSelfUpdateBlock()).toBe(FORK_MANAGER_UPDATE_MESSAGE);
    await expect(
      startSelfUpdateCore(
        {
          db: env.DB,
          latest: null,
          currentVersion: "0.5.0",
          hasToken: true,
          workflows: { get: async () => ({ status: async () => ({ status: "running" }) }) },
          createJob,
        },
        { version: "0.6.0" },
      ),
    ).rejects.toThrow(new SelfUpdateError(FORK_MANAGER_UPDATE_MESSAGE));
    expect(createJob).not.toHaveBeenCalled();
    expect(await env.DB.prepare("SELECT id FROM jobs").all()).toMatchObject({ results: [] });
  });

  it("ignores a saved manager-on setting and still permits changing app updates", async () => {
    const db = createDb(env.DB);
    await writeSettings(db, { [SETTING.autoUpdateManager]: "on" });
    await expect(writeAutoUpdateDefaults(db, { manager: true })).rejects.toThrow(AutoUpdateError);
    await writeAutoUpdateDefaults(db, { apps: true });
    expect(await readAutoUpdateSettings(db, "0.5.0")).toEqual({
      apps: true,
      manager: false,
      devBuild: false,
    });
    expect(await readSettings(db, [SETTING.autoUpdateManager])).toEqual({
      auto_update_manager: "on",
    });
  });

  it("refuses an official self-update queued before the fork was deployed", async () => {
    const fixture = await buildArtifactFixture({ version: "0.6.0" });
    const step = fakeStep();
    await expect(
      runSelfUpdate({
        params: {
          kind: "self_update",
          jobId: "previously-queued",
          version: "0.6.0",
          fromVersion: "0.5.0",
          tag: "manager@0.6.0",
          artifacts: fixture.index.artifacts,
        },
        step,
        env: { DB: env.DB, APPFLARE_VERSION: "0.5.0" },
        deps: {},
      }),
    ).rejects.toThrow(FORK_MANAGER_UPDATE_MESSAGE);
    expect(step.names).toEqual([]);
  });

  it("skips official manager releases while continuing catalog app updates", async () => {
    await seedInstall({
      resources: [
        { kind: "worker", name: "cut", cfId: "cut" },
        { kind: "secret", binding: "ADMIN_PASSWORD", name: "ADMIN_PASSWORD" },
      ],
    });
    const fixture = await buildArtifactFixture({ version: "1.1.0" });
    await cacheIndex(fixture);
    await writeSettings(createDb(env.DB), {
      [SETTING.autoUpdateApps]: "on",
      [SETTING.autoUpdateManager]: "on",
      [SETTING.workerName]: "appflare",
    });
    await env.KV.put(
      MANAGER_LATEST_KEY,
      JSON.stringify({
        version: "0.6.0",
        tag: "manager@0.6.0",
        assets: fixture.index.artifacts,
        publishedAt: null,
        checkedAt: "2026-10-15T00:00:00.000Z",
      }),
    );
    const created: string[] = [];
    const JOBS: ScheduledUpdatesEnv["JOBS"] = {
      get: async () => ({ status: async () => ({ status: "running" }) }),
      create: async ({ id, params }) => {
        created.push(params.kind);
        return { id };
      },
    };
    const outcome = await runScheduledUpdates(
      { DB: env.DB, KV: env.KV, JOBS, APPFLARE_VERSION: "0.5.0", CF_API_TOKEN: "cf-token" },
      { loadManifest: async () => fixture.manifest, newId: () => "catalog-update" },
    );
    expect(outcome.selfUpdate).toEqual({ status: "skipped", reason: "custom-build" });
    expect(outcome.apps).toMatchObject([{ installId: INSTALL_ID, status: "started" }]);
    expect(created).toEqual(["update"]);
  });
});
