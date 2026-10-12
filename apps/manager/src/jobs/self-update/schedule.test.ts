import { reset } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { parseJsonc } from "@appflare/schema";
import { beforeEach, describe, expect, it } from "vitest";
import wranglerConfig from "../../../wrangler.jsonc?raw";
import { createDb } from "../../db/client";
import { createMigrator } from "../../db/migrate";
import { migrations } from "../../db/migrations/index";
import { readSettings, SETTING, writeSettings } from "../../db/settings";
import {
  applyManagerCrons,
  compareVersions,
  cronsOfVersion,
  ensureOwnSchedule,
  LEGACY_MANAGER_CRONS,
  MANAGER_CRONS,
  ownScheduleLog,
  sameCrons,
} from "./schedule";

function fakeSchedules(crons: string[], fail = 0) {
  const state = { crons, puts: 0, gets: 0, fail };
  return {
    state,
    workers: {
      getSchedules: async () => {
        state.gets += 1;
        if (state.fail > 0) {
          state.fail -= 1;
          throw new Error("schedules unavailable");
        }
        return { schedules: state.crons.map((cron) => ({ cron })) };
      },
      putSchedules: async (_name: string, body: Array<{ cron: string }>) => {
        state.puts += 1;
        state.crons = body.map((b) => b.cron);
        return { schedules: body };
      },
    },
  };
}

describe("MANAGER_CRONS", () => {
  it("is the schedule wrangler.jsonc deploys", () => {
    const config = parseJsonc(wranglerConfig) as { triggers?: { crons?: string[] } };
    expect(config.triggers?.crons).toEqual([...MANAGER_CRONS]);
  });
});

describe("sameCrons", () => {
  it("compares schedules in any order", () => {
    expect(sameCrons(["*/5 * * * *", "0 3 * * *"], ["0 3 * * *", "*/5 * * * *"])).toBe(true);
    expect(sameCrons(["*/5 * * * *"], ["*/30 * * * *"])).toBe(false);
    expect(sameCrons([], [])).toBe(true);
  });
});

describe("cronsOfVersion", () => {
  const known = { "0.5.0": ["*/5 * * * *"], "0.6.0": ["*/5 * * * *", "0 4 * * *"] };

  it("is a recorded version's own schedule", () => {
    expect(cronsOfVersion(known, "0.6.0", "0.7.0")).toEqual(["*/5 * * * *", "0 4 * * *"]);
  });

  it("is the old */30 for a version from before versions recorded their schedule", () => {
    expect(cronsOfVersion(known, "0.4.3", "0.7.0")).toEqual(LEGACY_MANAGER_CRONS);
    expect(cronsOfVersion({}, "0.4.3", "0.5.0")).toEqual(["*/30 * * * *"]);
  });

  it("is null for a later version that recorded nothing", () => {
    expect(cronsOfVersion(known, "0.5.5", "0.7.0")).toBeNull();
  });

  it("orders versions by number, not as text", () => {
    expect(compareVersions("0.10.0", "0.9.0")).toBeGreaterThan(0);
    expect(compareVersions("1.0.0-beta.1", "1.0.0")).toBe(0);
  });
});

describe("applyManagerCrons", () => {
  it("puts the schedule only when it differs", async () => {
    const differs = fakeSchedules(["*/30 * * * *"]);
    expect(await applyManagerCrons(differs, "appflare", ["*/5 * * * *"])).toEqual({
      status: "changed",
      from: ["*/30 * * * *"],
      to: ["*/5 * * * *"],
    });
    expect(differs.state.puts).toBe(1);
    const same = fakeSchedules(["*/5 * * * *"]);
    expect((await applyManagerCrons(same, "appflare", ["*/5 * * * *"])).status).toBe("unchanged");
    expect(same.state.puts).toBe(0);
  });
});

describe("ensureOwnSchedule", () => {
  beforeEach(async () => {
    await reset();
    await createMigrator(migrations).ensure(env.DB);
    await writeSettings(createDb(env.DB), { [SETTING.workerName]: "appflare" });
  });
  const run = (api: ReturnType<typeof fakeSchedules>, version = "0.5.0") =>
    ensureOwnSchedule({ DB: env.DB, APPFLARE_VERSION: version }, { api });

  it("moves a manager from */30 to this build's schedule, once per version", async () => {
    const api = fakeSchedules(["*/30 * * * *"]);
    const first = await run(api);
    expect(first).toEqual({
      status: "checked",
      change: { status: "changed", from: ["*/30 * * * *"], to: ["*/5 * * * *"] },
    });
    expect(ownScheduleLog(first)).toBe("cron triggers set to */5 * * * * (were */30 * * * *)");
    expect(api.state.crons).toEqual(["*/5 * * * *"]);
    // The next runs of the same version read one setting and stop.
    expect(await run(api)).toEqual({ status: "done" });
    expect(api.state.gets).toBe(1);
    const stored = await readSettings(createDb(env.DB), [SETTING.managerCrons]);
    expect(JSON.parse(stored.manager_crons ?? "{}")).toEqual({ "0.5.0": ["*/5 * * * *"] });
    // A new version checks again.
    expect((await run(api, "0.5.1")).status).toBe("checked");
    expect(api.state.gets).toBe(2);
  });

  it("puts nothing when the schedule is already this build's", async () => {
    const api = fakeSchedules(["*/5 * * * *"]);
    const outcome = await run(api);
    expect(outcome).toMatchObject({ status: "checked", change: { status: "unchanged" } });
    expect(ownScheduleLog(outcome)).toBeNull();
    expect(api.state.puts).toBe(0);
  });

  it("checks again for every deployed Worker version of the same release", async () => {
    const api = fakeSchedules(["*/5 * * * *"]);
    const deployed = (id: string) =>
      ensureOwnSchedule(
        { DB: env.DB, APPFLARE_VERSION: "0.5.0", CF_VERSION_METADATA: { id } },
        { api },
      );
    expect((await deployed("v1")).status).toBe("checked");
    expect((await deployed("v1")).status).toBe("done");
    expect((await deployed("v2")).status).toBe("checked");
    const marked = await readSettings(createDb(env.DB), [SETTING.managerScheduleVersion]);
    expect(marked.manager_schedule_version).toBe("v2");
  });

  it("tries again on the next run after a failure", async () => {
    const api = fakeSchedules(["*/30 * * * *"], 1);
    const failed = await run(api);
    expect(failed).toEqual({ status: "failed", error: "schedules unavailable" });
    expect(ownScheduleLog(failed)).toBe("cron triggers not checked: schedules unavailable");
    expect((await run(api)).status).toBe("checked");
    expect(api.state.crons).toEqual(["*/5 * * * *"]);
  });

  it("waits while the manager does not know its Worker yet", async () => {
    await reset();
    await createMigrator(migrations).ensure(env.DB);
    const api = fakeSchedules(["*/30 * * * *"]);
    expect(await run(api)).toEqual({ status: "skipped" });
    expect(api.state.gets).toBe(0);
  });
});
