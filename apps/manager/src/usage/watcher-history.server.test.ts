import { reset } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { beforeEach, describe, expect, it } from "vitest";
import { createDb } from "../db/client";
import { createMigrator } from "../db/migrate";
import { migrations } from "../db/migrations/index";
import {
  accountOverage,
  HOUR_MS,
  loopCheck,
  productMonth,
  spendInPeriod,
  type Usage,
  unusualUsage,
} from "./math";
import { recordHourlyUsage, type UsageRow } from "./store/series.server";
import {
  buildHistorySeries,
  compactSeries,
  HOURLY_DAYS,
  historyBounds,
  historyText,
  LEVEL_HOURLY_HOURS,
  loadHistory,
  partHistory,
  readHistoryText,
  SUMS_HISTORY,
  updateHistorySeries,
  usageByInstall,
} from "./watcher-history.server";

const NOW = Date.parse("2026-10-29T16:50:00Z");
const s = (iso: string) => Date.parse(iso) / 1000;
const HOUR = 3600;

describe("historyBounds", () => {
  it("splits at three hours back, with hourly rows for eight days and days before", () => {
    expect(historyBounds(Date.parse("2026-10-12T16:50:00Z"))).toEqual({
      cutoff: s("2026-10-12T13:00:00Z"),
      hourlyFrom: s("2026-10-04T00:00:00Z"),
      monthFrom: s("2026-10-01T00:00:00Z"),
    });
  });
});

describe("compactSeries", () => {
  const bounds = { countFrom: s("2026-10-03T05:00:00Z"), levelFrom: s("2026-10-04T00:00:00Z") };

  it("adds a count's hours before the hourly part into one point per day", () => {
    const points = [
      s("2026-10-02T00:00:00Z"),
      100, // a day total
      s("2026-10-03T01:00:00Z"),
      1,
      s("2026-10-03T04:00:00Z"),
      2,
      s("2026-10-03T05:00:00Z"),
      3,
      s("2026-10-03T06:00:00Z"),
      4,
    ];
    expect(compactSeries(points, "count", bounds)).toEqual([
      s("2026-10-02T00:00:00Z"),
      100,
      s("2026-10-03T00:00:00Z"),
      3,
      s("2026-10-03T05:00:00Z"),
      3,
      s("2026-10-03T06:00:00Z"),
      4,
    ]);
  });

  it("keeps a level's unit-hours per day, and its latest level as it is", () => {
    const points = [
      s("2026-10-02T00:00:00Z"),
      48, // a day's level of 2, held 24 hours
      s("2026-10-03T22:00:00Z"),
      2,
      s("2026-10-03T23:00:00Z"),
      3,
    ];
    expect(compactSeries(points, "level", bounds)).toEqual([
      s("2026-10-02T00:00:00Z"),
      48,
      s("2026-10-03T00:00:00Z"),
      2,
      s("2026-10-03T23:00:00Z"),
      3,
    ]);
  });
});

