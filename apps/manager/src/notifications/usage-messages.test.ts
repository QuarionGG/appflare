import { describe, expect, it } from "vitest";
import {
  discordText,
  type NotificationFacts,
  notificationFactsSchema,
  plainText,
  renderMessage,
  slackText,
} from "./messages";
import { webhookBody } from "./send";

/**
 * Spend protection's messages: the words for every event and each kind of
 * cause, and the text each kind of channel receives.
 */

const app = {
  installId: "i1",
  app: "Status",
  instance: "Service status",
  workerName: "statusbeam",
};
const M = "https://appflare.ada.workers.dev";
const USAGE = `${M}/apps/i1?tab=usage`;
const at = (h: number, m: number, day = 12) => Date.UTC(2026, 9, day, h, m);
const PAUSED_PAGE =
  'Visitors see a "paused" page and its scheduled work stops; its data stays as it is. Resume it from Home or its Usage tab.';

const cases: Array<[string, NotificationFacts, string, string[], string]> = [
  [
    "unusual usage on Paid",
    {
      type: "usage_unusual",
      app,
      plan: "paid",
      since: at(14, 5),
      product: "do_requests",
      perHour: 48_200,
      times: 120,
      factor: 20,
      burnPerHour: 3.2,
      spentToday: 9.8,
    },
    "Unusual usage: Service status",
    [
      "Service status is using far more than usual: Durable Objects requests at 48.2K an hour since 14:05 UTC, 120× its normal.",
      "About $3.20 an hour at Cloudflare's prices, $9.80 so far today.",
      "Pause it from Home or its Usage tab if this is not expected.",
    ],
    USAGE,
  ],
  [
    "unusual usage on Free",
    {
      type: "usage_unusual",
      app,
      plan: "free",
      since: at(9, 30),
      product: "d1_rows_read",
      perHour: 2_400_000,
      times: 6.5,
      factor: 5,
      burnPerHour: 0,
      spentToday: 0,
      freeShare: 0.4,
    },
    "Unusual usage: Service status",
    [
      "Service status is using far more than usual: D1 rows read at 2.4M rows an hour since 09:30 UTC, 6.5× its normal.",
      "At this pace it uses 40% of today's free D1 rows read.",
      "Pause it from Home or its Usage tab if this is not expected.",
    ],
    USAGE,
  ],
  [
    "a usage alert in dollars, spent",
    {
      type: "usage_alert",
      app,
      plan: "paid",
      ruleId: "r1",
      sentence: "When it has spent $5.00 this week",
      kind: "spent",
      unit: "usd",
      amount: 5,
      value: 5.123,
      period: "week",
      periodStart: at(0, 0) / 1000,
    },
    "Usage alert: Service status",
    [
      "Service status has spent about $5.12 this week at Cloudflare's prices. The alert is at $5.00.",
    ],
    USAGE,
  ],
  [
    "a usage alert of included usage, on pace",
    {
      type: "usage_alert",
      app,
      plan: "paid",
      ruleId: "r2",
      sentence: "When it is on pace to spend 80% of included usage this month",
      kind: "pace",
      unit: "pct",
      amount: 80,
      value: 130,
      period: "month",
      periodStart: Date.UTC(2026, 9, 1) / 1000,
    },
    "Usage alert: Service status",
    ["Service status is on pace to use 130% of included usage this month. The alert is at 80%."],
    USAGE,
  ],
  [
    "a usage alert of a free daily limit",
    {
      type: "usage_alert",
      app,
      plan: "free",
      ruleId: "r3",
      sentence: "When it has used 75% of a free daily limit today",
      kind: "spent",
      unit: "pct",
      amount: 75,
      value: 82,
      period: "day",
      periodStart: at(0, 0) / 1000,
    },
    "Usage alert: Service status",
    ["Service status has used 82% of a free daily limit today. The alert is at 75%."],
    USAGE,
  ],
  [
    "a free daily limit about to run out",
    {
      type: "usage_limit_near",
      app,
      product: "workers_requests",
      limit: 100_000,
      used: 64_000,
      runsOutAt: at(21, 40),
      appShare: 0.64,
      day: at(0, 0) / 1000,
    },
    "Free Worker requests run out around 21:40 UTC",
    [
      "Service status is getting 64% of today's Worker requests. When the account's 100,000 free Worker requests for the day are used, every app stops answering until 00:00 UTC.",
    ],
    USAGE,
  ],
  [
    "a free daily limit used up",
    {
      type: "usage_limit_near",
      app,
      product: "do_requests",
      limit: 100_000,
      used: 100_000,
      runsOutAt: null,
      appShare: 0.97,
      day: at(0, 0) / 1000,
    },
    "Free Durable Objects requests used up for today",
    [
      "This account used its 100,000 free Durable Objects requests for today, 97% of them by Service status. Cloudflare refuses more until 00:00 UTC, so apps that need them fail until then.",
      "The Free plan bills nothing; pausing Service status stops it happening again tomorrow.",
    ],
    USAGE,
  ],
  [
    "paused by Appflare for a loop on Paid",
    {
      type: "app_paused",
      app,
      pauseId: "p1",
      by: null,
      cause: { reason: "loop", level: "standard", plan: "paid", burnPerHour: 3.2, times: 120 },
    },
    "Appflare paused Service status",
    [
      "Its usage looked like a loop for 10 minutes: over $1.00 an hour and 50× its normal (loop check: Standard). It reached about $3.20 an hour, 120× its normal.",
      PAUSED_PAGE,
    ],
    USAGE,
  ],
  [
    "paused by Appflare for a loop on Free",
    {
      type: "app_paused",
      app,
      pauseId: "p2",
      by: null,
      cause: { reason: "loop", level: "strict", plan: "free" },
    },
    "Appflare paused Service status",
    [
      "Its usage looked like a loop for 10 minutes: 20× its normal and on pace to use 10% of a free daily limit within the day (loop check: Strict).",
      PAUSED_PAGE,
    ],
    USAGE,
  ],
  [
    "paused by Appflare for a Durable Object's alarms",
    {
      type: "app_paused",
      app,
      pauseId: "p3",
      by: null,
      cause: { reason: "loop", level: "relaxed", plan: "paid", alarms: 5400 },
    },
    "Appflare paused Service status",
    [
      "One of its Durable Objects ran its alarm 5.4K times in an hour, which only a loop does.",
      PAUSED_PAGE,
    ],
    USAGE,
  ],
  [
    "paused by Appflare past its cap",
    {
      type: "app_paused",
      app,
      pauseId: "p4",
      by: null,
      cause: { reason: "cap", amount: 2, period: "day", spent: 2.04 },
    },
    "Appflare paused Service status",
    ["It passed its $2.00 daily cap.", PAUSED_PAGE],
    USAGE,
  ],
  [
    "paused by Appflare for the budget",
    {
      type: "app_paused",
      app,
      pauseId: "p5",
      by: null,
      cause: { reason: "budget", budget: 50, projected: 62.4 },
    },
    "Appflare paused Service status",
    [
      "The account's bill was on pace for about $62.40, past its $50.00 monthly budget, and this app had the largest share of the month's usage.",
      PAUSED_PAGE,
    ],
    USAGE,
  ],
  [
    "paused by someone",
    {
      type: "app_paused",
      app,
      pauseId: "p6",
      by: "Ada Lovelace",
      cause: { reason: "manual" },
    },
    "Ada Lovelace paused Service status",
    [PAUSED_PAGE],
    USAGE,
  ],
  [
    "resumed by someone, with the cap set aside",
    {
      type: "app_resumed",
      app,
      pauseId: "p4",
      by: "Grace Hopper",
      capSetAsideUntil: Date.UTC(2026, 9, 13),
    },
    "Service status resumed",
    [
      "Grace Hopper resumed it. Visitors reach it again.",
      "Its cap is set aside until it resets at Oct 13, 00:00 UTC; the loop check still runs.",
    ],
    USAGE,
  ],
  [
    "resumed by Appflare",
    { type: "app_resumed", app, pauseId: "p1", by: null, capSetAsideUntil: null },
    "Service status resumed",
    ["Appflare resumed it. Visitors reach it again."],
    USAGE,
  ],
  [
    "the monthly budget reached",
    {
      type: "budget_reached",
      budget: 50,
      projected: 62.4,
      monthStart: Date.UTC(2026, 9, 1) / 1000,
    },
    "Monthly budget reached",
    [
      "This month's bill is on pace for about $62.40 at Cloudflare's prices, past the $50.00 budget (the $5 plan included).",
      "Appflare pauses apps, the one with the largest share of this month's usage first, until the bill fits. Apps set to never pause for the budget keep running.",
    ],
    `${M}/settings/account`,
  ],
];

