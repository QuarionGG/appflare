import { reset } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { beforeEach, describe, expect, it } from "vitest";
import { createDb } from "../db/client";
import { createMigrator } from "../db/migrate";
import { migrations } from "../db/migrations/index";
import { SETTING, writeSettings } from "../db/settings";
import {
  addChannel,
  BOT_TOKEN,
  CHAT_ID,
  DISCORD_URL,
  HOOK_URL,
  MANAGER,
  SECRET,
  SLACK_URL,
  services,
} from "../test/notification-fixtures";
import { INSTALL_ID, seedInstall } from "../test/seed-install";
import { MANAGER_URL_KEY, pruneOutbox, USAGE_EVENT_RETENTION_MS } from "./outbox.server";
import type { NotificationEvent } from "./schema";
import { createNotificationUnits } from "./units";
import {
  emitUsageEvent,
  resumeIsNews,
  type UsageEvent,
  usageEventKey,
} from "./usage-events.server";

/**
 * Spend protection's events reach the channels at once, through the
 * delivery unit (which runs in this process in place of `SELF`), once each.
 */

const NOW = Date.UTC(2026, 9, 12, 14, 30);
const SINCE = Date.UTC(2026, 9, 12, 14, 5);
const USAGE_EVENTS: NotificationEvent[] = [
  "usage_unusual",
  "usage_alert",
  "usage_limit_near",
  "app_paused",
  "app_resumed",
  "budget_reached",
];

beforeEach(async () => {
  await reset();
  await createMigrator(migrations).ensure(env.DB);
  await seedInstall();
  await env.DB.prepare("INSERT INTO settings (key, value, updated_at) VALUES (?1, ?2, 0)")
    .bind(MANAGER_URL_KEY, MANAGER)
    .run();
  await env.DB.batch(
    [
      ["u-ada", "Ada Lovelace"],
      ["u-grace", "Grace Hopper"],
    ].map(([id, name]) =>
      env.DB.prepare(
        "INSERT INTO user (id, name, email, email_verified, role, created_at, updated_at) VALUES (?1, ?2, ?3, 1, 'admin', 0, 0)",
      ).bind(id, name, `${id}@example.com`),
    ),
  );
});

function withSelf(fetch = services().fetch) {
  const units = createNotificationUnits(
    { DB: env.DB, BETTER_AUTH_SECRET: SECRET },
    { fetch, now: () => NOW + 1_000 },
  );
  return { DB: env.DB, SELF: units };
}

const UNUSUAL: UsageEvent = {
  type: "usage_unusual",
  installId: INSTALL_ID,
  plan: "paid",
  since: SINCE,
  product: "do_requests",
  perHour: 48_200,
  times: 120,
  factor: 20,
  burnPerHour: 3.2,
  spentToday: 9.8,
};

async function eventRows() {
  const { results } = await env.DB.prepare(
    "SELECT type, dedupe_key, facts_json, occurred_at FROM notification_events ORDER BY dedupe_key",
  ).all<{ type: string; dedupe_key: string; facts_json: string; occurred_at: number }>();
  return results;
}

