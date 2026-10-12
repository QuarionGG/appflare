import { reset } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { and, gte, inArray, lt } from "drizzle-orm";
import { beforeEach, describe, expect, it } from "vitest";
import { createDb } from "../../db/client";
import { createMigrator } from "../../db/migrate";
import { migrations } from "../../db/migrations/index";
import { usage_daily, usage_hourly } from "../../db/schema";
import { DAY_SECONDS, HOUR_SECONDS } from "./limits";
import {
  type HourlyUsage,
  pruneUsage,
  readSeries,
  readUsage,
  recordHourlyUsage,
  rollUpDays,
  rollUpStatements,
  UsageStoreError,
} from "./series.server";

// 2026-10-12 00:00:00 UTC
const DAY = 1_791_763_200;
const NOW = new Date((DAY + 20 * HOUR_SECONDS) * 1000);
const db = () => createDb(env.DB);

beforeEach(async () => {
  await reset();
  await createMigrator(migrations).ensure(env.DB);
});

function hours(installId: string, product: string, day: number, values: number[]): HourlyUsage[] {
  return values.map((value, i) => ({ installId, product, hour: day + i * HOUR_SECONDS, value }));
}

async function daily() {
  const { results } = await env.DB.prepare(
    "SELECT install_id, product, day, value FROM usage_daily ORDER BY install_id, product, day",
  ).all();
  return results;
}

describe("recordHourlyUsage", () => {
  it("stores hours, replaces an hour written again, and rolls the day up", async () => {
    await recordHourlyUsage(db(), hours("a", "requests", DAY, [10, 20, 30]), { now: NOW });
    await recordHourlyUsage(db(), [{ installId: "a", product: "requests", hour: DAY, value: 15 }], {
      now: NOW,
    });

    expect(
      await readSeries(db(), {
        installId: "a",
        product: "requests",
        from: DAY,
        to: DAY + DAY_SECONDS,
        grain: "hour",
      }),
    ).toEqual([
      { t: DAY, value: 15 },
      { t: DAY + HOUR_SECONDS, value: 20 },
      { t: DAY + 2 * HOUR_SECONDS, value: 30 },
    ]);
    expect(await daily()).toEqual([{ install_id: "a", product: "requests", day: DAY, value: 65 }]);
  });

  it("keeps a level product's last hour as its day, and sums the rest", async () => {
    const result = await recordHourlyUsage(
      db(),
      [
        ...hours("a", "r2_storage", DAY, [6.1, 6.4, 6.2]),
        ...hours("a", "requests", DAY, [1, 2, 3]),
        ...hours("a", "requests", DAY - DAY_SECONDS, [4, 4]),
      ],
      { levels: ["r2_storage"], now: NOW },
    );
    expect(result).toEqual({ written: 8, days: [DAY - DAY_SECONDS, DAY] });
    expect(await daily()).toEqual([
      { install_id: "a", product: "r2_storage", day: DAY, value: 6.2 },
      { install_id: "a", product: "requests", day: DAY - DAY_SECONDS, value: 8 },
      { install_id: "a", product: "requests", day: DAY, value: 6 },
    ]);
  });

  it("writes hundreds of rows within D1's parameter and batch limits", async () => {
    const rows: HourlyUsage[] = [];
    for (let app = 0; app < 120; app++) {
      for (const product of ["requests", "r2_storage"]) {
        rows.push(
          ...hours(
            `app-${app}`,
            product,
            DAY,
            Array.from({ length: 10 }, () => 1),
          ),
        );
      }
    }
    expect(rows.length).toBe(2_400);
    // 120 installs: the rollup cuts its install ids into more than one statement.
    const result = await recordHourlyUsage(db(), rows, { levels: ["r2_storage"], now: NOW });
    expect(result.written).toBe(2_400);
    const counts = await env.DB.prepare(
      "SELECT (SELECT COUNT(*) FROM usage_hourly) AS hourly, (SELECT COUNT(*) FROM usage_daily) AS days, (SELECT MIN(value) FROM usage_daily) AS low, (SELECT MAX(value) FROM usage_daily) AS high",
    ).first();
    expect(counts).toEqual({ hourly: 2_400, days: 240, low: 1, high: 10 });
  });

  it("rolls up only the installs it wrote, leaving others' days alone", async () => {
    await recordHourlyUsage(db(), hours("a", "requests", DAY, [1, 1]), { now: NOW });
    await env.DB.prepare("UPDATE usage_daily SET value = 99 WHERE install_id = 'a'").run();
    await recordHourlyUsage(db(), hours("b", "requests", DAY, [5]), { now: NOW });
    expect(await daily()).toEqual([
      { install_id: "a", product: "requests", day: DAY, value: 99 },
      { install_id: "b", product: "requests", day: DAY, value: 5 },
    ]);
    await rollUpDays(db(), [DAY]);
    expect((await daily())[0]).toEqual({
      install_id: "a",
      product: "requests",
      day: DAY,
      value: 2,
    });
  });

  it("skips hours of days the hourly retention has reached", async () => {
    const old = DAY - 50 * DAY_SECONDS;
    const result = await recordHourlyUsage(db(), hours("a", "requests", old, [1]), { now: NOW });
    expect(result).toEqual({ written: 0, days: [] });
    // 45 days back, 21:00: inside the retention, but its day's first hours are pruned.
    const edge = DAY - 45 * DAY_SECONDS + 21 * HOUR_SECONDS;
    const atEdge = await recordHourlyUsage(
      db(),
      [{ installId: "a", product: "requests", hour: edge, value: 1 }],
      { now: NOW },
    );
    expect(atEdge).toEqual({ written: 0, days: [] });
    expect(await daily()).toEqual([]);
  });

  it("refuses an hour that is not the start of a UTC hour, and a bad value", async () => {
    await expect(
      recordHourlyUsage(db(), [{ installId: "a", product: "requests", hour: DAY + 60, value: 1 }]),
    ).rejects.toThrow(UsageStoreError);
    await expect(
      recordHourlyUsage(db(), [
        { installId: "a", product: "requests", hour: DAY, value: Number.NaN },
      ]),
    ).rejects.toThrow(UsageStoreError);
    await expect(rollUpDays(db(), [DAY + 1])).rejects.toThrow(UsageStoreError);
  });
});