/** Every number the watcher and the pages take from a usage: the same compacted or not. */
describe("compacted usage", () => {
  const hours = 29 * 24 + 17;
  const start = Math.floor(NOW / HOUR_MS) * HOUR_MS - (hours - 1) * HOUR_MS;
  function full(): Usage {
    const count = (base: number) =>
      Array.from({ length: hours }, (_, i) => ({
        hour: start + i * HOUR_MS,
        value: i % 7 === 0 ? 0 : base * (1 + ((i * 37) % 11) / 10) * (i > hours - 3 ? 40 : 1),
      })).filter((p) => p.value > 0);
    const level = (gb: number) =>
      Array.from({ length: hours }, (_, i) => ({
        hour: start + i * HOUR_MS,
        value: gb + i / 1000,
      }));
    return {
      workers_requests: count(3e5),
      d1_rows_written: count(2e5),
      do_rows_written: count(1e6),
      d1_storage: level(7),
      r2_storage: level(30),
    };
  }

  function compacted(usage: Usage): Usage {
    const hourNow = (Math.floor(NOW / HOUR_MS) * HOUR_MS) / 1000;
    const bounds = {
      countFrom: hourNow - HOURLY_DAYS * 86_400,
      levelFrom: hourNow - LEVEL_HOURLY_HOURS * HOUR,
    };
    const series = Object.entries(usage).map(([product, points]) => {
      const flat = (points ?? []).flatMap((p) => [p.hour / 1000, p.value]);
      const measure = product.endsWith("_storage") ? "level" : "count";
      return ["a", product, compactSeries(flat, measure, bounds)] as [string, never, number[]];
    });
    return usageByInstall(series, []).get("a") ?? {};
  }

  it("gives the loop check, unusual usage, spend, the month and the overage unchanged", () => {
    const a = full();
    const b = compacted(a);
    expect(b.workers_requests?.length).toBeLessThan((a.workers_requests?.length ?? 0) * 0.4);
    expect(b.d1_storage?.length).toBeLessThan(60);
    const since = NOW - 60 * 86_400_000;
    for (const plan of ["paid", "free"] as const) {
      expect(loopCheck({ plan, level: "standard", usage: b, now: NOW, since })).toEqual(
        loopCheck({ plan, level: "standard", usage: a, now: NOW, since }),
      );
      expect(unusualUsage({ plan, setting: 20, usage: b, now: NOW })).toEqual(
        unusualUsage({ plan, setting: 20, usage: a, now: NOW }),
      );
    }
    for (const period of ["day", "week", "month"] as const) {
      const x = spendInPeriod(a, period, NOW, { since });
      const y = spendInPeriod(b, period, NOW, { since });
      expect(y.spent).toBeCloseTo(x.spent, 6);
      expect(y.projected).toBeCloseTo(x.projected, 6);
    }
    for (const key of ["d1_storage", "r2_storage", "workers_requests"] as const) {
      const x = productMonth(key, a[key] ?? [], "paid", NOW, { projected: true });
      const y = productMonth(key, b[key] ?? [], "paid", NOW, { projected: true });
      expect(y.amount).toBeCloseTo(x.amount, 6);
      expect(y.usd).toBeCloseTo(x.usd, 6);
    }
    const x = accountOverage({ a, other: a }, "paid", NOW, { projected: true });
    const y = accountOverage({ a: b, other: b }, "paid", NOW, { projected: true });
    expect(y.usd).toBeCloseTo(x.usd, 6);
  });
});

describe("usageByInstall", () => {
  it("lays the recent hours after the history, the recent value winning an hour both hold", () => {
    const hour = s("2026-10-12T12:00:00Z");
    const usage = usageByInstall(
      [
        ["a", "workers_requests", [hour - 86_400, 2400, hour, 10]],
        ["a", "not_a_product" as never, [hour, 1]],
      ],
      [
        { installId: "a", product: "workers_requests", t: hour, value: 12 },
        { installId: "a", product: "workers_requests", t: hour + 3600, value: 5 },
        { installId: "b", product: "kv_reads", t: hour + 3600, value: 3 },
      ],
    );
    expect(usage.get("a")?.workers_requests).toEqual([
      { hour: (hour - 86_400) * 1000, value: 2400 },
      { hour: hour * 1000, value: 12 },
      { hour: (hour + 3600) * 1000, value: 5 },
    ]);
    expect(usage.get("a")).not.toHaveProperty("not_a_product");
    expect(usage.get("b")?.kv_reads).toEqual([{ hour: (hour + 3600) * 1000, value: 3 }]);
  });
});

describe("historyText", () => {
  it("reads a history back", () => {
    const bounds = historyBounds(NOW);
    const series: Array<[string, never, number[]]> = [["a", "workers_requests" as never, [1, 6]]];
    const read = readHistoryText(historyText({ bounds, mode: "full", installIds: ["a"] }, series));
    expect(read?.header).toMatchObject({ bounds, mode: "full", installIds: ["a"] });
    expect(read?.series()).toEqual(series);
    expect(readHistoryText('{"v":1}\n[]')).toBeNull();
  });
});

/** Raw rows of two installs: this month's days, then eight days of hours, then two more hours. */
function rawRows() {
  const bounds = historyBounds(NOW);
  const daily: UsageRow[] = [];
  const hourly: UsageRow[] = [];
  for (const installId of ["a", "b"]) {
    for (let d = bounds.monthFrom; d < bounds.hourlyFrom; d += 86_400) {
      daily.push({ installId, product: "workers_requests", t: d, value: 2_400 });
      daily.push({ installId, product: "r2_storage", t: d, value: 3 });
    }
  }
  for (let t = bounds.hourlyFrom; t < bounds.cutoff + 2 * HOUR; t += HOUR) {
    for (const installId of ["a", "b"]) {
      hourly.push({ installId, product: "workers_requests", t, value: 100 + (t % 7) });
      hourly.push({ installId, product: "r2_storage", t, value: 3 + (t % 5) / 10 });
    }
  }
  return { daily, hourly };
}

