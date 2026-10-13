import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import {
  createSpendWatcherUnits,
  isHalfHourRun,
  runScheduled,
  selfSpendWatcher,
} from "./watcher-unit";

const at = (iso: string) => Date.parse(iso);

describe("isHalfHourRun", () => {
  it("is true for the runs scheduled at minute 0 and 30 only", () => {
    expect(isHalfHourRun(at("2026-10-12T16:00:00Z"))).toBe(true);
    expect(isHalfHourRun(at("2026-10-12T16:30:00Z"))).toBe(true);
    for (const minute of ["05", "10", "15", "20", "25", "35", "40", "45", "50", "55"]) {
      expect(isHalfHourRun(at(`2026-10-12T16:${minute}:00Z`)), minute).toBe(false);
    }
  });

  it("goes by the scheduled time, by the five-minute slot it falls in", () => {
    expect(isHalfHourRun(at("2026-10-12T16:29:59.600Z"))).toBe(true);
    expect(isHalfHourRun(at("2026-10-12T16:05:00.200Z"))).toBe(false);
  });

  it("finds the half-hour run when Cloudflare schedules it seconds late", () => {
    // Scheduled times seen on live managers for the minute-0 and minute-30 runs.
    expect(isHalfHourRun(at("2026-10-12T23:00:44Z"))).toBe(true);
    expect(isHalfHourRun(at("2026-10-12T22:30:39Z"))).toBe(true);
    expect(isHalfHourRun(at("2026-10-12T20:00:13Z"))).toBe(true);
    expect(isHalfHourRun(at("2026-10-12T23:05:44Z"))).toBe(false);
    expect(isHalfHourRun(at("2026-10-12T22:55:44Z"))).toBe(false);
  });

  it("takes a run up to 4.5 minutes late for its slot, and never does the work twice", () => {
    expect(isHalfHourRun(at("2026-10-12T23:02:40Z"))).toBe(true);
    expect(isHalfHourRun(at("2026-10-12T23:04:20Z"))).toBe(true);
    expect(isHalfHourRun(at("2026-10-12T23:34:29Z"))).toBe(true);
    // Past 4.5 minutes it is the next slot's run.
    expect(isHalfHourRun(at("2026-10-12T23:04:31Z"))).toBe(false);
    // Half a minute early still counts; a minute early is the slot before.
    expect(isHalfHourRun(at("2026-10-12T22:59:31Z"))).toBe(true);
    expect(isHalfHourRun(at("2026-10-12T22:59:00Z"))).toBe(false);
    // One run a slot: of a run at 23:04:20 and the next at 23:05:10, only the first.
    const runs = ["23:04:20", "23:05:10", "23:10:00", "23:15:00", "23:20:00", "23:25:00"];
    expect(runs.filter((t) => isHalfHourRun(at(`2026-10-12T${t}Z`)))).toEqual(["23:04:20"]);
  });
});

describe("runScheduled", () => {
  function recorder(failWatch = false) {
    const calls: string[] = [];
    return {
      calls,
      work: {
        watch: async (options: { maintenance: boolean }) => {
          calls.push(`watch${options.maintenance ? " +maintenance" : ""}`);
          if (failWatch) throw new Error("no");
        },
        halfHourly: async () => {
          calls.push("half-hourly");
        },
      },
    };
  }

  it("runs the watcher every run and the rest only at minute 0 and 30", async () => {
    const runs: Record<string, string[]> = {};
    for (const minute of ["00", "05", "25", "30", "35"]) {
      const r = recorder();
      await runScheduled(at(`2026-10-12T16:${minute}:00Z`), r.work);
      runs[minute] = r.calls;
    }
    expect(runs).toEqual({
      "00": ["watch +maintenance", "half-hourly"],
      "05": ["watch"],
      "25": ["watch"],
      "30": ["watch +maintenance", "half-hourly"],
      "35": ["watch"],
    });
  });

  it("never lets the watcher fail the run", async () => {
    const r = recorder(true);
    await runScheduled(at("2026-10-12T16:30:00Z"), r.work);
    expect(r.calls).toEqual(["watch +maintenance", "half-hourly"]);
  });
});

describe("the watcher unit", () => {
  it("validates its input and answers with plain data", async () => {
    const units = createSpendWatcherUnits({ ...env, SELF: undefined });
    expect(await units.watchSpend({ maintenance: "yes" })).toMatchObject({ ok: false });
    expect(await units.spendShard({ now: "soon" })).toMatchObject({ ok: false });
  });

  it("is served over SELF", async () => {
    const self = selfSpendWatcher(env);
    expect(self).toBeDefined();
    const result = await self?.watchSpend({ maintenance: 1 });
    expect(result).toMatchObject({ ok: false, error: expect.stringContaining("maintenance") });
  }, 30_000);
});
