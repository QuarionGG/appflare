import { reset } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { beforeEach, describe, expect, it } from "vitest";
import { ZodError } from "zod";
import { createDb } from "../../db/client";
import { createMigrator } from "../../db/migrate";
import { migrations } from "../../db/migrations/index";
import {
  closePause,
  findOpenPause,
  listOpenPauses,
  listPauses,
  openPause,
  recordPauseProgress,
} from "./pauses.server";

const db = () => createDb(env.DB);
const NOW = new Date("2026-10-12T10:00:00Z");
const later = (minutes: number) => new Date(NOW.getTime() + minutes * 60_000);

beforeEach(async () => {
  await reset();
  await createMigrator(migrations).ensure(env.DB);
});

describe("pauses", () => {
  it("opens one pause per install, records progress, and closes it on resume", async () => {
    const first = await openPause(db(), {
      installId: "a",
      pausedBy: "auto",
      reason: "cap",
      detailJson: '{"amount":10,"period":"month"}',
      pausedAt: NOW,
    });
    expect(first.opened).toBe(true);
    expect(first.pause).toMatchObject({
      installId: "a",
      pausedBy: "auto",
      reason: "cap",
      pausedAt: NOW.getTime(),
      workerVersions: null,
      resumedAt: null,
    });

    const again = await openPause(db(), { installId: "a", pausedBy: "u1", reason: "manual" });
    expect(again).toEqual({ opened: false, pause: first.pause });

    const progressed = await recordPauseProgress(db(), first.pause.id, {
      workerVersions: { "open-seo": "v1", "open-seo-worker": "v2" },
      jobId: "job-1",
      queuesJson: '["q1"]',
    });
    expect(progressed).toMatchObject({
      workerVersions: { "open-seo": "v1", "open-seo-worker": "v2" },
      jobId: "job-1",
      queuesJson: '["q1"]',
    });
    expect(await findOpenPause(db(), "a")).toEqual(progressed);
    expect(await findOpenPause(db(), "b")).toBeNull();
    expect((await listOpenPauses(db())).map((p) => p.id)).toEqual([first.pause.id]);

    // A resume job that failed leaves the pause open, with the job recorded.
    expect(
      (await recordPauseProgress(db(), first.pause.id, { resumeJobId: "job-r1" }))?.resumeJobId,
    ).toBe("job-r1");
    const closed = await closePause(db(), "a", {
      resumedBy: "u1",
      resumedAt: later(30),
      resumeJobId: "job-r2",
    });
    expect(closed).toMatchObject({
      id: first.pause.id,
      resumedAt: later(30).getTime(),
      resumedBy: "u1",
      resumeJobId: "job-r2",
    });
    expect(await closePause(db(), "a", { resumedBy: "u1" })).toBeNull();
    expect(await findOpenPause(db(), "a")).toBeNull();
    expect(await recordPauseProgress(db(), first.pause.id, { jobId: "job-2" })).toBeNull();

    const next = await openPause(db(), {
      installId: "a",
      pausedBy: "u1",
      reason: "manual",
      pausedAt: later(60),
    });
    expect(next.opened).toBe(true);
    expect((await listPauses(db(), "a")).map((p) => p.id)).toEqual([next.pause.id, first.pause.id]);
  });

  it("closes a pause Appflare undid on its own, by no one", async () => {
    await openPause(db(), { installId: "a", pausedBy: "auto", reason: "loop", pausedAt: NOW });
    const closed = await closePause(db(), "a", { resumedBy: null, resumedAt: later(1) });
    expect(closed).toMatchObject({
      resumedBy: null,
      resumedAt: later(1).getTime(),
      resumeJobId: null,
    });
    expect(await findOpenPause(db(), "a")).toBeNull();
  });

  it("stores each Worker's version as JSON, refuses a bad value, and reads a broken one as unknown", async () => {
    const { pause } = await openPause(db(), {
      installId: "a",
      pausedBy: "auto",
      reason: "loop",
      workerVersions: { web: "v1" },
    });
    const stored = await env.DB.prepare("SELECT worker_versions_json AS v FROM app_pauses").first();
    expect(stored).toEqual({ v: '{"web":"v1"}' });

    await expect(recordPauseProgress(db(), pause.id, { workerVersions: {} })).rejects.toThrow(
      ZodError,
    );
    await expect(
      recordPauseProgress(db(), pause.id, { workerVersions: { web: "" } }),
    ).rejects.toThrow(ZodError);

    await env.DB.prepare("UPDATE app_pauses SET worker_versions_json = '[\"v1\"]'").run();
    expect((await findOpenPause(db(), "a"))?.workerVersions).toBeNull();
    expect(
      (await recordPauseProgress(db(), pause.id, { workerVersions: null }))?.workerVersions,
    ).toBeNull();
  });
});
