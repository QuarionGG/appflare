import { reset } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { beforeEach, describe, expect, it } from "vitest";
import { ZodError } from "zod";
import { createDb } from "../../db/client";
import { createMigrator } from "../../db/migrate";
import { migrations } from "../../db/migrations/index";
import { countActivity, listActivity, pruneActivity, recordActivity } from "./activity.server";

const db = () => createDb(env.DB);
const NOW = new Date("2026-10-12T10:00:00Z");
const at = (minutes: number) => new Date(NOW.getTime() + minutes * 60_000);
// 2026-10-01 00:00 UTC
const OCTOBER = 1_790_812_800;

beforeEach(async () => {
  await reset();
  await createMigrator(migrations).ensure(env.DB);
});

describe("usage activity", () => {
  it("records entries with typed facts and lists them newest first", async () => {
    const paused = await recordActivity(db(), {
      installId: "a",
      kind: "paused",
      facts: { pauseId: "p1", reason: "loop", jobId: "j1" },
      at: at(0),
    });
    expect(paused).toMatchObject({ installId: "a", kind: "paused", by: null, at: at(0).getTime() });
    await recordActivity(db(), {
      installId: "a",
      kind: "resumed",
      facts: { pauseId: "p1" },
      by: "u1",
      at: at(30),
    });
    await recordActivity(db(), {
      installId: "a",
      kind: "alert_sent",
      facts: {
        ruleId: "r1",
        sentence: "When it has spent $6.00 this month",
        periodStart: OCTOBER,
        value: 6.2,
        amount: 6,
        // Extra facts a writer adds are kept.
        channels: 2,
      },
      at: at(10),
    });
    await recordActivity(db(), {
      installId: null,
      kind: "budget_reached",
      facts: { monthStart: OCTOBER, budget: 50, projected: 61 },
      at: at(20),
    });

    const appActivity = await listActivity(db(), { installId: "a" });
    expect(appActivity.map((e) => e.kind)).toEqual(["resumed", "alert_sent", "paused"]);
    expect(appActivity[0]).toMatchObject({ by: "u1", facts: { pauseId: "p1" } });
    expect(appActivity[1]?.facts).toEqual({
      ruleId: "r1",
      sentence: "When it has spent $6.00 this month",
      periodStart: OCTOBER,
      value: 6.2,
      amount: 6,
      channels: 2,
    });

    expect((await listActivity(db(), { installId: null })).map((e) => e.kind)).toEqual([
      "budget_reached",
    ]);
    expect(await listActivity(db(), { limit: 2 })).toHaveLength(2);
    expect(
      (await listActivity(db(), { since: at(10), kinds: ["alert_sent", "resumed"] })).map(
        (e) => e.kind,
      ),
    ).toEqual(["resumed", "alert_sent"]);
    expect(await listActivity(db(), { kinds: [] })).toEqual([]);
  });

  it("counts entries: alerts sent this period, the budget reached this month", async () => {
    const sent = (minutes: number) =>
      recordActivity(db(), {
        installId: "a",
        kind: "alert_sent",
        facts: { ruleId: "r1", sentence: "s", periodStart: OCTOBER, value: 1, amount: 1 },
        at: at(minutes),
      });
    await sent(-60 * 24 * 20);
    await sent(0);
    await sent(5);
    const month = new Date(OCTOBER * 1000);
    expect(await countActivity(db(), { installId: "a", kinds: ["alert_sent"], since: month })).toBe(
      2,
    );
    expect(await countActivity(db(), { installId: "b", kinds: ["alert_sent"] })).toBe(0);

    const budgetThisMonth = () =>
      countActivity(db(), { installId: null, kinds: ["budget_reached"], since: month });
    expect(await budgetThisMonth()).toBe(0);
    await recordActivity(db(), {
      installId: null,
      kind: "budget_reached",
      facts: { monthStart: OCTOBER, budget: 50, projected: 61 },
      at: NOW,
    });
    expect(await budgetThisMonth()).toBe(1);
  });

  it("refuses facts that do not fit the kind, and skips a row that no longer reads", async () => {
    await expect(
      recordActivity(db(), {
        installId: "a",
        kind: "observability_changed",
        facts: { enabled: "yes" } as unknown as { enabled: boolean },
      }),
    ).rejects.toThrow(ZodError);
    await env.DB.prepare(
      "INSERT INTO usage_activity (id, install_id, at, kind, by, facts_json) VALUES ('x', 'a', 0, 'paused', NULL, '{}')",
    ).run();
    expect(await listActivity(db(), { installId: "a" })).toEqual([]);
  });

  it("prunes entries older than 400 days", async () => {
    const entry = (when: Date) =>
      recordActivity(db(), {
        installId: "a",
        kind: "cap_set_aside",
        facts: { until: when.getTime() },
        at: when,
      });
    await entry(new Date(NOW.getTime() - 401 * 86_400_000));
    await entry(new Date(NOW.getTime() - 399 * 86_400_000));
    expect(await pruneActivity(db(), NOW)).toBe(1);
    expect(await countActivity(db(), {})).toBe(1);
  });
});
