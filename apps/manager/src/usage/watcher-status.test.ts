import { reset } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { beforeEach, describe, expect, it } from "vitest";
import { createDb } from "../db/client";
import { createMigrator } from "../db/migrate";
import { migrations } from "../db/migrations/index";
import { readSettings, SETTING } from "../db/settings";
import { readSpendWatchStatus, writeSpendWatchStatus } from "./watcher-status";

const AT = Date.UTC(2026, 9, 13, 8, 0);

beforeEach(async () => {
  await reset();
  await createMigrator(migrations).ensure(env.DB);
});

/** The manager's D1, refusing every statement that carries `refused` among its values. */
function refusing(refused: string): D1Database {
  return new Proxy(env.DB, {
    get(target, key) {
      if (key !== "prepare") return Reflect.get(target, key);
      return (query: string) => {
        const statement = target.prepare(query);
        return new Proxy(statement, {
          get(s, k) {
            if (k !== "bind") return Reflect.get(s, k).bind?.(s) ?? Reflect.get(s, k);
            return (...values: unknown[]) => {
              if (values.includes(refused)) throw new Error("D1_ERROR: row too big");
              return s.bind(...values);
            };
          },
        });
      };
    },
  });
}

describe("writeSpendWatchStatus", () => {
  it("stores the status and the rows stored with it in one go", async () => {
    const result = await writeSpendWatchStatus(
      createDb(env.DB),
      { state: "watching", at: AT },
      { [SETTING.spendOverview]: "{}" },
    );
    expect(result).toEqual({});
    expect(await readSpendWatchStatus(createDb(env.DB))).toEqual({ state: "watching", at: AT });
    expect(await readSettings(createDb(env.DB), [SETTING.spendOverview])).toEqual({
      spend_overview: "{}",
    });
  });

  it("still stores the status when a row stored with it fails, and says what failed", async () => {
    const db = createDb(refusing(SETTING.spendOverview));
    const result = await writeSpendWatchStatus(
      db,
      { state: "needs_access", at: AT, via: "token", missing: [] },
      { [SETTING.spendOverview]: "{}" },
    );
    expect(String((result.alongsideError as Error).cause)).toContain("row too big");
    expect(await readSpendWatchStatus(createDb(env.DB))).toEqual({
      state: "needs_access",
      at: AT,
      via: "token",
      missing: [],
    });
    expect(await readSettings(createDb(env.DB), [SETTING.spendOverview])).toEqual({});
  });

  it("throws when the status itself cannot be stored", async () => {
    const db = createDb(refusing(SETTING.spendWatch));
    const error = await writeSpendWatchStatus(db, { state: "watching", at: AT }).catch((e) => e);
    expect(String((error as Error).cause)).toContain("row too big");
  });
});