describe("updateHistorySeries", () => {
  for (const mode of ["full", "sums"] as const) {
    it(`brings a ${mode} history up to date as reading it afresh would`, () => {
      const { daily, hourly } = rawRows();
      const then = historyBounds(NOW);
      const later = historyBounds(NOW + 2 * HOUR_MS);
      const old = buildHistorySeries(
        hourly.filter((r) => r.t < then.cutoff),
        daily,
        then,
        mode,
      );
      const updated = updateHistorySeries(
        old,
        hourly.filter((r) => r.t >= then.cutoff && r.t < later.cutoff),
        later,
        mode,
      );
      const afresh = buildHistorySeries(
        hourly.filter((r) => r.t < later.cutoff),
        daily,
        later,
        mode,
      );
      expect(updated).toEqual(afresh);
    });
  }
});

describe("a storage level only in daily rows", () => {
  it("ends on the level it holds (an uninstalled app's R2 bucket this month)", () => {
    const bounds = historyBounds(NOW);
    const daily: UsageRow[] = [];
    const full: Array<{ hour: number; value: number }> = [];
    for (let d = bounds.monthFrom; d < bounds.monthFrom + 10 * 86_400; d += 86_400) {
      daily.push({ installId: "gone", product: "r2_storage", t: d, value: 40 });
      for (let h = 0; h < 24; h++) full.push({ hour: (d + h * HOUR) * 1000, value: 40 });
    }
    for (const mode of ["full", "sums"] as const) {
      const series = buildHistorySeries([], daily, bounds, mode);
      const compact = usageByInstall(series, []).get("gone")?.r2_storage ?? [];
      expect(compact.at(-1)?.value).toBe(40);
      expect(compact.length).toBeLessThan(full.length / 10);
      const x = productMonth("r2_storage", full, "paid", NOW, { projected: true });
      const y = productMonth("r2_storage", compact, "paid", NOW, { projected: true });
      expect(y.amount).toBeCloseTo(x.amount, 9);
      expect(y.usd).toBeCloseTo(x.usd, 9);
    }
  });
});

describe("loadHistory", () => {
  beforeEach(async () => {
    await reset();
    await createMigrator(migrations).ensure(env.DB);
  });

  it("keeps each part's history under its own key, brought up to date by the hour", async () => {
    const db = createDb(env.DB);
    const { hourly } = rawRows();
    await recordHourlyUsage(
      db,
      hourly.map((r) => ({
        installId: r.installId,
        product: r.product,
        hour: r.t,
        value: r.value,
      })),
      { levels: ["r2_storage"], now: new Date(NOW) },
    );
    const part = partHistory(0, ["a"]);
    const first = await loadHistory(db, env.KV, NOW, part);
    expect(first.source).toBe("database");
    expect(new Set(first.series.map(([id]) => id))).toEqual(new Set(["a"]));
    expect(await env.KV.get(part.key)).not.toBeNull();
    expect((await loadHistory(db, env.KV, NOW + 60_000, part)).source).toBe("cache");
    // An hour later: only the hour that became final is read.
    const later = await loadHistory(db, env.KV, NOW + HOUR_MS, part);
    expect(later.source).toBe("update");
    expect(later.series).toEqual(
      (await loadHistory(db, env.KV, NOW + HOUR_MS, part, { fresh: true })).series,
    );
    // Another part's apps, or this part with an app more: read afresh.
    expect((await loadHistory(db, env.KV, NOW + HOUR_MS, partHistory(0, ["a", "b"]))).source).toBe(
      "database",
    );
    expect((await loadHistory(db, env.KV, NOW + HOUR_MS, SUMS_HISTORY)).source).toBe("database");
  });

  it("reads afresh only the installs whose kept hours the check rewrote", async () => {
    const db = createDb(env.DB);
    const { hourly } = rawRows();
    const write = (rows: UsageRow[]) =>
      recordHourlyUsage(
        db,
        rows.map((r) => ({
          installId: r.installId,
          product: r.product,
          hour: r.t,
          value: r.value,
        })),
        { levels: ["r2_storage"], now: new Date(NOW) },
      );
    await write(hourly);
    await loadHistory(db, env.KV, NOW, SUMS_HISTORY);
    // Install b's hours of yesterday change (a backfill).
    const yesterday = historyBounds(NOW).cutoff - 20 * HOUR;
    await write(
      hourly
        .filter((r) => r.installId === "b" && r.t === yesterday)
        .map((r) => ({ ...r, value: r.value * 50 })),
    );
    const partly = await loadHistory(db, env.KV, NOW, SUMS_HISTORY, { fresh: new Set(["b"]) });
    expect(partly.source).toBe("update");
    const sorted = (x: typeof partly.series) =>
      [...x].sort((p, q) => `${p[0]}${p[1]}`.localeCompare(`${q[0]}${q[1]}`));
    expect(sorted(partly.series)).toEqual(
      sorted((await loadHistory(db, env.KV, NOW, SUMS_HISTORY, { fresh: true })).series),
    );
  });
});
