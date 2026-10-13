import { describe, expect, it } from "vitest";
import { loopingApp, spendApp } from "../test/spend-fixture";
import { budgetExemptApps, capWatch, followingApps, loopingNow, ownTriggerApps } from "./overview";

/** The selectors pages use to show the effect of a setting while it changes. */

const NOW = Date.UTC(2026, 9, 12, 15, 30);
const looping = loopingApp("loop", "Service status");
const calm = spendApp("calm", "Short links");
const own = spendApp("own", "Journal", { followsAccountTriggers: false, budgetExempt: true });

describe("loopingNow", () => {
  it("names the apps whose check trips at the level, never a paused one", () => {
    expect(loopingNow([looping, calm], "standard")).toEqual([looping]);
    expect(loopingNow([looping, calm], "relaxed")).toEqual([]);
    expect(loopingNow([{ ...looping, paused: true }], "strict")).toEqual([]);
  });
});

describe("capWatch", () => {
  it("lists apps over the cap or getting there, most spent first", () => {
    // Month: the looping app spent $12.40 (on pace for $61.80); the calm one $1.20 ($2.60).
    expect(
      capWatch([calm, looping], 10, "month", NOW).map((r) => [r.app.installId, r.over]),
    ).toEqual([["loop", true]]);
    // Half spent counts as getting there; so does being on pace to pass it.
    expect(capWatch([calm], 2.4, "month", NOW).map((r) => r.app.installId)).toEqual(["calm"]);
    expect(capWatch([calm], 2.5, "month", NOW).map((r) => r.over)).toEqual([false]);
    expect(capWatch([calm], 3, "month", NOW)).toEqual([]);
    expect(capWatch([calm, looping], 0, "day", NOW)).toEqual([]);
  });

  it("says until when an app's cap is set aside, and forgets a set-aside that ended", () => {
    const until = NOW + 3_600_000;
    const [row] = capWatch([{ ...looping, capSetAsideUntil: until }], 10, "month", NOW);
    expect(row).toMatchObject({ over: true, setAsideUntil: until });
    const [ended] = capWatch([{ ...looping, capSetAsideUntil: NOW - 1 }], 10, "month", NOW);
    expect(ended?.setAsideUntil).toBeNull();
  });
});

describe("app groups", () => {
  it("tells apps on the account's triggers from those with their own, and finds the exempt ones", () => {
    expect(followingApps([looping, own]).map((a) => a.installId)).toEqual(["loop"]);
    expect(ownTriggerApps([looping, own]).map((a) => a.installId)).toEqual(["own"]);
    expect(budgetExemptApps([looping, own]).map((a) => a.installId)).toEqual(["own"]);
  });
});
