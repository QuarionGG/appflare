import { reset } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { beforeEach, describe, expect, it } from "vitest";
import { ZodError } from "zod";
import { createDb } from "../../db/client";
import { createMigrator } from "../../db/migrate";
import { migrations } from "../../db/migrations/index";
import {
  effectiveSpendSettings,
  effectiveSpendSettingsOf,
  readAppSpendSettings,
  readCustomizedAppSpendSettings,
  writeAppSpendSettings,
} from "./app-settings.server";
import { writeSpendDefaults } from "./defaults.server";
import { defaultAppSpendSettings } from "./spend-settings";

const db = () => createDb(env.DB);
const NOW = new Date("2026-10-12T10:00:00Z");

beforeEach(async () => {
  await reset();
  await createMigrator(migrations).ensure(env.DB);
});

describe("app spend settings", () => {
  it("reads an app nobody changed as following the account", async () => {
    expect(await readAppSpendSettings(db(), "a")).toEqual(defaultAppSpendSettings("a"));
  });

  it("changes only the patched settings and records who and when", async () => {
    await writeAppSpendSettings(
      db(),
      "a",
      { autoPause: "on", capAmount: 3 },
      { userId: "u1", now: NOW },
    );
    const later = new Date(NOW.getTime() + 60_000);
    const after = await writeAppSpendSettings(
      db(),
      "a",
      { customTriggers: true, capPeriod: "week", capSetAsideUntil: later.getTime() },
      { userId: "u2", now: later },
    );
    expect(after).toEqual({
      ...defaultAppSpendSettings("a"),
      autoPause: "on",
      capAmount: 3,
      customTriggers: true,
      capPeriod: "week",
      capSetAsideUntil: later.getTime(),
      updatedAt: later.getTime(),
      updatedBy: "u2",
    });
    const cleared = await writeAppSpendSettings(
      db(),
      "a",
      { capAmount: null, capSetAsideUntil: null, unusualFactor: 0 },
      { userId: "u2", now: later },
    );
    expect(cleared).toMatchObject({ capAmount: null, capSetAsideUntil: null, unusualFactor: 0 });
    expect(cleared.autoPause).toBe("on");
  });

  it("refuses bad values", async () => {
    await expect(
      writeAppSpendSettings(db(), "a", { capAmount: 0 }, { userId: "u1" }),
    ).rejects.toThrow(ZodError);
    // 50× is not one of the choices (5×, 20×, 100×, off); a caller past the types is refused.
    const fifty = { unusualFactor: 50 } as unknown as { unusualFactor: 20 };
    await expect(writeAppSpendSettings(db(), "a", fifty, { userId: "u1" })).rejects.toThrow(
      ZodError,
    );
  });

  it("reads a stored factor that is not a choice as following the account", async () => {
    await env.DB.prepare(
      "INSERT INTO app_spend_settings (install_id, unusual_factor, updated_at, updated_by) VALUES ('a', 7, 0, 'u1')",
    ).run();
    expect((await readAppSpendSettings(db(), "a")).unusualFactor).toBeNull();
  });

  it("resolves an app's effective settings against the account's", async () => {
    await writeSpendDefaults(db(), {
      autoPause: true,
      cap: { on: true, amount: 12, period: "week" },
    });
    await writeAppSpendSettings(
      db(),
      "a",
      { autoPause: "off", budgetExempt: true },
      { userId: "u1" },
    );
    await writeAppSpendSettings(
      db(),
      "b",
      { customTriggers: true, capAmount: 2, loopOn: false },
      { userId: "u1" },
    );

    const a = await effectiveSpendSettings(db(), "a");
    expect(a.autoPause).toEqual({ on: false, followsAccount: false });
    expect(a.budgetExempt).toBe(true);
    expect(a.triggers.cap).toEqual({ on: true, amount: 12, period: "week" });

    const all = await effectiveSpendSettingsOf(db(), ["a", "b", "c"]);
    expect([...all.keys()]).toEqual(["a", "b", "c"]);
    expect(all.get("b")?.triggers).toEqual({
      custom: true,
      loop: { on: false, level: "standard" },
      cap: { on: true, amount: 2, period: "day" },
    });
    expect(all.get("c")?.autoPause).toEqual({ on: true, followsAccount: true });

    const customized = await readCustomizedAppSpendSettings(db());
    expect(customized.map((s) => s.installId).sort()).toEqual(["a", "b"]);
  });
});