describe("emitUsageEvent", () => {
  it("sends at once to every kind of channel that wants it, linking to the app's Usage tab", async () => {
    for (const settings of [
      { kind: "telegram" as const, botToken: BOT_TOKEN, chatId: CHAT_ID },
      { kind: "slack" as const, webhookUrl: SLACK_URL },
      { kind: "discord" as const, webhookUrl: DISCORD_URL },
      { kind: "webhook" as const, url: HOOK_URL },
    ]) {
      await addChannel({ label: settings.kind, events: USAGE_EVENTS, settings });
    }
    await addChannel({
      label: "Updates only",
      events: ["update_available"],
      settings: { kind: "slack", webhookUrl: SLACK_URL },
    });
    const svc = services();
    const outcome = await emitUsageEvent(withSelf(svc.fetch), UNUSUAL, { now: () => NOW });
    expect(outcome).toMatchObject({
      status: "queued",
      queued: 4,
      delivered: { sent: 4, retrying: 0, failed: 0 },
    });
    expect(svc.posted).toHaveLength(4);
    for (const post of svc.posted) {
      expect(post.body).toContain("Unusual usage: cut");
      expect(post.body).toContain(`${MANAGER}/apps/i1?tab=usage`);
    }
    const [row] = await eventRows();
    expect(row).toMatchObject({
      type: "usage_unusual",
      dedupe_key: `usage_unusual:i1:${SINCE}`,
      occurred_at: SINCE,
    });
    expect(JSON.parse(row?.facts_json ?? "{}")).toMatchObject({
      app: { installId: "i1", instance: "cut", workerName: "cut" },
      product: "do_requests",
      times: 120,
    });
  });

  it("records it for the scheduled run when there is no SELF", async () => {
    await addChannel({
      label: "Team",
      events: ["usage_unusual"],
      settings: { kind: "slack", webhookUrl: SLACK_URL },
    });
    const outcome = await emitUsageEvent({ DB: env.DB }, UNUSUAL, { now: () => NOW });
    expect(outcome).toMatchObject({ status: "queued", queued: 1, delivered: null });
    const pending = await env.DB.prepare(
      "SELECT count(*) AS n FROM notification_deliveries WHERE status = 'pending'",
    ).first<{ n: number }>();
    expect(pending?.n).toBe(1);
  });

  it("writes nothing when no channel wants the event", async () => {
    await addChannel({
      label: "Updates only",
      events: ["update_available"],
      settings: { kind: "slack", webhookUrl: SLACK_URL },
    });
    expect(await emitUsageEvent(withSelf(), UNUSUAL, { now: () => NOW })).toEqual({
      status: "skipped",
      reason: "no-channel",
    });
    expect(await eventRows()).toEqual([]);
  });

  it("names the people who paused and resumed, and Appflare when it did", async () => {
    await addChannel({
      label: "Team",
      events: ["app_paused", "app_resumed"],
      settings: { kind: "slack", webhookUrl: SLACK_URL },
    });
    const svc = services();
    const self = withSelf(svc.fetch);
    await emitUsageEvent(
      self,
      {
        type: "app_paused",
        installId: INSTALL_ID,
        pauseId: "p1",
        pausedBy: "u-ada",
        cause: { reason: "manual" },
      },
      { now: () => NOW },
    );
    await emitUsageEvent(
      self,
      {
        type: "app_paused",
        installId: INSTALL_ID,
        pauseId: "p2",
        pausedBy: "auto",
        cause: { reason: "cap", amount: 2, period: "day" },
      },
      { now: () => NOW },
    );
    await emitUsageEvent(
      self,
      {
        type: "app_resumed",
        installId: INSTALL_ID,
        pauseId: "p2",
        pausedBy: "auto",
        resumedBy: "u-grace",
        capSetAsideUntil: null,
      },
      { now: () => NOW },
    );
    const texts = svc.posted.map((p) => (JSON.parse(p.body) as { text: string }).text);
    expect(texts[0]).toContain("*Ada Lovelace paused cut*");
    expect(texts[1]).toContain("*Appflare paused cut*");
    expect(texts[1]).toContain("It passed its $2.00 daily cap.");
    expect(texts[2]).toContain("*cut resumed*\nGrace Hopper resumed it.");
  });

  it("keeps quiet when someone resumes their own pause", async () => {
    await addChannel({
      label: "Team",
      events: ["app_resumed"],
      settings: { kind: "slack", webhookUrl: SLACK_URL },
    });
    const outcome = await emitUsageEvent(withSelf(), {
      type: "app_resumed",
      installId: INSTALL_ID,
      pauseId: "p1",
      pausedBy: "u-ada",
      resumedBy: "u-ada",
      capSetAsideUntil: null,
    });
    expect(outcome).toEqual({ status: "skipped", reason: "own-resume" });
    expect(await eventRows()).toEqual([]);
  });

  it("reads the plan from settings when the caller does not say", async () => {
    await writeSettings(createDb(env.DB), { [SETTING.accountPlan]: "paid" });
    await addChannel({
      label: "Team",
      events: ["usage_alert"],
      settings: { kind: "slack", webhookUrl: SLACK_URL },
    });
    await emitUsageEvent(
      { DB: env.DB },
      {
        type: "usage_alert",
        installId: INSTALL_ID,
        ruleId: "r1",
        sentence: "When it has used 80% of included usage this month",
        kind: "spent",
        unit: "pct",
        amount: 80,
        value: 85,
        period: "month",
        periodStart: Date.UTC(2026, 9, 1) / 1000,
      },
      { now: () => NOW },
    );
    const [row] = await eventRows();
    expect(JSON.parse(row?.facts_json ?? "{}")).toMatchObject({ plan: "paid", value: 85 });
  });

  it("skips an install that is gone and a product without a free daily limit", async () => {
    await addChannel({
      label: "Team",
      events: ["usage_unusual", "usage_limit_near"],
      settings: { kind: "slack", webhookUrl: SLACK_URL },
    });
    expect(await emitUsageEvent({ DB: env.DB }, { ...UNUSUAL, installId: "gone" })).toEqual({
      status: "skipped",
      reason: "no-install",
    });
    expect(
      await emitUsageEvent(
        { DB: env.DB },
        {
          type: "usage_limit_near",
          installId: INSTALL_ID,
          product: "workers_cpu_ms",
          used: 1,
          runsOutAt: null,
          appShare: 1,
        },
      ),
    ).toEqual({ status: "skipped", reason: "no-free-limit" });
  });

  it("returns an error instead of throwing", async () => {
    const broken = {
      prepare: () => {
        throw new Error("D1 is down");
      },
    } as unknown as D1Database;
    expect(await emitUsageEvent({ DB: broken }, UNUSUAL)).toEqual({
      status: "error",
      error: "D1 is down",
    });
  });
});

