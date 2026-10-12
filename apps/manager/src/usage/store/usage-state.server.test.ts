import { reset } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { beforeEach, describe, expect, it } from "vitest";
import { createDb } from "../../db/client";
import { createMigrator } from "../../db/migrate";
import { migrations } from "../../db/migrations/index";
import {
  initialUsageState,
  readUsageState,
  readUsageStates,
  updateUsageState,
  writeUsageStates,
} from "./usage-state.server";

const db = () => createDb(env.DB);
const NOW = new Date("2026-10-12T10:00:00Z");
const later = (minutes: number) => new Date(NOW.getTime() + minutes * 60_000);

beforeEach(async () => {
  await reset();
  await createMigrator(migrations).ensure(env.DB);
});

describe("usage state", () => {
  it("reads an install never checked as the initial state", async () => {
    expect(await readUsageState(db(), "a")).toEqual(initialUsageState("a"));
  });

  it("writes whole states for many installs and reads them back", async () => {
    const states = Array.from({ length: 40 }, (_, i) => ({
      ...initialUsageState(`app-${i}`),
      loopChecks: i % 3,
      lastBurn: i / 10,
      normalBurn: 0.01,
    }));
    await writeUsageStates(db(), states, NOW);
    await writeUsageStates(
      db(),
      [
        {
          ...initialUsageState("app-1"),
          lastBurn: 0.1,
          normalBurn: 0.01,
          loopChecks: 2,
          unusualSince: NOW.getTime(),
          limitWarnedDay: 1_791_763_200,
        },
      ],
      later(5),
    );

    const read = await readUsageStates(db(), ["app-0", "app-1", "missing"]);
    expect(read.get("app-0")).toEqual({
      ...initialUsageState("app-0"),
      lastBurn: 0,
      normalBurn: 0.01,
      lastCheckedAt: NOW.getTime(),
    });
    expect(read.get("app-1")).toEqual({
      installId: "app-1",
      loopChecks: 2,
      unusualSince: NOW.getTime(),
      limitWarnedDay: 1_791_763_200,
      lastCheckedAt: later(5).getTime(),
      lastBurn: 0.1,
      normalBurn: 0.01,
    });
    expect(read.get("missing")).toEqual(initialUsageState("missing"));
  });

  it("changes part of a state without marking the install checked", async () => {
    expect(await updateUsageState(db(), "a", { loopChecks: 1 })).toEqual({
      ...initialUsageState("a"),
      loopChecks: 1,
    });
    await writeUsageStates(
      db(),
      [{ ...initialUsageState("a"), loopChecks: 2, unusualSince: 5 }],
      NOW,
    );
    expect(await updateUsageState(db(), "a", { unusualSince: null })).toMatchObject({
      loopChecks: 2,
      unusualSince: null,
      lastCheckedAt: NOW.getTime(),
    });
    expect(await updateUsageState(db(), "a", {})).toMatchObject({ loopChecks: 2 });
  });
});
