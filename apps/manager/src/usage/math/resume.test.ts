import { describe, expect, it } from "vitest";
import { HOUR_MS, hourStart } from "./periods";
import {
  lastHourRate,
  MIN_RESUME_WINDOW_MS,
  resumeBase,
  resumeMatters,
  usageSinceResume,
} from "./resume";
import { heavyNewUse, loopCheck, unusualUsage } from "./rules";
import type { Usage } from "./series";
import { hourly, NOW } from "./test-series";

const MONTH = 30 * 24;
const at = (iso: string) => Date.parse(iso);
/** NOW is 12:30; the hour it is in began at 12:00. */
const HOUR = hourStart(NOW);

/**
 * A status page whose alarm looped at 10M rows written an hour ($10 an hour)
 * from 11:00 until it was paused at 12:10, then resumed at 12:20. Before,
 * 2,880 rows an hour for a month.
 */
function looped(afterResume: number): Usage {
  const rows = hourly(MONTH, (ago) => (ago === 1 ? 10e6 : 2_880)).map((p) =>
    p.hour === HOUR ? { hour: HOUR, value: 10e6 / 6 + afterResume } : p,
  );
  return { do_rows_written: rows };
}
const RESUME = at("2026-10-14T12:20:00Z");
/** The resume hour as the first check after the resume saw it: the loop's ten minutes. */
const BASE = { do_rows_written: 10e6 / 6 };

describe("usage since a resume", () => {
  it("leaves out the hours before the resume hour, and what that hour held at the resume", () => {
    const since = usageSinceResume(looped(500_000), { at: RESUME, base: BASE });
    expect(since.do_rows_written).toHaveLength(1);
    expect(since.do_rows_written?.[0]?.hour).toBe(RESUME);
    expect(since.do_rows_written?.[0]?.value).toBeCloseTo(500_000);
  });

  it("keeps nothing of the resume hour while it gained nothing since", () => {
    expect(usageSinceResume(looped(0), { at: RESUME, base: BASE }).do_rows_written).toEqual([]);
  });

  it("takes the resume hour's base from the usage, for the count products", () => {
    expect(resumeBase(looped(0), RESUME)).toEqual(BASE);
  });

  it("matters until the hour after the resume hour has left the last hour's window", () => {
    expect(resumeMatters(RESUME, NOW)).toBe(true);
    expect(resumeMatters(RESUME, HOUR + 2 * HOUR_MS - 1)).toBe(true);
    expect(resumeMatters(RESUME, HOUR + 2 * HOUR_MS)).toBe(false);
    expect(resumeMatters(NOW + 1, NOW)).toBe(false);
  });

  it("reads a short window after a resume as a rate an hour, stretched to 5 minutes", () => {
    const series = [{ hour: RESUME, value: 1_000 }];
    // 10 minutes since the resume: 1,000 in 10 minutes is 6,000 an hour.
    expect(lastHourRate(series, NOW, RESUME)).toBeCloseTo(6_000);
    // Two minutes since: read as five.
    const soon = RESUME + 2 * 60_000;
    expect(lastHourRate(series, soon, RESUME)).toBeCloseTo(
      (1_000 * HOUR_MS) / MIN_RESUME_WINDOW_MS,
    );
    // Without a resume: what the last 60 minutes used.
    expect(lastHourRate(series, NOW, undefined)).toBeCloseTo(1_000);
  });
});