describe("each event happens once", () => {
  it("keys an episode by its start, an alert by rule and period, a limit by day, the budget by month, a pause by its id", () => {
    const at = Date.UTC(2026, 9, 12, 18, 0);
    const day = Date.UTC(2026, 9, 12) / 1000;
    expect(usageEventKey(UNUSUAL, at)).toBe(`usage_unusual:i1:${SINCE}`);
    expect(
      usageEventKey(
        {
          type: "usage_alert",
          installId: "i1",
          ruleId: "r1",
          sentence: "s",
          kind: "spent",
          unit: "usd",
          amount: 5,
          value: 6,
          period: "week",
          periodStart: 1_760_313_600,
        },
        at,
      ),
    ).toBe("usage_alert:r1:1760313600");
    const limit: UsageEvent = {
      type: "usage_limit_near",
      installId: "i1",
      product: "workers_requests",
      used: 1,
      runsOutAt: null,
      appShare: 1,
    };
    expect(usageEventKey(limit, at)).toBe(`usage_limit_near:i1:${day}`);
    // Later the same UTC day: the same key; the next day: a new one.
    expect(usageEventKey(limit, at + 5 * 3_600_000)).toBe(`usage_limit_near:i1:${day}`);
    expect(usageEventKey(limit, at + 6 * 3_600_000)).toBe(`usage_limit_near:i1:${day + 86_400}`);
    expect(
      usageEventKey(
        { type: "budget_reached", budget: 50, projected: 60, monthStart: 1_759_276_800 },
        at,
      ),
    ).toBe("budget_reached:1759276800");
    expect(
      usageEventKey(
        {
          type: "app_paused",
          installId: "i1",
          pauseId: "p9",
          pausedBy: "auto",
          cause: { reason: "manual" },
        },
        at,
      ),
    ).toBe("app_paused:p9");
    expect(
      usageEventKey(
        {
          type: "app_resumed",
          installId: "i1",
          pauseId: "p9",
          pausedBy: "auto",
          resumedBy: null,
          capSetAsideUntil: null,
        },
        at,
      ),
    ).toBe("app_resumed:p9");
  });

  it("sends a repeated event once, and a new episode again", async () => {
    await addChannel({
      label: "Team",
      events: ["usage_unusual", "usage_limit_near"],
      settings: { kind: "slack", webhookUrl: SLACK_URL },
    });
    const svc = services();
    const self = withSelf(svc.fetch);
    await emitUsageEvent(self, UNUSUAL, { now: () => NOW });
    const again = await emitUsageEvent(self, UNUSUAL, { now: () => NOW + 300_000 });
    expect(again).toMatchObject({ status: "queued", queued: 0, delivered: null });
    expect(svc.posted).toHaveLength(1);
    await emitUsageEvent(self, { ...UNUSUAL, since: SINCE + 86_400_000 }, { now: () => NOW });
    expect(svc.posted).toHaveLength(2);

    const limit: UsageEvent = {
      type: "usage_limit_near",
      installId: INSTALL_ID,
      product: "workers_requests",
      used: 80_000,
      runsOutAt: NOW + 3_600_000,
      appShare: 0.6,
    };
    await emitUsageEvent(self, limit, { now: () => NOW });
    await emitUsageEvent(
      self,
      { ...limit, runsOutAt: null, used: 100_000 },
      { now: () => NOW + 7_200_000 },
    );
    expect(svc.posted).toHaveLength(3);
  });

  it("tells a resume apart from someone else's or Appflare's", () => {
    expect(resumeIsNews("u-ada", "u-ada")).toBe(false);
    expect(resumeIsNews("u-ada", "u-grace")).toBe(true);
    expect(resumeIsNews("auto", "u-ada")).toBe(true);
    expect(resumeIsNews("u-ada", null)).toBe(true);
  });

  it("keeps settled events while they still dedupe, then prunes them", async () => {
    await addChannel({
      label: "Team",
      events: ["budget_reached"],
      settings: { kind: "slack", webhookUrl: SLACK_URL },
    });
    const budget: UsageEvent = {
      type: "budget_reached",
      budget: 50,
      projected: 60,
      monthStart: Date.UTC(2026, 9, 1) / 1000,
    };
    await emitUsageEvent(withSelf(), budget, { now: () => NOW });
    await pruneOutbox(env.DB, NOW + 31 * 86_400_000);
    expect(await eventRows()).toHaveLength(1);
    await pruneOutbox(env.DB, NOW + USAGE_EVENT_RETENTION_MS + 1);
    expect(await eventRows()).toEqual([]);
  });
});
