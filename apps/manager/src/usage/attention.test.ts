import { describe, expect, it } from "vitest";
import { type AttentionApp, appSignals, attentionBadge, attentionItems } from "../home/attention";
import { attentionCopy } from "../home/attention-copy";
import { listWords, stillPastCapCopy, type UsageAttention, usageAttentionCopy } from "./attention";
import type { PauseCause } from "./attention-cause";

const clock = (t: number) => new Date(t).toISOString().slice(11, 16);
const at = (h: number, m: number) => Date.UTC(2026, 9, 12, h, m);
const LABEL = "Service status";

const UNUSUAL: UsageAttention = {
  kind: "unusual",
  installId: "status",
  plan: "paid",
  since: at(14, 5),
  product: "do_requests",
  perHour: 48_200,
  times: 120,
  burnPerHour: 3.2,
  spentToday: 9.8,
  freeShare: null,
  sentTo: ["Telegram", "Slack"],
};

describe("usageAttentionCopy", () => {
  it("unusual usage: what, how far above normal, what it costs, where the alert went", () => {
    expect(usageAttentionCopy(UNUSUAL, LABEL, clock)).toEqual({
      badge: { label: "Unusual usage", variant: "error" },
      title: "Service status is using far more than usual",
      description:
        "Durable Objects requests at 48.2K an hour since 14:05, 120× its normal. About $3.20 an hour at Cloudflare's prices, $9.80 so far today. Sent to Telegram and Slack.",
    });
  });

  it("a new app using a lot: no multiple of a normal it does not have", () => {
    const fresh: UsageAttention = {
      ...UNUSUAL,
      times: null,
      newApp: true,
      installedRecently: true,
      sentTo: [],
    };
    expect(usageAttentionCopy(fresh, LABEL, clock)).toEqual({
      badge: { label: "Unusual usage", variant: "error" },
      title: "Service status is new and already using a lot",
      description:
        "Durable Objects requests at 48.2K an hour since 14:05, with no usual week yet to compare with. About $3.20 an hour at Cloudflare's prices, $9.80 so far today.",
    });
    // Installed over a week ago, but too rarely used to have a normal: not "new".
    const rare: UsageAttention = { ...fresh, installedRecently: false };
    expect(usageAttentionCopy(rare, LABEL, clock)).toMatchObject({
      title: "Service status is already using a lot",
      description: expect.stringContaining(
        "since 14:05, with no usual usage to compare against yet.",
      ),
    });
  });

  it("unusual usage without the numbers the watcher records, and without channels", () => {
    const bare: UsageAttention = {
      ...UNUSUAL,
      product: null,
      perHour: null,
      times: null,
      burnPerHour: null,
      spentToday: null,
      sentTo: [],
    };
    expect(usageAttentionCopy(bare, LABEL, clock).description).toBe(
      "Since 14:05, its usage is far above its normal.",
    );
  });

  it("unusual usage on Free: the share of a free daily limit, not dollars", () => {
    const free: UsageAttention = {
      ...UNUSUAL,
      plan: "free",
      since: at(9, 30),
      product: "workers_requests",
      perHour: 9_000,
      times: 36,
      burnPerHour: 0.01,
      freeShare: 0.4,
      sentTo: [],
    };
    expect(usageAttentionCopy(free, LABEL, clock).description).toBe(
      "Worker requests at 9K an hour since 09:30, 36× its normal. At this pace it uses 40% of today's free Worker requests.",
    );
  });

  it("a free daily limit used up in a loop", () => {
    const item: UsageAttention = {
      kind: "limit-used-up",
      installId: "status",
      product: "do_requests",
      limit: 100_000,
      appShare: 0.97,
      loopSince: at(14, 5),
    };
    expect(usageAttentionCopy(item, LABEL, clock)).toEqual({
      badge: { label: "Limit reached", variant: "error" },
      title: "Today's free Durable Objects requests are used up",
      description:
        "Service status went into a loop at 14:05 and used this account's 100,000 free Durable Objects requests for today. Cloudflare refuses more until 00:00 UTC, so apps that need them fail until then. The Free plan bills nothing; pausing stops it happening again tomorrow.",
    });
  });

  it("a free daily limit used up without a loop: the app's share", () => {
    const item: UsageAttention = {
      kind: "limit-used-up",
      installId: "status",
      product: "workers_requests",
      limit: 100_000,
      appShare: 0.97,
      loopSince: null,
    };
    expect(usageAttentionCopy(item, LABEL, clock).description).toBe(
      "This account used its 100,000 free Worker requests for today, 97% of them by Service status. Cloudflare refuses more until 00:00 UTC, so every app stops answering until then. The Free plan bills nothing; pausing stops it happening again tomorrow.",
    );
  });

  it("paused by someone, after unusual usage", () => {
    const item: UsageAttention = {
      kind: "paused",
      installId: "status",
      pausedAt: at(15, 0),
      pausedBy: "Ada Lovelace",
      cause: { reason: "manual" },
      loopSince: at(14, 5),
      stillPastCap: null,
    };
    expect(usageAttentionCopy(item, LABEL, clock)).toEqual({
      badge: { label: "Paused", variant: "warning" },
      title: "Service status is paused",
      description:
        'Ada Lovelace paused it at 15:00 after unusual usage that began at 14:05. Visitors see a "paused" page until it is resumed.',
    });
  });

  it.each<[string, PauseCause | null, string]>([
    [
      "its cap",
      { reason: "cap", amount: 2, period: "day" },
      'It passed its $2.00 daily cap. Appflare paused it at 15:00. Visitors see a "paused" page. Resume it when its cap resets, or change the cap on its Usage tab.',
    ],
    [
      "a loop",
      { reason: "loop", level: "standard", plan: "paid" },
      'Its usage looked like a loop for 10 minutes: over $1.00 an hour and 50× its normal (loop check: Standard). Appflare paused it at 15:00. Visitors see a "paused" page. Resume when the cause is fixed, for example by undoing the settings change that started it.',
    ],
    [
      "the budget",
      { reason: "budget", budget: 50, projected: 62.4 },
      `This month's Appflare usage, including the $5 plan, was on pace for about $62.40, past the $50.00 monthly budget, and this app had the largest share of it. Appflare paused it at 15:00. Visitors see a "paused" page. Resume it when the budget allows, or exempt it from the budget on its Usage tab.`,
    ],
    [
      "a cause it did not record",
      null,
      'Appflare paused it at 15:00. Visitors see a "paused" page. Resume when the cause is fixed, for example by undoing the settings change that started it.',
    ],
  ])("paused by Appflare for %s", (_name, cause, description) => {
    const item: UsageAttention = {
      kind: "paused",
      installId: "status",
      pausedAt: at(15, 0),
      pausedBy: null,
      cause,
      loopSince: null,
      stillPastCap: null,
    };
    expect(usageAttentionCopy(item, LABEL, clock)).toEqual({
      badge: { label: "Paused", variant: "warning" },
      title: "Appflare paused Service status",
      description,
    });
  });

  it("a free daily limit about to run out", () => {
    const item: UsageAttention = {
      kind: "limit-near",
      installId: "links",
      product: "workers_requests",
      limit: 100_000,
      runsOutAt: at(21, 40),
      appShare: 0.64,
    };
    expect(usageAttentionCopy(item, "Short links", clock)).toEqual({
      badge: null,
      title: "Free Worker requests run out around 21:40",
      description:
        "Short links is getting 64% of today's Worker requests. When the account's 100,000 free Worker requests for the day are used, every app stops answering until 00:00 UTC.",
    });
  });

  it("a free daily limit other usage in the account is pushing near: the app's small share and the rest", () => {
    const item: UsageAttention = {
      kind: "limit-near",
      installId: "links",
      product: "d1_rows_written",
      limit: 100_000,
      runsOutAt: at(21, 40),
      appShare: 0.009,
      otherShare: 0.99,
    };
    expect(usageAttentionCopy(item, "Short links", clock).description).toBe(
      "Short links is getting under 1% of today's D1 rows written; 99% is other usage in this account (not Appflare apps). When the account's 100,000 free D1 rows written for the day are used, apps that need them fail until 00:00 UTC.",
    );
  });

  it("a free daily limit used up mostly by other usage in the account", () => {
    const item: UsageAttention = {
      kind: "limit-used-up",
      installId: "links",
      product: "d1_rows_written",
      limit: 100_000,
      appShare: 0.02,
      otherShare: 0.97,
      loopSince: null,
    };
    expect(usageAttentionCopy(item, "Short links", clock).description).toBe(
      "This account used its 100,000 free D1 rows written for today, 2% of them by Short links and 97% by other usage in this account (not Appflare apps). Cloudflare refuses more until 00:00 UTC, so apps that need them fail until then. The Free plan bills nothing; pausing stops it happening again tomorrow.",
    );
  });

  it("leaves out other usage under 1% of the account's", () => {
    const item: UsageAttention = {
      kind: "limit-near",
      installId: "links",
      product: "workers_requests",
      limit: 100_000,
      runsOutAt: at(21, 40),
      appShare: 0.64,
      otherShare: 0.004,
    };
    expect(usageAttentionCopy(item, "Short links", clock).description).toMatch(
      /^Short links is getting 64% of today's Worker requests\. When/,
    );
  });
});

