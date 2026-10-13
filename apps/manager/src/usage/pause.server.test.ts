import { reset } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { beforeEach, describe, expect, it } from "vitest";
import { createDb } from "../db/client";
import { createMigrator } from "../db/migrate";
import { migrations } from "../db/migrations/index";
import { checkInstallHealthCore, HealthCheckError } from "../installs/health.server";
import { startUninstallCore } from "../installs/start-uninstall.server";
import { claim, startUpdateCore, VersionActionError } from "../installs/versions.server";
import type { JobParams } from "../jobs/run-job";
import { PauseActionError, startPause, startResume } from "./pause.server";
import { PAUSED_REFUSAL } from "./pause-guard.server";
import { openPause } from "./store/pauses.server";

/**
 * Starting pause and resume jobs (one job at a time per install, the right
 * refusals), and the jobs that deploy an app's code refusing a paused app.
 */

beforeEach(async () => {
  await reset();
  await createMigrator(migrations).ensure(env.DB);
  await env.DB.prepare(
    `INSERT INTO installs (id, app_slug, worker_name, instance_name, catalog_version, artifact_url, status, installed_at, updated_at)
     VALUES ('i1', 'cut', 'cut', 'cut', '1.0.0', 'u', 'installed', 1, 1)`,
  ).run();
});

function jobs(create?: () => Promise<{ id: string }>) {
  const created: JobParams[] = [];
  return {
    created,
    JOBS: {
      create: async ({ id, params }: { id: string; params: JobParams }) => {
        created.push(params);
        return create === undefined ? { id } : create();
      },
    },
  };
}

async function jobRow(id: string) {
  return env.DB.prepare(
    "SELECT kind, status, input_json, started_by, workflow_instance_id, error FROM jobs WHERE id = ?1",
  )
    .bind(id)
    .first<{
      kind: string;
      status: string;
      input_json: string;
      started_by: string;
      workflow_instance_id: string | null;
      error: string | null;
    }>();
}

/** An open pause of `i1` made by a pause job that ended as `status`. */
async function seedPause(status: "succeeded" | "failed" | "running") {
  await env.DB.prepare(
    "INSERT INTO jobs (id, install_id, kind, status) VALUES ('jp0', 'i1', 'pause', ?1)",
  )
    .bind(status)
    .run();
  await openPause(createDb(env.DB), {
    installId: "i1",
    pausedBy: "auto",
    reason: "loop",
    jobId: "jp0",
  });
}

describe("startPause", () => {
  it("starts a pause job for an admin, with what it needs and nothing secret", async () => {
    const w = jobs();
    const { jobId } = await startPause(
      { DB: env.DB, JOBS: w.JOBS },
      { installId: "i1", reason: "manual", by: "u-ada" },
      { newId: () => "jp1" },
    );
    expect(jobId).toBe("jp1");
    expect(w.created).toEqual([
      { kind: "pause", jobId: "jp1", installId: "i1", reason: "manual", detail: null, by: "u-ada" },
    ]);
    expect(await jobRow("jp1")).toMatchObject({
      kind: "pause",
      status: "queued",
      started_by: "admin",
      workflow_instance_id: "jp1",
    });
  });

  it("starts an automatic pause with its trigger's facts", async () => {
    const w = jobs();
    await startPause(
      { DB: env.DB, JOBS: w.JOBS },
      { installId: "i1", reason: "cap", detail: { amount: 5, period: "day", spent: 6 }, by: null },
      { newId: () => "jp1" },
    );
    expect(w.created[0]).toMatchObject({
      reason: "cap",
      detail: { amount: 5, period: "day", spent: 6 },
      by: null,
    });
    expect((await jobRow("jp1"))?.started_by).toBe("schedule");
  });

  it("refuses a reason without the facts it needs", async () => {
    await expect(
      startPause(
        { DB: env.DB, JOBS: jobs().JOBS },
        // @ts-expect-error a cap pause carries its amount and period
        { installId: "i1", reason: "cap", detail: {}, by: null },
      ),
    ).rejects.toThrow("The reason for the pause is not valid.");
  });

  it("refuses an app that is paused, being paused, busy, or not installed", async () => {
    const start = () =>
      startPause(
        { DB: env.DB, JOBS: jobs().JOBS },
        { installId: "i1", reason: "manual", by: "u-ada" },
      );
    await seedPause("succeeded");
    await expect(start()).rejects.toThrow("This app is already paused.");
    await env.DB.prepare("UPDATE jobs SET status = 'running' WHERE id = 'jp0'").run();
    await expect(start()).rejects.toThrow("This app is being paused.");
    await env.DB.prepare("DELETE FROM app_pauses").run();
    await expect(start()).rejects.toThrow(
      "Another job of this app is queued or running. Wait for it to finish.",
    );
    await env.DB.prepare("UPDATE jobs SET status = 'failed' WHERE id = 'jp0'").run();
    await env.DB.prepare("UPDATE installs SET status = 'uninstalled' WHERE id = 'i1'").run();
    await expect(start()).rejects.toBeInstanceOf(PauseActionError);
    await expect(start()).rejects.toThrow("This app is uninstalled.");
  });

  it("lets a new pause carry on one whose job failed before it finished", async () => {
    await seedPause("failed");
    const { jobId } = await startPause(
      { DB: env.DB, JOBS: jobs().JOBS },
      { installId: "i1", reason: "manual", by: "u-ada" },
      { newId: () => "jp1" },
    );
    expect(jobId).toBe("jp1");
  });

  it("fails the job it claimed when its Workflow cannot be created", async () => {
    const w = jobs(async () => {
      throw new Error("engine unavailable");
    });
    await expect(
      startPause(
        { DB: env.DB, JOBS: w.JOBS },
        { installId: "i1", reason: "manual", by: "u-ada" },
        { newId: () => "jp1" },
      ),
    ).rejects.toThrow("start: could not create the job: engine unavailable");
    expect(await jobRow("jp1")).toMatchObject({ status: "failed" });
    // Nothing in the way of the next start.
    await expect(
      startPause(
        { DB: env.DB, JOBS: jobs().JOBS },
        { installId: "i1", reason: "manual", by: "u-ada" },
        { newId: () => "jp2" },
      ),
    ).resolves.toEqual({ jobId: "jp2" });
  });
});

