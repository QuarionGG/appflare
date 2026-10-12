import { reset } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { writeAccountPlan } from "../account/plan.server";
import { createDb } from "../db/client";
import { createMigrator } from "../db/migrate";
import { migrations } from "../db/migrations/index";
import {
  checkBudgetAmount,
  checkCapAmount,
  parseDollars,
  setSpendDefaultsInput,
} from "./spend-defaults";
import type { SpendProtectionData } from "./spend-defaults.functions";
import { listActivity } from "./store/activity.server";
import { readSpendDefaults } from "./store/defaults.server";
import { DEFAULT_SPEND_DEFAULTS, type SpendDefaults } from "./store/spend-settings";

/**
 * The server functions behind Settings → Your account → Spend protection:
 * everyone signed in reads the defaults and the numbers, only an admin
 * changes them, and each change is recorded in the account's usage activity
 * by the names of the settings it changed. TanStack Start's `createServerFn`
 * is replaced by a chain that returns the handler; the rest runs for real on
 * the local D1. The input schema is tested on its own, since the chain skips
 * the validator.
 */

const { requireRole, requireSession } = vi.hoisted(() => ({
  requireRole: vi.fn(),
  requireSession: vi.fn(),
}));

vi.mock("@tanstack/react-start", () => {
  const chain = {
    validator: () => chain,
    inputValidator: () => chain,
    handler: (fn: unknown) => fn,
  };
  return { createServerFn: () => chain };
});
vi.mock("../server/auth.server", () => ({ requireRole, requireSession }));

const { getSpendProtection, setSpendDefaults } = await import("./spend-defaults.functions");
const get = getSpendProtection as unknown as () => Promise<SpendProtectionData>;
const set = setSpendDefaults as unknown as (args: {
  data: Partial<SpendDefaults>;
}) => Promise<SpendDefaults>;

const ADMIN = { user: { id: "user-admin", role: "admin" }, session: { id: "s" } };
const MEMBER = { user: { id: "user-member", role: "member" }, session: { id: "s" } };
const db = () => createDb(env.DB);

beforeEach(async () => {
  await reset();
  await createMigrator(migrations).ensure(env.DB);
  requireRole.mockReset();
  requireSession.mockReset();
});

describe("getSpendProtection", () => {
  it("lets any signed-in user read the defaults and where the apps stand", async () => {
    requireSession.mockResolvedValue(MEMBER);
    const data = await get();
    expect(requireSession).toHaveBeenCalled();
    expect(requireRole).not.toHaveBeenCalled();
    expect(data.defaults).toEqual(DEFAULT_SPEND_DEFAULTS);
    expect(data.overview).toMatchObject({ plan: "free", apps: [], budgetPick: null });
  });

  it("refuses anyone not signed in", async () => {
    requireSession.mockRejectedValue(new Error("Sign in first."));
    await expect(get()).rejects.toThrow("Sign in first.");
  });
});

