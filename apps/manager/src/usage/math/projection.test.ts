import { describe, expect, it } from "vitest";
import { normalHour, pace, percentile95, project } from "./projection";
import { hourly, NOW } from "./test-series";

describe("pace", () => {
  it("is the steady rate for a steady app", () => {
    expect(pace(hourly(48, 100), NOW)).toBeCloseTo(100);
  });

  it("follows a sudden jump at once: the faster of the last 3 hours and the day", () => {
    const series = hourly(48, (ago) => (ago <= 3 ? 1_000 : 100));
    expect(pace(series, NOW)).toBeCloseTo(1_000);
  });

  it("keeps the day's average through a quiet stretch", () => {
    const series = hourly(48, (ago) => (ago <= 3 ? 20 : 100));
    // The last 24 hours from 12:30: 3.5 hours at 20 (09:00 onward, the
    // current hour half-way) and 20.5 at 100.
    expect(pace(series, NOW)).toBeCloseTo((3.5 * 20 + 20.5 * 100) / 24);
  });

  it("drops to the last 3 hours once the app stopped (below 10% of the day)", () => {
    const paused = hourly(48, (ago) => (ago <= 3 ? 0 : 5_000_000));
    expect(pace(paused, NOW)).toBe(0);
    const trickle = hourly(48, (ago) => (ago <= 3 ? 50 : 1_000));
    expect(pace(trickle, NOW)).toBeCloseTo(50);
  });

  it("averages only over the hours since the data started when told", () => {
    const fresh = hourly(1, 100);
    // Installed at 12:00: half an hour at 100/h.
    expect(pace(fresh, NOW)).toBeCloseTo(50 / 3);
    expect(pace(fresh, NOW, { since: Date.parse("2026-10-14T12:00:00Z") })).toBeCloseTo(100);
  });

  it("is zero with no data", () => {
    expect(pace([], NOW)).toBe(0);
    expect(pace([], NOW, { since: NOW })).toBe(0);
  });
});

describe("project", () => {
  it("adds the pace for the hours left to what was used", () => {
    const p = project(hourly(48, 100), "day", NOW);
    expect(p.used).toBeCloseTo(1_250);
    expect(p.pace).toBeCloseTo(100);
    expect(p.projected).toBeCloseTo(2_400);
  });

  it("projects a stopped app at what it already used", () => {
    const p = project(
      hourly(48, (ago) => (ago <= 3 ? 0 : 1_000)),
      "day",
      NOW,
    );
    expect(p.projected).toBeCloseTo(p.used);
  });
});

describe("percentile95", () => {
  it("takes the nearest rank", () => {
    const values = Array.from({ length: 100 }, (_, i) => i + 1);
    expect(percentile95(values)).toBe(95);
    expect(percentile95([3, 1, 2])).toBe(3);
    expect(percentile95([])).toBe(0);
  });

  it("ignores the top 5%: 8 busy hours out of 168 do not set the normal", () => {
    const week = [...Array(160).fill(10), ...Array(8).fill(1_000)];
    expect(percentile95(week)).toBe(10);
    expect(percentile95([...week.slice(1), 1_000])).toBe(1_000);
  });
});

describe("normalHour", () => {
  it("is the p95 of the 7 days before the last day", () => {
    const series = hourly(30 * 24, (ago) => (ago % 24 === 0 ? 400 : 100));
    // One busy hour a day: 7 of 168 hours, under the top 5% (8.4 hours).
    expect(normalHour(series, NOW)).toBe(100);
  });

  it("leaves the last day out, so a loop since yesterday stays abnormal", () => {
    const series = hourly(30 * 24, (ago) => (ago <= 20 ? 5_000_000 : 1_440));
    expect(normalHour(series, NOW)).toBe(1_440);
  });

  it("takes only active hours, so a daily batch is measured against its batches", () => {
    // One busy hour a day, idle (missing or zero) the rest.
    const batch = hourly(30 * 24, (ago) => (ago % 24 === 5 ? 1_000_000 : 0));
    expect(normalHour(batch, NOW)).toBe(1_000_000);
    expect(
      normalHour(
        batch.filter((p) => p.value > 0),
        NOW,
      ),
    ).toBe(1_000_000);
  });

  it("has no normal with fewer than 3 active hours in the window", () => {
    expect(normalHour([], NOW)).toBeNull();
    // Installed 5 hours ago: nothing in the 7 days before the last day.
    expect(normalHour(hourly(5, 50), NOW)).toBeNull();
    // Two active hours are not enough; three are.
    const twoDays = hourly(30 * 24, (ago) => (ago === 30 || ago === 54 ? 10 : 0));
    expect(normalHour(twoDays, NOW)).toBeNull();
    const threeDays = hourly(30 * 24, (ago) => (ago === 30 || ago === 54 || ago === 78 ? 10 : 0));
    expect(normalHour(threeDays, NOW)).toBe(10);
  });

  it("never returns 0 or less", () => {
    const quiet = hourly(30 * 24, (ago) => (ago % 3 === 0 ? 0.000001 : 0));
    expect(normalHour(quiet, NOW)).toBeGreaterThan(0);
    expect(normalHour(hourly(30 * 24, 0), NOW)).toBeNull();
  });
});
