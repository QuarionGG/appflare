import { reset } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { beforeEach, describe, expect, it } from "vitest";
import { createDb } from "../db/client";
import { createMigrator } from "../db/migrate";
import { migrations } from "../db/migrations/index";
import type { UsageEvent } from "../notifications/usage-events.server";
import { checkAccountLimits } from "./account-limits.server";
import { recordActivity } from "./store/activity.server";
import type { SpendWatchReport } from "./watcher-judge.server";

/** 2026-10-12 15:30 UTC. */
const NOW = Date.UTC(2026, 9, 12, 15, 30);
const db = () => createDb(env.DB);
const report = (): SpendWatchReport => ({
  status: "watching",
  apps: 1,
  newApps: 0,
  rowsWritten: 0,
  alerts: 0,
  pauses: 0,
  deferred: 0,
  subrequests: 0,
  history: null,
  pruned: null,
});
const watchEnv = () => ({ ...env, SELF: undefined, JOBS: env.JOBS });

beforeEach(async () => {
  await reset();
  await createMigrator(migrations).ensure(env.DB);
});

describe("checkAccountLimits", () => {
  it("knows the products the account was warned about today without a reading", async () => {
    await recordActivity(db(), {
      installId: null,
      kind: "limit_near",
      facts: { product: "d1_rows_written", share: 0.93, runsOutAt: null },
      at: new Date(NOW - 3_600_000),
    });
    // Yesterday's is over.
    await recordActivity(db(), {
      installId: null,
      kind: "limit_near",
      facts: { product: "kv_writes", share: 0.95, runsOutAt: null },
      at: new Date(Date.UTC(2026, 9, 11, 23)),
    });
    const sent: UsageEvent[] = [];
    const result = await checkAccountLimits(
      watchEnv(),
      db(),
      { now: NOW, accountToday: null, usage: new Map(), listed: new Set() },
      {
        emit: async (_e, event) => {
          sent.push(event);
          return { status: "skipped", reason: "no-channel" };
        },
      },
      report(),
    );
    // An app's warning about it still skips the channels the account's reached.
    expect([...result.covered]).toEqual(["d1_rows_written"]);
    expect(result.deliver).toEqual([]);
    expect(sent).toEqual([]);
  });
});