describe("setSpendDefaults", () => {
  it("refuses a member and changes nothing", async () => {
    requireRole.mockRejectedValue(new Error("You do not have permission to do that."));
    await expect(set({ data: { autoPause: true } })).rejects.toThrow(
      "You do not have permission to do that.",
    );
    expect(requireRole).toHaveBeenCalledWith("admin");
    expect(await readSpendDefaults(db())).toEqual(DEFAULT_SPEND_DEFAULTS);
    expect(await listActivity(db())).toEqual([]);
  });

  it("saves an admin's change and records which settings changed, for the account", async () => {
    requireRole.mockResolvedValue(ADMIN);
    await writeAccountPlan(db(), "paid");
    const saved = await set({
      data: {
        autoPause: true,
        cap: { on: true, amount: 25, period: "week" },
        // The same as before: not a change.
        loop: { on: true, level: "standard" },
      },
    });
    expect(saved).toEqual({
      ...DEFAULT_SPEND_DEFAULTS,
      autoPause: true,
      cap: { on: true, amount: 25, period: "week" },
    });
    expect(await readSpendDefaults(db())).toEqual(saved);
    const [entry, ...rest] = await listActivity(db());
    expect(rest).toEqual([]);
    expect(entry).toMatchObject({
      installId: null,
      kind: "settings_changed",
      by: "user-admin",
      facts: { changed: ["autoPause", "cap"] },
    });
  });

  it("records nothing when nothing changes", async () => {
    requireRole.mockResolvedValue(ADMIN);
    const saved = await set({ data: { unusualFactor: 20, budget: { on: false, amount: 50 } } });
    expect(saved).toEqual(DEFAULT_SPEND_DEFAULTS);
    expect(await listActivity(db())).toEqual([]);
  });

  it("refuses a dollar cap or a budget on Workers Free, and changes nothing", async () => {
    requireRole.mockResolvedValue(ADMIN);
    await expect(set({ data: { cap: { on: true, amount: 25, period: "week" } } })).rejects.toThrow(
      "Workers Free can't bill you for Workers",
    );
    await expect(set({ data: { budget: { on: true, amount: 40 } } })).rejects.toThrow(
      "no dollar cap or budget",
    );
    expect(await readSpendDefaults(db())).toEqual(DEFAULT_SPEND_DEFAULTS);
    expect(await listActivity(db())).toEqual([]);
    // Turning them off, and everything else, still saves.
    await set({ data: { cap: { on: false, amount: 10, period: "month" }, autoPause: true } });
    expect(await readSpendDefaults(db())).toMatchObject({ autoPause: true, cap: { on: false } });
  });

  it("turns the unusual-usage alert off with 0 and the budget on", async () => {
    requireRole.mockResolvedValue(ADMIN);
    await writeAccountPlan(db(), "paid");
    await set({ data: { unusualFactor: 0 } });
    const saved = await set({ data: { budget: { on: true, amount: 40 } } });
    expect(saved).toMatchObject({ unusualFactor: 0, budget: { on: true, amount: 40 } });
    const entries = await listActivity(db());
    expect(entries.map((e) => (e.kind === "settings_changed" ? e.facts.changed : null))).toEqual([
      ["budget"],
      ["unusualFactor"],
    ]);
  });
});

describe("setSpendDefaultsInput", () => {
  const ok = (value: unknown) => setSpendDefaultsInput.safeParse(value).success;

  it("takes any one part, or several", () => {
    expect(ok({ autoPause: false })).toBe(true);
    expect(ok({ loop: { on: false, level: "strict" } })).toBe(true);
    expect(ok({ cap: { on: true, amount: 0.5, period: "day" }, unusualFactor: 100 })).toBe(true);
    expect(ok({ budget: { on: true, amount: 5.01 } })).toBe(true);
  });

  it("refuses nothing to change, unknown settings and values out of range", () => {
    expect(ok({})).toBe(false);
    expect(ok({ autoPause: "yes" })).toBe(false);
    expect(ok({ paused: true })).toBe(false);
    expect(ok({ loop: { on: true, level: "paranoid" } })).toBe(false);
    expect(ok({ cap: { on: true, amount: 0, period: "day" } })).toBe(false);
    expect(ok({ cap: { on: true, amount: 100_001, period: "day" } })).toBe(false);
    expect(ok({ cap: { on: true, amount: 10, period: "year" } })).toBe(false);
    expect(ok({ cap: { on: true, period: "day" } })).toBe(false);
    // The budget includes the $5 plan, so $5 or less is passed every month.
    expect(ok({ budget: { on: true, amount: 5 } })).toBe(false);
    expect(ok({ budget: { on: true, amount: Number.POSITIVE_INFINITY } })).toBe(false);
    expect(ok({ unusualFactor: 7 })).toBe(false);
  });
});

describe("amounts as typed", () => {
  it("reads dollars with or without a sign, cents and thousands separators", () => {
    expect(parseDollars("10")).toBe(10);
    expect(parseDollars(" $12.50 ")).toBe(12.5);
    expect(parseDollars("1,000")).toBe(1000);
    expect(parseDollars(".5")).toBe(0.5);
    expect(parseDollars("")).toBeNull();
    expect(parseDollars("ten")).toBeNull();
    expect(parseDollars("1.005")).toBeNull();
    expect(parseDollars("-3")).toBeNull();
  });

  it("checks a cap and a budget against their ranges", () => {
    expect(checkCapAmount("25")).toEqual({ amount: 25 });
    expect(checkCapAmount("0")).toHaveProperty("error");
    expect(checkBudgetAmount("50")).toEqual({ amount: 50 });
    expect(checkBudgetAmount("4")).toHaveProperty("error");
    expect(checkBudgetAmount("")).toHaveProperty("error");
  });
});