describe("the loop check after a resume", () => {
  it("does not pause again for the loop it was paused for while it stays quiet", () => {
    const usage = looped(0);
    // Without the resume, the last hour still holds the loop: it trips.
    expect(loopCheck({ plan: "paid", level: "strict", usage, now: NOW }).trips).toBe(true);
    const check = loopCheck({
      plan: "paid",
      level: "strict",
      usage,
      now: NOW,
      resume: { at: RESUME, base: BASE },
    });
    expect(check.burn).toBe(0);
    expect(check.trips).toBe(false);
    // Its normal still comes from its whole history.
    expect(check.normal).not.toBeNull();
  });

  it("trips again when it loops again after the resume", () => {
    // 10 minutes of the loop again since the resume: 1.67M rows.
    const check = loopCheck({
      plan: "paid",
      level: "standard",
      usage: looped(10e6 / 6),
      now: NOW,
      resume: { at: RESUME, base: BASE },
    });
    // 1.67M rows in the 10 minutes since the resume: about $10 an hour.
    expect(check.burn).toBeCloseTo(10, 1);
    expect(check.trips).toBe(true);
  });

  it("counts the alarm counts again once the resume is an hour old", () => {
    const hourLater = RESUME + HOUR_MS;
    const check = loopCheck({
      plan: "paid",
      level: "strict",
      usage: looped(0),
      now: hourLater,
      objectAlarms: [{ object: "o", alarms: 50_000 }],
      resume: { at: RESUME, base: BASE },
    });
    expect(check.alarmLoop).toEqual({ object: "o", alarms: 50_000 });
  });

  it("trips within two checks for a loop just over the Standard level's bar after a resume", () => {
    // A new app (no normal) resumed at 12:20, then $1.05 an hour of rows written.
    const base = { do_rows_written: 400_000 };
    const usageAt = (t: number): Usage => ({
      do_rows_written: [
        { hour: HOUR - HOUR_MS, value: 2e6 },
        { hour: HOUR, value: 400_000 + (1.05e6 * (t - RESUME)) / HOUR_MS },
      ],
    });
    for (const minutes of [5, 10]) {
      const t = RESUME + minutes * 60_000;
      const check = loopCheck({
        plan: "paid",
        level: "standard",
        usage: usageAt(t),
        now: t,
        resume: { at: RESUME, base },
      });
      expect(check.burn, `${minutes} minutes`).toBeCloseTo(1.05, 2);
      expect(check.trips, `${minutes} minutes`).toBe(true);
    }
  });

  it("leaves out the alarm counts, which cover the hour before the resume too", () => {
    const check = loopCheck({
      plan: "paid",
      level: "strict",
      usage: looped(0),
      now: NOW,
      objectAlarms: [{ object: "o", alarms: 50_000 }],
      resume: { at: RESUME, base: BASE },
    });
    expect(check.alarmLoop).toBeNull();
    expect(check.trips).toBe(false);
  });

  it("measures a Free app's pace from the resume on", () => {
    // 3,000 requests an hour until the pause; nothing since the resume.
    const requests = hourly(MONTH, (ago) => (ago <= 2 ? 3_000 : 50));
    const base = { workers_requests: requests.at(-1)?.value ?? 0 };
    const check = loopCheck({
      plan: "free",
      level: "standard",
      usage: { workers_requests: requests },
      now: NOW,
      resume: { at: RESUME, base },
    });
    expect(check.money).toBe(false);
    expect(check.trips).toBe(false);
  });
});

describe("unusual usage after a resume", () => {
  it("is not unusual for what it used before the resume", () => {
    const usage = looped(0);
    expect(unusualUsage({ plan: "paid", setting: 20, usage, now: NOW })).not.toBeNull();
    expect(
      unusualUsage({
        plan: "paid",
        setting: 20,
        usage,
        now: NOW,
        resume: { at: RESUME, base: BASE },
      }),
    ).toBeNull();
  });
});

describe("a new app using a lot", () => {
  /** Installed at 11:40, looping since: 2M rows an hour, about $2 an hour. */
  const fresh: Usage = {
    do_rows_written: [
      { hour: at("2026-10-14T11:00:00Z"), value: 2e6 / 3 },
      { hour: HOUR, value: 1e6 },
    ],
  };

  it("counts on Paid when the last hour passes the Standard level's $1", () => {
    const heavy = heavyNewUse({ plan: "paid", usage: fresh, now: NOW });
    expect(heavy?.product).toBe("do_rows_written");
    expect(heavy?.burn).toBeGreaterThan(1);
    expect(heavy?.freeShare).toBeNull();
  });

  it("stays quiet under the bar, and once the app has a normal", () => {
    const small: Usage = { do_rows_written: [{ hour: HOUR, value: 100_000 }] };
    expect(heavyNewUse({ plan: "paid", usage: small, now: NOW })).toBeNull();
    // A month of history: it has a normal, so unusual usage judges it instead.
    expect(heavyNewUse({ plan: "paid", usage: looped(0), now: NOW })).toBeNull();
  });

  it("keeps an open episode open down to half the bar", () => {
    const half: Usage = { do_rows_written: [{ hour: at("2026-10-14T11:30:00Z"), value: 700_000 }] };
    expect(heavyNewUse({ plan: "paid", usage: half, now: NOW })).toBeNull();
    expect(heavyNewUse({ plan: "paid", usage: half, now: NOW }, 0.5)).not.toBeNull();
  });

  it("counts on Free when it is on pace to use 25% of a free daily limit today", () => {
    // 3,000 requests an hour since 10:00: on pace for over 25% of the 100,000 a day.
    const usage: Usage = {
      workers_requests: [
        { hour: at("2026-10-14T10:00:00Z"), value: 3_000 },
        { hour: at("2026-10-14T11:00:00Z"), value: 3_000 },
        { hour: HOUR, value: 1_500 },
      ],
    };
    const heavy = heavyNewUse({ plan: "free", usage, now: NOW, since: at("2026-10-14T10:00:00Z") });
    expect(heavy?.product).toBe("workers_requests");
    expect(heavy?.freeShare).toBeGreaterThanOrEqual(0.25);
  });
});
