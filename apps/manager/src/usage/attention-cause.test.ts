import { describe, expect, it } from "vitest";
import { loopRuleWords, parsePauseCause, pauseCauseSentence } from "./attention-cause";

describe("parsePauseCause", () => {
  it("reads a pause's detail with the reason its row records", () => {
    expect(parsePauseCause("cap", JSON.stringify({ amount: 2, period: "week" }))).toEqual({
      reason: "cap",
      amount: 2,
      period: "week",
    });
    // The row's reason wins over one the detail repeats.
    expect(parsePauseCause("manual", JSON.stringify({ reason: "cap", amount: 2 }))).toEqual({
      reason: "manual",
    });
    expect(parsePauseCause("manual", null)).toEqual({ reason: "manual" });
  });

  it("is null for a detail that does not read as its reason", () => {
    expect(parsePauseCause("cap", null)).toBeNull();
    expect(parsePauseCause("loop", JSON.stringify({ level: "frantic", plan: "paid" }))).toBeNull();
    expect(parsePauseCause("budget", "{oops")).toBeNull();
  });
});

describe("pauseCauseSentence", () => {
  it("says nothing for a manual pause", () => {
    expect(pauseCauseSentence({ reason: "manual" })).toBeNull();
  });

  it("names the cap's period", () => {
    expect(pauseCauseSentence({ reason: "cap", amount: 25, period: "month" })).toBe(
      "It passed its $25.00 monthly cap.",
    );
  });

  it("states each loop level's rule, on each plan", () => {
    expect(loopRuleWords("relaxed", "paid")).toBe("over $5.00 an hour and 100× its normal");
    expect(loopRuleWords("standard", "free")).toBe(
      "50× its normal and on pace to use 25% of a free daily limit within the day",
    );
  });
});
