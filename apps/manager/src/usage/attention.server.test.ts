import { reset } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { beforeEach, describe, expect, it } from "vitest";
import { createDb } from "../db/client";
import { createMigrator } from "../db/migrate";
import { migrations } from "../db/migrations/index";
import { SETTING, writeSettings } from "../db/settings";
import { addChannel, SLACK_URL } from "../test/notification-fixtures";
import { readUsageAttention } from "./attention.server";
import { recordActivity } from "./store/activity.server";
import { writeAppSpendSettings } from "./store/app-settings.server";
import { writeSpendDefaults } from "./store/defaults.server";
import { closePause, openPause } from "./store/pauses.server";
import { initialUsageState, writeUsageStates } from "./store/usage-state.server";

/**
 * Home's spend protection rows, read from what the watcher and the pause
 * jobs store: usage states, open pauses, and the activity log.
 */

const NOW = Date.UTC(2026, 9, 12, 15, 30);
const SINCE = Date.UTC(2026, 9, 12, 14, 5);
const db = () => createDb(env.DB);
const read = (over: { installIds?: string[]; isAdmin?: boolean; now?: number } = {}) =>
  readUsageAttention(env.DB, {
    installIds: over.installIds ?? ["a", "b", "c"],
    isAdmin: over.isAdmin ?? true,
    now: over.now ?? NOW,
  });

beforeEach(async () => {
  await reset();
  await createMigrator(migrations).ensure(env.DB);
  await env.DB.prepare(
    "INSERT INTO user (id, name, email, email_verified, role, created_at, updated_at) VALUES ('u-ada', 'Ada Lovelace', 'ada@example.com', 1, 'admin', 0, 0)",
  ).run();
});

async function episode(installId: string, extras: Record<string, unknown> | null) {
  await writeUsageStates(
    db(),
    [{ ...initialUsageState(installId), unusualSince: SINCE, lastBurn: 3, normalBurn: 0.05 }],
    new Date(NOW),
  );
  if (extras !== null) {
    await recordActivity(db(), {
      installId,
      kind: "unusual_started",
      facts: { factor: 20, times: 120, ...extras },
      at: new Date(SINCE + 60_000),
    });
  }
}

async function limitNear(installId: string, facts: Record<string, unknown>, at = NOW - 600_000) {
  await recordActivity(db(), {
    installId,
    kind: "limit_near",
    facts: { product: "workers_requests", share: 0.6, runsOutAt: NOW + 3_600_000, ...facts },
    at: new Date(at),
  });
}

