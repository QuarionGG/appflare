import { describe, expect, it } from "vitest";
import { DAY_MS, daysIn, HOUR_MS, hourStart, hoursLeft, periodEnd, periodStart } from "./periods";

const at = (iso: string) => Date.parse(iso);

describe("periodStart and periodEnd", () => {
  it("bounds a day at UTC midnight", () => {
    const now = at("2026-10-14T13:20:00Z");
    expect(periodStart("day", now)).toBe(at("2026-10-14T00:00:00Z"));
    expect(periodEnd("day", now)).toBe(at("2026-10-15T00:00:00Z"));
  });

  it("starts a week on Monday 00:00 UTC", () => {
    // Wednesday 2026-10-14.
    expect(periodStart("week", at("2026-10-14T13:20:00Z"))).toBe(at("2026-10-12T00:00:00Z"));
    // Monday itself, the first instant.
    expect(periodStart("week", at("2026-10-12T00:00:00Z"))).toBe(at("2026-10-12T00:00:00Z"));
    // Sunday belongs to the week that began the Monday before.
    expect(periodStart("week", at("2026-10-18T23:59:59Z"))).toBe(at("2026-10-12T00:00:00Z"));
    expect(periodEnd("week", at("2026-10-18T23:59:59Z"))).toBe(at("2026-10-19T00:00:00Z"));
  });

  it("keeps a week that crosses a month or a year together", () => {
    // Thursday 2026-01-01; that ISO week began Monday 2025-12-29.
    expect(periodStart("week", at("2026-01-01T08:00:00Z"))).toBe(at("2025-12-29T00:00:00Z"));
    expect(periodEnd("week", at("2026-01-01T08:00:00Z"))).toBe(at("2026-01-05T00:00:00Z"));
  });

  it("bounds a calendar month, including February and December", () => {
    expect(periodStart("month", at("2026-10-31T23:59:59Z"))).toBe(at("2026-10-01T00:00:00Z"));
    expect(periodEnd("month", at("2026-10-31T23:59:59Z"))).toBe(at("2026-11-01T00:00:00Z"));
    expect(periodEnd("month", at("2028-02-10T00:00:00Z"))).toBe(at("2028-03-01T00:00:00Z"));
    expect(periodEnd("month", at("2026-12-15T00:00:00Z"))).toBe(at("2027-01-01T00:00:00Z"));
  });

  it("does not shift around European or American daylight saving changes", () => {
    // Clocks change in Europe on 2026-10-25 and in the US on 2026-11-01.
    const now = at("2026-10-25T01:30:00Z");
    expect(periodEnd("day", now) - periodStart("day", now)).toBe(DAY_MS);
    expect(daysIn("month", now)).toBe(31);
    expect(hoursLeft("day", at("2026-11-01T06:00:00Z"))).toBe(18);
  });
});

describe("hoursLeft and daysIn", () => {
  it("counts fractional hours to the end of the period", () => {
    expect(hoursLeft("day", at("2026-10-14T22:30:00Z"))).toBe(1.5);
    expect(hoursLeft("week", at("2026-10-18T23:00:00Z"))).toBe(1);
    expect(hoursLeft("month", at("2026-10-31T00:00:00Z"))).toBe(24);
  });

  it("knows how many days each period has", () => {
    expect(daysIn("day", at("2026-10-14T10:00:00Z"))).toBe(1);
    expect(daysIn("week", at("2026-10-14T10:00:00Z"))).toBe(7);
    expect(daysIn("month", at("2026-02-14T10:00:00Z"))).toBe(28);
    expect(daysIn("month", at("2028-02-14T10:00:00Z"))).toBe(29);
  });
});

describe("hourStart", () => {
  it("floors to the hour", () => {
    expect(hourStart(at("2026-10-14T13:59:59Z"))).toBe(at("2026-10-14T13:00:00Z"));
    expect(hourStart(at("2026-10-14T13:00:00Z")) % HOUR_MS).toBe(0);
  });
});
