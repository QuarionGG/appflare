import { describe, expect, it } from "vitest";
import { HOUR_MS } from "./periods";
import { addSeries, heldBetween, latest, sumBetween } from "./series";
import { hourly, NOW, point } from "./test-series";

describe("sumBetween", () => {
  it("adds whole hours and prorates hours cut by the window", () => {
    const series = [point("2026-10-14T09:00:00Z", 100), point("2026-10-14T10:00:00Z", 100)];
    const from = Date.parse("2026-10-14T09:30:00Z");
    expect(sumBetween(series, from, NOW, NOW)).toBe(150);
  });

  it("takes the current hour's value as covering only the time up to now", () => {
    // 12:00–12:30 used 50; a window from 12:15 sees half of it.
    const series = [point("2026-10-14T12:00:00Z", 50)];
    expect(sumBetween(series, Date.parse("2026-10-14T12:15:00Z"), NOW, NOW)).toBe(25);
    expect(sumBetween(series, NOW - HOUR_MS, NOW, NOW)).toBe(50);
  });

  it("gives the steady rate for any 3-hour window of a steady series", () => {
    expect(sumBetween(hourly(48, 100), NOW - 3 * HOUR_MS, NOW, NOW)).toBeCloseTo(300);
  });

  it("ignores hours outside the window and in the future", () => {
    const series = [point("2026-10-13T00:00:00Z", 7), point("2026-10-14T13:00:00Z", 9)];
    expect(sumBetween(series, Date.parse("2026-10-14T00:00:00Z"), NOW, NOW)).toBe(0);
  });
});

describe("levels", () => {
  it("counts unit-hours held, including the part of the current hour", () => {
    const series = [point("2026-10-14T11:00:00Z", 10), point("2026-10-14T12:00:00Z", 10)];
    expect(heldBetween(series, Date.parse("2026-10-14T00:00:00Z"), NOW, NOW)).toBe(15);
  });

  it("reads the latest value at or before now", () => {
    const series = [point("2026-10-14T12:00:00Z", 4), point("2026-10-14T10:00:00Z", 2)];
    expect(latest(series, NOW)).toBe(4);
    expect(latest([], NOW)).toBe(0);
  });
});

describe("addSeries", () => {
  it("adds series hour by hour, oldest first", () => {
    const a = [point("2026-10-14T11:00:00Z", 1), point("2026-10-14T10:00:00Z", 2)];
    const b = [point("2026-10-14T11:00:00Z", 3)];
    expect(addSeries([a, b])).toEqual([
      point("2026-10-14T10:00:00Z", 2),
      point("2026-10-14T11:00:00Z", 4),
    ]);
  });
});