describe("reading usage", () => {
  beforeEach(async () => {
    await recordHourlyUsage(
      db(),
      [
        ...hours("a", "requests", DAY, [1, 2]),
        ...hours("a", "do", DAY, [7]),
        ...hours("b", "requests", DAY, [3]),
        ...hours("a", "requests", DAY - DAY_SECONDS, [9]),
      ],
      { now: NOW },
    );
  });

  it("reads one product's days in a range, from inclusive to exclusive", async () => {
    const series = (from: number, to: number) =>
      readSeries(db(), { installId: "a", product: "requests", from, to, grain: "day" });
    expect(await series(DAY - DAY_SECONDS, DAY + DAY_SECONDS)).toEqual([
      { t: DAY - DAY_SECONDS, value: 9 },
      { t: DAY, value: 3 },
    ]);
    expect(await series(DAY - DAY_SECONDS, DAY)).toEqual([{ t: DAY - DAY_SECONDS, value: 9 }]);
  });

  it("reads every product of the named installs, or of all", async () => {
    const range = { from: DAY, to: DAY + DAY_SECONDS, grain: "hour" as const };
    expect(await readUsage(db(), { ...range, installIds: ["b"] })).toEqual([
      { installId: "b", product: "requests", t: DAY, value: 3 },
    ]);
    expect(await readUsage(db(), range)).toEqual([
      { installId: "a", product: "do", t: DAY, value: 7 },
      { installId: "a", product: "requests", t: DAY, value: 1 },
      { installId: "b", product: "requests", t: DAY, value: 3 },
      { installId: "a", product: "requests", t: DAY + HOUR_SECONDS, value: 2 },
    ]);
    expect(await readUsage(db(), { ...range, installIds: [] })).toEqual([]);
  });
});

describe("pruneUsage", () => {
  it("deletes hours past 45 days and days past 400", async () => {
    const insert = (table: string, t: number) =>
      env.DB.prepare(`INSERT INTO ${table} VALUES ('a', 'requests', ?1, 1)`).bind(t).run();
    const today = DAY;
    await insert("usage_hourly", today - 44 * DAY_SECONDS);
    await insert("usage_hourly", today - 46 * DAY_SECONDS);
    await insert("usage_daily", today - 399 * DAY_SECONDS);
    await insert("usage_daily", today - 401 * DAY_SECONDS);

    expect(await pruneUsage(db(), NOW)).toEqual({ hourly: 1, daily: 1 });
    expect(await pruneUsage(db(), NOW)).toEqual({ hourly: 0, daily: 0 });
    const left = await env.DB.prepare(
      "SELECT (SELECT hour FROM usage_hourly) AS hour, (SELECT day FROM usage_daily) AS day",
    ).first();
    expect(left).toEqual({ hour: today - 44 * DAY_SECONDS, day: today - 399 * DAY_SECONDS });
  });
});

describe("query plans", () => {
  /** The plan's detail lines for a Drizzle query, as D1 runs it. */
  async function plan(query: unknown): Promise<string> {
    const { sql, params } = (query as { toSQL(): { sql: string; params: unknown[] } }).toSQL();
    const { results } = await env.DB.prepare(`EXPLAIN QUERY PLAN ${sql}`)
      .bind(...params)
      .all<{ detail: string }>();
    return results.map((r) => r.detail).join("\n");
  }

  it("rolls a day up from the installs' hours of that day, not all their hours", async () => {
    const [sums, levels] = rollUpStatements(db(), DAY, ["a", "b"], ["r2_storage"]);
    expect(await plan(sums)).toMatch(
      /SEARCH usage_hourly USING INDEX usage_hourly_install_hour_idx \(install_id=\? AND hour>\? AND hour<\?\)/,
    );
    // Levels name their products, so the primary key bounds all three.
    const levelPlan = await plan(levels);
    expect(levelPlan).toMatch(
      /SEARCH usage_hourly USING INDEX \S+ \(install_id=\? AND product=\? AND hour>\? AND hour<\?\)/,
    );
    expect(levelPlan).not.toMatch(/SCAN usage_hourly/);
  });

  it("reads installs' hours and days in a range through the install-and-time indexes", async () => {
    const h = usage_hourly;
    const d = usage_daily;
    const hoursOf = db()
      .select()
      .from(h)
      .where(
        and(gte(h.hour, DAY), lt(h.hour, DAY + DAY_SECONDS), inArray(h.install_id, ["a", "b"])),
      );
    expect(await plan(hoursOf)).toMatch(
      /USING INDEX usage_hourly_install_hour_idx \(install_id=\? AND hour>\? AND hour<\?\)/,
    );
    const daysOf = db()
      .select()
      .from(d)
      .where(and(gte(d.day, DAY), lt(d.day, DAY + DAY_SECONDS), inArray(d.install_id, ["a"])));
    expect(await plan(daysOf)).toMatch(
      /USING INDEX usage_daily_install_day_idx \(install_id=\? AND day>\? AND day<\?\)/,
    );
  });
});