describe("readUsageAttention", () => {
  it("is empty while nothing needs a look", async () => {
    expect(await read()).toEqual([]);
    await writeUsageStates(db(), [initialUsageState("a")], new Date(NOW));
    expect(await read()).toEqual([]);
  });

  it("shows an unusual-usage episode with the numbers its start recorded, and where it was sent", async () => {
    await writeSettings(db(), { [SETTING.accountPlan]: "paid" });
    await addChannel({
      label: "Ops Slack",
      events: ["usage_unusual"],
      settings: { kind: "slack", webhookUrl: SLACK_URL },
    });
    await addChannel({
      label: "Updates",
      events: ["update_available"],
      settings: { kind: "slack", webhookUrl: SLACK_URL },
    });
    await episode("a", {
      product: "do_requests",
      perHour: 48_200,
      burnPerHour: 3.2,
      spentToday: 9.8,
    });
    expect(await read()).toEqual([
      {
        kind: "unusual",
        installId: "a",
        plan: "paid",
        since: SINCE,
        product: "do_requests",
        perHour: 48_200,
        times: 120,
        burnPerHour: 3.2,
        spentToday: 9.8,
        freeShare: null,
        sentTo: ["Ops Slack"],
      },
    ]);
    // Members cannot see channels.
    expect((await read({ isAdmin: false }))[0]).toMatchObject({ sentTo: [] });
  });

  it("falls back to the usage state when the episode's start recorded no numbers", async () => {
    await episode("a", null);
    expect(await read()).toEqual([
      {
        kind: "unusual",
        installId: "a",
        plan: "free",
        since: SINCE,
        product: null,
        perHour: null,
        times: 60,
        burnPerHour: 3,
        spentToday: null,
        freeShare: null,
        sentTo: [],
      },
    ]);
  });

  it("shows a paused app instead of its unusual usage, with who paused it", async () => {
    await episode("a", { product: "do_requests", perHour: 1 });
    await openPause(db(), {
      installId: "a",
      pausedBy: "u-ada",
      reason: "manual",
      pausedAt: new Date(NOW - 60_000),
    });
    expect(await read()).toEqual([
      {
        kind: "paused",
        installId: "a",
        pausedAt: NOW - 60_000,
        pausedBy: "Ada Lovelace",
        cause: { reason: "manual" },
        loopSince: SINCE,
        stillPastCap: null,
      },
    ]);
    // Resumed: the episode shows again.
    await closePause(db(), "a", { resumedBy: "u-ada", resumedAt: new Date(NOW) });
    expect((await read())[0]).toMatchObject({ kind: "unusual", installId: "a" });
  });

  it("offers to set the cap aside for an app paused for a loop that is past its cap too", async () => {
    await writeSettings(db(), { [SETTING.accountPlan]: "paid" });
    await writeSpendDefaults(db(), {
      autoPause: true,
      cap: { on: true, amount: 0.5, period: "day" },
    });
    await openPause(db(), {
      installId: "b",
      pausedBy: "auto",
      reason: "loop",
      pausedAt: new Date(NOW - 600_000),
      detailJson: JSON.stringify({ level: "strict", plan: "paid", burnPerHour: 0.8 }),
    });
    // The watcher's latest numbers: $1.66 spent today.
    await writeSettings(db(), {
      [SETTING.spendOverview]: JSON.stringify({
        computedAt: NOW - 60_000,
        plan: "paid",
        bill: { now: 5, projected: 5 },
        apps: [
          {
            installId: "b",
            burnPerHour: 0,
            ratio: null,
            loop: {
              relaxed: { money: false, abnormal: false, trips: false },
              standard: { money: false, abnormal: false, trips: false },
              strict: { money: false, abnormal: false, trips: false },
            },
            spend: {
              day: { spent: 1.66, projected: 1.66, resetsAt: Date.UTC(2026, 9, 13) },
              week: { spent: 1.66, projected: 1.66, resetsAt: Date.UTC(2026, 9, 19) },
              month: { spent: 1.66, projected: 1.66, resetsAt: Date.UTC(2026, 10, 1) },
            },
            overageUsd: 0,
          },
        ],
      }),
    });
    expect((await read())[0]).toMatchObject({
      kind: "paused",
      cause: { reason: "loop" },
      stillPastCap: { amount: 0.5, period: "day", spent: 1.66, resetsAt: Date.UTC(2026, 9, 13) },
    });
    // On Workers Free there is no dollar cap to be past.
    await writeSettings(db(), { [SETTING.accountPlan]: "free" });
    expect((await read())[0]).toMatchObject({ stillPastCap: null });
  });

  it("offers to set the cap aside while a capped app is still past its cap", async () => {
    await writeSettings(db(), { [SETTING.accountPlan]: "paid" });
    await writeSpendDefaults(db(), {
      autoPause: true,
      cap: { on: true, amount: 2, period: "day" },
    });
    await openPause(db(), {
      installId: "b",
      pausedBy: "auto",
      reason: "cap",
      pausedAt: new Date(NOW - 600_000),
      detailJson: JSON.stringify({ amount: 2, period: "day", spent: 2.04 }),
    });
    const [row] = await read();
    expect(row).toEqual({
      kind: "paused",
      installId: "b",
      pausedAt: NOW - 600_000,
      pausedBy: null,
      cause: { reason: "cap", amount: 2, period: "day", spent: 2.04 },
      loopSince: null,
      stillPastCap: { amount: 2, period: "day", spent: 2.04, resetsAt: Date.UTC(2026, 9, 13) },
    });
    // The next day the cap starts afresh: Resume is one click.
    expect((await read({ now: Date.UTC(2026, 9, 13, 1) }))[0]).toMatchObject({
      stillPastCap: null,
    });
    // A cap already set aside, or auto-pause turned off for the app: one click too.
    await writeAppSpendSettings(
      db(),
      "b",
      { capSetAsideUntil: Date.UTC(2026, 9, 13) },
      {
        userId: "u-ada",
      },
    );
    expect((await read())[0]).toMatchObject({ stillPastCap: null });
    await writeAppSpendSettings(
      db(),
      "b",
      { capSetAsideUntil: null, autoPause: "off" },
      {
        userId: "u-ada",
      },
    );
    expect((await read())[0]).toMatchObject({ stillPastCap: null });
  });

  it("reads a pause whose detail does not read as its reason without a cause", async () => {
    await openPause(db(), {
      installId: "b",
      pausedBy: "auto",
      reason: "loop",
      pausedAt: new Date(NOW),
      detailJson: "{not json",
    });
    expect((await read())[0]).toMatchObject({ kind: "paused", cause: null, pausedBy: null });
  });

  it("shows today's free daily limit warnings: about to run out, and used up", async () => {
    await limitNear("a", { appShare: 0.64, runsOutAt: Date.UTC(2026, 9, 12, 21, 40) });
    await limitNear("b", { product: "do_requests", share: 1, runsOutAt: null, appShare: 0.97 });
    // Yesterday's warning, and one about an app Home does not list.
    await limitNear("c", {}, Date.UTC(2026, 9, 11, 22));
    await limitNear("gone", {});
    await episode("b", { product: "do_requests", perHour: 50_000 });
    const rows = (await read()).sort((x, y) => x.installId.localeCompare(y.installId));
    expect(rows).toEqual([
      {
        kind: "limit-near",
        installId: "a",
        product: "workers_requests",
        limit: 100_000,
        runsOutAt: Date.UTC(2026, 9, 12, 21, 40),
        appShare: 0.64,
      },
      {
        kind: "limit-used-up",
        installId: "b",
        product: "do_requests",
        limit: 100_000,
        appShare: 0.97,
        loopSince: SINCE,
      },
    ]);
    // Once the time it was to run out passes, it reads as used up.
    const later = await read({ now: Date.UTC(2026, 9, 12, 22) });
    expect(later.find((r) => r.installId === "a")).toMatchObject({ kind: "limit-used-up" });
  });

  it("reads nothing for apps Home does not list", async () => {
    await episode("x", { product: "do_requests", perHour: 1 });
    await openPause(db(), { installId: "x", pausedBy: "auto", reason: "manual" });
    expect(await read({ installIds: ["a"] })).toEqual([]);
    expect(await read({ installIds: [] })).toEqual([]);
  });
});