describe("stillPastCapCopy", () => {
  const when = { clock, dayAndTime: (t: number) => `Mon ${clock(t)}` };

  it("says how far past the cap it is and when the cap resets", () => {
    expect(
      stillPastCapCopy(
        { amount: 2, period: "day", spent: 2.04, resetsAt: Date.UTC(2026, 9, 13) },
        when,
      ),
    ).toEqual({
      description: "It's still past its daily cap: $2.04 of $2.00.",
      body: "Resumed as it is, auto-pause would pause it again within 5 minutes. Resuming sets the cap aside until it resets at 00:00; the loop check keeps running.",
    });
  });

  it("names the day a weekly cap resets", () => {
    const copy = stillPastCapCopy(
      { amount: 10, period: "week", spent: null, resetsAt: Date.UTC(2026, 9, 19) },
      when,
    );
    expect(copy.description).toBe("It's still past its weekly cap: $10.00.");
    expect(copy.body).toContain("until it resets at Mon 00:00;");
  });
});

describe("listWords", () => {
  it("joins names as a sentence does", () => {
    expect(listWords([])).toBe("");
    expect(listWords(["Slack"])).toBe("Slack");
    expect(listWords(["Telegram", "Slack"])).toBe("Telegram and Slack");
    expect(listWords(["Telegram", "Slack", "Ops"])).toBe("Telegram, Slack and Ops");
  });
});

