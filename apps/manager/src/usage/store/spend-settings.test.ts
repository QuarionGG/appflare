import { describe, expect, it } from "vitest";
import {
  type AppSpendSettings,
  DEFAULT_SPEND_DEFAULTS,
  defaultAppSpendSettings,
  resolveSpendSettings,
  type SpendDefaults,
} from "./spend-settings";

const account: SpendDefaults = {
  ...DEFAULT_SPEND_DEFAULTS,
  autoPause: true,
  loop: { on: true, level: "strict" },
  cap: { on: false, amount: 25, period: "week" },
};

function app(patch: Partial<AppSpendSettings>): AppSpendSettings {
  return { ...defaultAppSpendSettings("a"), ...patch };
}

describe("resolveSpendSettings", () => {
  it("follows the account in everything when the app changed nothing", () => {
    expect(resolveSpendSettings(account, defaultAppSpendSettings("a"))).toEqual({
      installId: "a",
      autoPause: { on: true, followsAccount: true },
      triggers: {
        custom: false,
        loop: { on: true, level: "strict" },
        cap: { on: false, amount: 25, period: "week" },
      },
      unusual: { factor: 20, followsAccount: true },
      budgetExempt: false,
      capSetAsideUntil: null,
    });
  });

  it("takes the app's own auto-pause choice over the account's", () => {
    expect(resolveSpendSettings(account, app({ autoPause: "off" })).autoPause).toEqual({
      on: false,
      followsAccount: false,
    });
    const off = { ...account, autoPause: false };
    expect(resolveSpendSettings(off, app({ autoPause: "on" })).autoPause).toEqual({
      on: true,
      followsAccount: false,
    });
    expect(resolveSpendSettings(off, app({})).autoPause.on).toBe(false);
  });

  it("ignores the app's triggers until it customizes them", () => {
    const own = {
      loopOn: false,
      loopLevel: "relaxed" as const,
      capAmount: 2,
      capPeriod: "month" as const,
    };
    expect(resolveSpendSettings(account, app(own)).triggers.custom).toBe(false);
    expect(resolveSpendSettings(account, app({ ...own, customTriggers: true })).triggers).toEqual({
      custom: true,
      loop: { on: false, level: "relaxed" },
      cap: { on: true, amount: 2, period: "month" },
    });
  });

  it("gives customized triggers the account's loop level, and no cap amount, until set", () => {
    expect(resolveSpendSettings(account, app({ customTriggers: true })).triggers).toEqual({
      custom: true,
      loop: { on: true, level: "strict" },
      cap: { on: true, amount: null, period: "day" },
    });
  });

  it("resolves the unusual-usage factor: account default, the app's own, or off", () => {
    expect(resolveSpendSettings(account, app({ unusualFactor: 5 })).unusual).toEqual({
      factor: 5,
      followsAccount: false,
    });
    expect(resolveSpendSettings(account, app({ unusualFactor: 0 })).unusual).toEqual({
      factor: null,
      followsAccount: false,
    });
    expect(resolveSpendSettings({ ...account, unusualFactor: 0 }, app({})).unusual).toEqual({
      factor: null,
      followsAccount: true,
    });
  });

  it("does not share the account's trigger objects with the result", () => {
    const resolved = resolveSpendSettings(account, app({}));
    resolved.triggers.cap.amount = 1;
    expect(account.cap.amount).toBe(25);
  });
});