describe("spend protection messages", () => {
  it.each(cases)("%s", (_name, facts, title, lines, url) => {
    expect(notificationFactsSchema.parse(facts)).toEqual(facts);
    expect(renderMessage(facts, M)).toEqual({ title, lines, url });
  });

  it("covers every spend protection event", () => {
    expect(new Set(cases.map(([, facts]) => facts.type))).toEqual(
      new Set([
        "usage_unusual",
        "usage_alert",
        "usage_limit_near",
        "app_paused",
        "app_resumed",
        "budget_reached",
      ]),
    );
  });

  it("refuses facts that would make a wrong message", () => {
    const bad = [
      { type: "usage_unusual", app, plan: "paid", since: 1, product: "x", perHour: 1, times: 0 },
      { type: "app_paused", app, pauseId: "p", by: null, cause: { reason: "cap", amount: 0 } },
      { type: "usage_limit_near", app, product: "x", limit: 1, used: 1, runsOutAt: null },
      { type: "budget_reached", budget: 50 },
    ];
    for (const facts of bad) expect(notificationFactsSchema.safeParse(facts).success).toBe(false);
  });
});

describe("what each kind of channel receives", () => {
  const byType = new Map<string, [NotificationFacts, string, string[], string]>();
  for (const [, facts, title, lines, url] of cases) {
    if (!byType.has(facts.type)) byType.set(facts.type, [facts, title, lines, url]);
  }
  const events = [...byType.values()];

  it.each(events)(
    "Telegram: %j as plain text, the link on its own line",
    (facts, title, lines, url) => {
      expect(plainText(renderMessage(facts, M))).toBe([title, ...lines, url].join("\n"));
    },
  );

  it.each(events)("Slack: %j in bold, with a labelled link", (facts, title, lines, url) => {
    expect(slackText(renderMessage(facts, M))).toBe(
      [`*${title}*`, ...lines, `<${url}|Open in Appflare>`].join("\n"),
    );
  });

  it.each(events)("Discord: %j in bold, the link without a preview", (facts, title, lines, url) => {
    expect(discordText(renderMessage(facts, M))).toBe(
      [`**${title}**`, ...lines, `<${url}>`].join("\n"),
    );
  });

  it.each(events)("webhook: %j as JSON with the facts as data", (facts, title, lines, url) => {
    const body = JSON.parse(
      webhookBody(
        { id: "e1", facts, occurredAt: at(14, 5), managerUrl: M },
        renderMessage(facts, M),
        at(14, 6),
      ),
    ) as Record<string, unknown>;
    const { type, ...data } = facts;
    expect(body).toEqual({
      id: "e1",
      event: type,
      test: false,
      occurredAt: "2026-10-12T14:05:00.000Z",
      sentAt: "2026-10-12T14:06:00.000Z",
      title,
      text: lines.join("\n"),
      url,
      managerUrl: M,
      data,
    });
  });

  it("escapes an app's name for Slack and Discord", () => {
    const named = { ...app, instance: "<b>&_*loud*_" };
    const message = renderMessage(
      { type: "app_resumed", app: named, pauseId: "p", by: null, capSetAsideUntil: null },
      M,
    );
    expect(slackText(message)).toContain("*&lt;b&gt;&amp;_*loud*_ resumed*");
    expect(discordText(message)).toContain("**<b\\>&\\_\\*loud\\*\\_ resumed**");
  });
});