describe("spend protection in Needs attention", () => {
  const app = (id: string, label: string, status = "installed"): AttentionApp => ({
    id,
    label,
    status,
    version: "1.0.0",
    latestVersion: "1.0.0",
    updateAvailable: false,
    updateNeeds: null,
    healthStatus: "verified",
    healthAccess: false,
    healthCheckedAt: null,
  });
  const paused: UsageAttention = {
    kind: "paused",
    installId: "a",
    pausedAt: at(15, 0),
    pausedBy: null,
    cause: null,
    loopSince: null,
    stillPastCap: null,
  };
  const near: UsageAttention = {
    kind: "limit-near",
    installId: "c",
    product: "workers_requests",
    limit: 100_000,
    runsOutAt: at(21, 40),
    appShare: 0.5,
  };
  const usedUp: UsageAttention = {
    kind: "limit-used-up",
    installId: "d",
    product: "do_requests",
    limit: 100_000,
    appShare: 1,
    loopSince: null,
  };

  it("comes first, the most urgent kind first, and only for apps Home lists", () => {
    const items = attentionItems({
      isAdmin: true,
      apps: [app("a", "Alpha"), app("b", "Beta"), app("c", "Gamma"), app("d", "Delta")],
      failedJobs: [],
      accountRows: [],
      dismissedAccountRows: new Set(),
      deployCopy: null,
      downgrade: null,
      reconnectNeeded: true,
      usage: [near, paused, { ...UNUSUAL, installId: "b" }, usedUp, { ...near, installId: "gone" }],
    });
    expect(items.map((i) => i.key)).toEqual([
      "usage:unusual:b",
      "usage:limit-used-up:d",
      "usage:paused:a",
      "usage:limit-near:c",
      "connection",
    ]);
    expect(attentionBadge(items).count).toBe(5);
    // The sidebar's dots: red for unusual usage and a used-up limit, amber for
    // a pause, none for a limit that has not run out.
    expect(Object.fromEntries(appSignals(items))).toEqual({
      b: "unusual-usage",
      d: "limit-used-up",
      a: "paused",
    });
    const [first] = items;
    if (first === undefined) throw new Error("no row");
    expect(attentionCopy(first, clock)).toEqual({
      title: "Beta is using far more than usual",
      description: usageAttentionCopy({ ...UNUSUAL, installId: "b" }, "Beta", clock).description,
    });
  });
});
