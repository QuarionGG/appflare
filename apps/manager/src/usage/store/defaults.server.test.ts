import { reset } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { beforeEach, describe, expect, it } from "vitest";
import { ZodError } from "zod";
import { createDb } from "../../db/client";
import { createMigrator } from "../../db/migrate";
import { migrations } from "../../db/migrations/index";
import { readSpendDefaults, writeSpendDefaults } from "./defaults.server";
import { DEFAULT_SPEND_DEFAULTS } from "./spend-settings";

const db = () => createDb(env.DB);
const _NOW = new Date("2026-10-12T10:00:00Z");

beforeEach(async () => {
  await reset();
  await createMigrator(migrations).ensure(env.DB);
});

describe("account spend defaults", () => {
  it("reads the defaults before anything is stored", async () => {
    expect(await readSpendDefaults(db())).toEqual({
      autoPause: false,
      loop: { on: true, level: "standard" },
      cap: { on: true, amount: 10, period: "month" },
      budget: { on: false, amount: 50 },
      unusualFactor: 20,
    });
  });

  it("writes only what changed, one settings row each", async () => {
    const after = await writeSpendDefaults(db(), {
      autoPause: true,
      budget: { on: true, amount: 40 },
    });
    expect(after).toEqual({
      ...DEFAULT_SPEND_DEFAULTS,
      autoPause: true,
      budget: { on: true, amount: 40 },
    });
    await writeSpendDefaults(db(), { unusualFactor: 100, loop: { on: false, level: "relaxed" } });
    expect(await readSpendDefaults(db())).toEqual({
      ...DEFAULT_SPEND_DEFAULTS,
      autoPause: true,
      budget: { on: true, amount: 40 },
      unusualFactor: 100,
      loop: { on: false, level: "relaxed" },
    });
    const { results } = await env.DB.prepare(
      "SELECT key, value FROM settings WHERE key LIKE 'spend_%' ORDER BY key",
    ).all();
    expect(results).toEqual([
      { key: "spend_auto_pause", value: "on" },
      { key: "spend_budget", value: '{"on":true,"amount":40}' },
      { key: "spend_loop", value: '{"on":false,"level":"relaxed"}' },
      { key: "spend_unusual_factor", value: "100" },
    ]);
  });

  it("refuses bad values, and reads an unreadable row as the default", async () => {
    await expect(
      writeSpendDefaults(db(), { cap: { on: true, amount: -1, period: "month" } }),
    ).rejects.toThrow(ZodError);
    await env.DB.prepare(
      "INSERT INTO settings (key, value, updated_at) VALUES ('spend_cap', '{\"on\":true}', 0), ('spend_unusual_factor', 'x', 0)",
    ).run();
    const read = await readSpendDefaults(db());
    expect(read.cap).toEqual(DEFAULT_SPEND_DEFAULTS.cap);
    expect(read.unusualFactor).toBe(20);
  });
});
