import { reset } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { beforeEach, describe, expect, it } from "vitest";
import { createDb } from "../db/client";
import { createMigrator } from "../db/migrate";
import { migrations } from "../db/migrations/index";
import { HOUR_MS, type Usage } from "./math";
import { resumeBaseKey, resumeWindows } from "./resume.server";
import { closePause, openPause } from "./store/pauses.server";

const NOW = Date.parse("2026-10-14T12:30:00Z");
const HOUR = Date.parse("2026-10-14T12:00:00Z");
const RESUMED = NOW - 10 * 60_000;

const db = () => createDb(env.DB);

async function install(id: string) {
  await env.DB.prepare(
    `INSERT INTO installs (id, app_slug, worker_name, instance_name, catalog_version, artifact_url,
       artifact_digest, pin_sha, status, current_version_id, config_json, manifest_json,
       installed_at, updated_at)
     VALUES (?1, ?1, ?1, ?1, '1.0.0', 'https://artifacts.test/a.zip', ?2, 'sha', 'installed', 'v1', '{}', '{}', 1, 1)`,
  )
    .bind(id, "0".repeat(64))
    .run();
}

/** Paused at `pausedAt`, closed at `closedAt` by a resume job (or, without one, by a failed pause). */
async function pauseAndClose(id: string, pausedAt: number, closedAt: number, job: boolean) {
  await openPause(db(), {
    installId: id,
    pausedBy: "auto",
    reason: "loop",
    pausedAt: new Date(pausedAt),
  });
  await closePause(db(), id, {
    resumedBy: job ? "u-ada" : null,
    resumedAt: new Date(closedAt),
    ...(job ? { resumeJobId: `job-${id}` } : {}),
  });
}

const usage = (value: number): Map<string, Usage> =>
  new Map([
    ["a", { do_rows_written: [{ hour: HOUR, value }] }],
    ["b", { do_rows_written: [{ hour: HOUR, value }] }],
  ]);

beforeEach(async () => {
  await reset();
  await createMigrator(migrations).ensure(env.DB);
  await install("a");
  await install("b");
});

describe("resumeWindows", () => {
  it("counts resumes a resume job ran, not pauses that failed and closed themselves", async () => {
    await pauseAndClose("a", NOW - HOUR_MS, RESUMED, true);
    await pauseAndClose("b", NOW - HOUR_MS, RESUMED, false);
    const windows = await resumeWindows(db(), env.KV, {
      now: NOW,
      installIds: ["a", "b"],
      usage: usage(1e6),
      keep: false,
    });
    expect([...windows.keys()]).toEqual(["a"]);
    expect(windows.get("a")).toEqual({ at: RESUMED, base: { do_rows_written: 1e6 } });
  });

  it("keeps the resume hour's base from the first check after the resume", async () => {
    await pauseAndClose("a", NOW - HOUR_MS, RESUMED, true);
    await resumeWindows(db(), env.KV, {
      now: NOW,
      installIds: ["a"],
      usage: usage(1e6),
      keep: true,
    });
    expect(JSON.parse((await env.KV.get(resumeBaseKey("a"))) ?? "null")).toEqual({
      at: RESUMED,
      base: { do_rows_written: 1e6 },
    });
    // The next check sees the hour grown: the base stays what it was at the resume.
    const later = await resumeWindows(db(), env.KV, {
      now: NOW + 5 * 60_000,
      installIds: ["a"],
      usage: usage(3e6),
      keep: true,
    });
    expect(later.get("a")?.base).toEqual({ do_rows_written: 1e6 });
  });

  it("takes the base from the rows the last check before the resume stored, when there is one", async () => {
    await pauseAndClose("a", NOW - HOUR_MS, RESUMED, true);
    // Stored while paused: 1M. Since the resume this check collected 1.2M more.
    const windows = await resumeWindows(db(), env.KV, {
      now: NOW,
      installIds: ["a"],
      usage: usage(2.2e6),
      before: usage(1e6),
      keep: true,
    });
    expect(windows.get("a")?.base).toEqual({ do_rows_written: 1e6 });
  });

  it("falls back to the hour as it is now when no row of it was stored before", async () => {
    await pauseAndClose("a", NOW - HOUR_MS, RESUMED, true);
    const windows = await resumeWindows(db(), env.KV, {
      now: NOW,
      installIds: ["a"],
      usage: usage(2.2e6),
      before: new Map([["a", {}]]),
      keep: false,
    });
    expect(windows.get("a")?.base).toEqual({ do_rows_written: 2.2e6 });
  });

  it("forgets a resume once it no longer shapes the last hour", async () => {
    await pauseAndClose("a", NOW - 4 * HOUR_MS, NOW - 3 * HOUR_MS + 60_000, true);
    const windows = await resumeWindows(db(), env.KV, {
      now: NOW,
      installIds: ["a"],
      usage: usage(1e6),
      keep: true,
    });
    expect(windows.size).toBe(0);
  });
});