describe("startResume", () => {
  it("starts a resume job, with the cap choice", async () => {
    await seedPause("succeeded");
    const w = jobs();
    await startResume(
      { DB: env.DB, JOBS: w.JOBS },
      { installId: "i1", by: "u-grace", untilCapResets: true },
      { newId: () => "jr1" },
    );
    expect(w.created).toEqual([
      { kind: "resume", jobId: "jr1", installId: "i1", by: "u-grace", untilCapResets: true },
    ]);
    expect(await jobRow("jr1")).toMatchObject({
      kind: "resume",
      status: "queued",
      started_by: "admin",
    });
  });

  it("refuses an app that is not paused", async () => {
    await expect(
      startResume({ DB: env.DB, JOBS: jobs().JOBS }, { installId: "i1", by: "u-grace" }),
    ).rejects.toThrow("This app is not paused.");
  });
});

describe("a paused app", () => {
  beforeEach(async () => {
    await seedPause("succeeded");
  });

  it("refuses updates, rollbacks and settings changes until it is resumed", async () => {
    for (const kind of ["update", "rollback", "reconfigure"] as const) {
      await expect(
        claim(
          { db: env.DB, createJob: async (id) => ({ id }) },
          {
            installId: "i1",
            kind,
            inputJson: "{}",
            params: { jobId: `j-${kind}` },
          },
        ),
      ).rejects.toThrow(PAUSED_REFUSAL);
    }
    const { results } = await env.DB.prepare(
      "SELECT id FROM jobs WHERE kind IN ('update', 'rollback', 'reconfigure')",
    ).all();
    expect(results).toEqual([]);
    expect(
      (await env.DB.prepare("SELECT status FROM installs WHERE id = 'i1'").first())?.status,
    ).toBe("installed");
  });

  it("refuses an update before it asks for anything", async () => {
    const refused = startUpdateCore(
      {
        db: env.DB,
        createJob: async (id) => ({ id }),
        loadApp: async () => {
          throw new Error("not reached");
        },
        loadManifest: async () => {
          throw new Error("not reached");
        },
      },
      { installId: "i1" },
    );
    await expect(refused).rejects.toBeInstanceOf(VersionActionError);
    await expect(refused).rejects.toThrow(PAUSED_REFUSAL);
  });

  it("is not health checked, so its paused page never reads as an app that is down", async () => {
    await expect(
      checkInstallHealthCore(
        {
          db: env.DB,
          fetch: async () => {
            throw new Error("not reached");
          },
        },
        { installId: "i1" },
      ),
    ).rejects.toBeInstanceOf(HealthCheckError);
  });

  it("can still be uninstalled", async () => {
    await expect(
      startUninstallCore(
        { db: env.DB, createJob: async (id) => ({ id }), newId: () => "ju1" },
        { installId: "i1" },
      ),
    ).resolves.toEqual({ jobId: "ju1" });
  });
});
