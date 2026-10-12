import { describe, expect, it } from "vitest";
import type { PauseView, UsageEvent, UsageStatus } from "../tab";
import { clock } from "../ui/format";
import { amount, eventCopy, plural, stateBanner, statusLine, updatedText, usedText } from "./copy";

/**
 * The Usage tab's words for each state, and each event as Recent activity
 * and the chart's markers say it. Times are in the reader's time zone, so
 * the expectations format them the same way.
 */

const NOW = Date.UTC(2026, 9, 12, 15, 30);
const at = (h: number, m: number) => Date.UTC(2026, 9, 12, h, m);
const ctx = { now: NOW, today: () => 4_200_000 };

const pause = (over: Partial<PauseView> = {}): PauseView => ({
  pausedAt: at(13, 0),
  by: null,
  cause: { reason: "cap", amount: 2, period: "day", spent: 2.31 },
  loopSince: null,
  stillPastCap: null,
  ...over,
});

describe("statusLine", () => {
  it("says each state in one sentence, with its tone", () => {
    const cases: [UsageStatus, string, string][] = [
      [
        { kind: "normal", requestsShare: 0.38 },
        "good",
        "Normal for this app. 38% of today's Worker requests in this account; limits and included usage are shared by every app.",
      ],
      [
        { kind: "busy", product: "workers_requests", perHour: 22_000, ratio: 25 },
        "warn",
        "Busier than usual: Worker requests at 22K an hour, 25× its normal. Not a loop.",
      ],
      [
        {
          kind: "runaway",
          product: "do_requests",
          perHour: 5_000_000,
          ratio: 3000,
          since: at(12, 50),
          burnPerHour: 1.15,
          spentToday: 3.4,
          freeShare: null,
          after: null,
        },
        "bad",
        `Far above normal: Durable Objects requests at 5M an hour since ${clock(at(12, 50))}, 3K× its normal. About $1.15 an hour.`,
      ],
      [
        {
          kind: "limit",
          product: "do_requests",
          limit: 100_000,
          loopSince: at(12, 50),
          appShare: 0.97,
        },
        "bad",
        `Durable Objects requests used up today's free limit after a loop from ${clock(at(12, 50))}. Requests fail until 00:00 UTC.`,
      ],
      [
        { kind: "paused", pause: pause(), product: "do_requests" },
        "muted",
        `Paused since ${clock(at(13, 0))}, so no usage since. It used 4.2M Durable Objects requests before that today.`,
      ],
      [
        { kind: "fresh", installedAt: NOW - 6 * 60_000 },
        "muted",
        "Installed 6 minutes ago. Cloudflare reports a new app's usage after about 15 minutes.",
      ],
      [
        { kind: "reconnect", via: "oauth" },
        "muted",
        "Appflare can't read this app's usage until Cloudflare is reconnected.",
      ],
    ];
    for (const [status, tone, text] of cases) {
      expect(statusLine(status, ctx), status.kind).toEqual({ tone, text });
    }
  });

  it("on Free, says the share of a free daily limit instead of dollars", () => {
    const line = statusLine(
      {
        kind: "runaway",
        product: "do_requests",
        perHour: 50_000,
        ratio: null,
        since: null,
        burnPerHour: 0,
        spentToday: 0,
        freeShare: 0.6,
        after: null,
      },
      ctx,
    );
    expect(line.text).toBe(
      "Far above normal: Durable Objects requests at 50K an hour. At this pace it uses 60% of today's free Durable Objects requests.",
    );
  });
});

describe("stateBanner", () => {
  it("names the real reason of a pause by Appflare, and what to do", () => {
    const cap = stateBanner({ kind: "paused", pause: pause(), product: null }, true);
    expect(cap).toMatchObject({
      variant: "alert",
      title: `Paused by Appflare at ${clock(at(13, 0))}`,
      action: "resume",
    });
    expect(cap?.description).toBe(
      'It passed its $2.00 daily cap. Visitors see a "paused" page; its data is untouched. Resume it when its cap resets, or change the cap below.',
    );
    const loop = stateBanner(
      {
        kind: "paused",
        pause: pause({
          cause: { reason: "loop", level: "standard", plan: "paid", burnPerHour: 3.2, times: 120 },
        }),
        product: null,
      },
      true,
    );
    expect(loop?.description).toContain("Its usage looked like a loop for 10 minutes");
    expect(loop?.description).toContain("Fix the cause first");
    const budget = stateBanner(
      {
        kind: "paused",
        pause: pause({ cause: { reason: "budget", budget: 50, projected: 66.45 } }),
        product: null,
      },
      true,
    );
    expect(budget?.description).toContain("past its $50.00 monthly budget");
    expect(budget?.description).toContain("exempt it from the budget below");
  });

  it("says who paused it by hand", () => {
    const manual = stateBanner(
      {
        kind: "paused",
        pause: pause({ by: "Ada Lovelace", cause: { reason: "manual" }, loopSince: at(12, 50) }),
        product: null,
      },
      false,
    );
    expect(manual).toEqual({
      variant: "alert",
      title: "Paused by Ada Lovelace",
      description: `Ada Lovelace paused it at ${clock(at(13, 0))} after unusual usage that began at ${clock(at(12, 50))}. Visitors see a "paused" page; its data is untouched.`,
      action: "resume",
    });
  });

  it("offers Pause when far above normal or past a free limit, nothing when calm", () => {
    const runaway = stateBanner(
      {
        kind: "runaway",
        product: "do_requests",
        perHour: 5_000_000,
        ratio: 3000,
        since: at(12, 50),
        burnPerHour: 1.15,
        spentToday: 3.4,
        freeShare: null,
        after: { kind: "update", version: "0.1.1" },
      },
      false,
    );
    expect(runaway).toEqual({
      variant: "error",
      title: `Far above normal since ${clock(at(12, 50))}`,
      description:
        "Durable Objects requests at 5M an hour. About $1.15 an hour at Cloudflare's prices, $3.40 today. It started right after the update to 0.1.1. Auto-pause is off for this app.",
      action: "pause",
    });
    const limit = stateBanner(
      { kind: "limit", product: "do_requests", limit: 100_000, loopSince: null, appShare: 0.97 },
      false,
    );
    expect(limit?.description).toBe(
      "This account used its 100,000 free Durable Objects requests for today, 97% of them by this app. Cloudflare refuses more until 00:00 UTC. Nothing is billed on the Free plan.",
    );
    expect(stateBanner({ kind: "normal", requestsShare: null }, true)).toBeNull();
    expect(
      stateBanner({ kind: "busy", product: "workers_requests", perHour: 1, ratio: 4 }, true)
        ?.action,
    ).toBeNull();
  });
});

describe("eventCopy", () => {
  const base = { id: "e", at: at(12, 0) };
  it("says each event in a label and a line", () => {
    const cases: [UsageEvent, string, string, boolean][] = [
      [
        { ...base, kind: "updated", version: "0.1.0", automatic: true },
        "Updated to 0.1.0",
        "Automatic update",
        false,
      ],
      [
        { ...base, kind: "app_settings", automatic: false, changes: [] },
        "Settings changed",
        "The app's settings, saved and deployed",
        false,
      ],
      [
        {
          ...base,
          kind: "app_settings",
          automatic: false,
          changes: ["Check interval set to 10", "API key changed"],
        },
        "Settings changed",
        "Check interval set to 10 and API key changed",
        false,
      ],
      [
        { ...base, kind: "unusual_started", product: "do_requests", times: 3000 },
        "Unusual usage",
        "Durable Objects requests at about 3,000× this app's normal.",
        true,
      ],
      [
        { ...base, kind: "alert_sent", sentence: "When it has spent $6.00 this month" },
        "Usage alert sent",
        "When it has spent $6.00 this month.",
        true,
      ],
      [
        { ...base, kind: "paused", by: null, cause: { reason: "cap", amount: 2, period: "day" } },
        "Paused automatically",
        "It passed its $2.00 daily cap.",
        true,
      ],
      [
        { ...base, kind: "resumed", by: "Ada Lovelace" },
        "Resumed by Ada Lovelace",
        "The loop check still runs.",
        false,
      ],
      [
        {
          ...base,
          kind: "settings_changed",
          by: "Ada Lovelace",
          changed: ["autoPause", "cap"],
          alert: null,
        },
        "Spend protection changed",
        "Pause automatically and spending cap, by Ada Lovelace.",
        false,
      ],
      [
        {
          ...base,
          kind: "settings_changed",
          by: "Ada Lovelace",
          changed: ["usageAlerts"],
          alert: { change: "added", sentence: "When it has spent $6.00 this month" },
        },
        "Usage alert added",
        "When it has spent $6.00 this month, by Ada Lovelace.",
        false,
      ],
      [
        { ...base, kind: "observability_changed", by: "Ada Lovelace", enabled: true },
        "Workers Logs turned on",
        "By Ada Lovelace.",
        false,
      ],
    ];
    for (const [event, label, description, alert] of cases) {
      expect(eventCopy(event), event.kind).toEqual({ label, description, alert });
    }
  });
});

describe("names and verbs", () => {
  const base = { id: "e", at: at(12, 0) };

  it("says where an unusual-usage alert went, for a viewer who may see the channels", () => {
    const event: UsageEvent = {
      ...base,
      kind: "unusual_started",
      product: "do_requests",
      times: 3000,
    };
    expect(eventCopy(event, ["Telegram", "Slack"]).description).toBe(
      "Durable Objects requests at about 3,000× this app's normal. Sent to Telegram and Slack.",
    );
    expect(eventCopy(event, null).description).toBe(
      "Durable Objects requests at about 3,000× this app's normal.",
    );
  });

  it("agrees the verb with the product's name", () => {
    expect(plural("kv_reads")).toBe(true);
    expect(plural("d1_rows_written")).toBe(true);
    expect(plural("do_duration")).toBe(false);
    expect(plural("workers_cpu_ms")).toBe(false);
    expect(
      stateBanner({ kind: "busy", product: "kv_reads", perHour: 1, ratio: 4 }, true)?.description,
    ).toMatch(/^KV reads have been well above/);
    expect(
      stateBanner({ kind: "busy", product: "do_duration", perHour: 1, ratio: 4 }, true)
        ?.description,
    ).toMatch(/^Durable Objects duration has been well above/);
    const limit = (product: string) =>
      eventCopy({ ...base, kind: "limit_near", product, share: 1, runsOutAt: null }).description;
    expect(limit("do_requests")).toBe("Today's free Durable Objects requests are used up.");
    expect(limit("do_duration")).toBe("Today's free Durable Objects duration is used up.");
  });
});

describe("amounts", () => {
  it("names the unit, and puts it before a name that lacks it", () => {
    expect(amount(48_200, "do_requests")).toBe("48.2K requests");
    expect(amount(3.42, "r2_storage")).toBe("3.4 GB");
    expect(usedText(4_200_000, "do_requests")).toBe("4.2M Durable Objects requests");
    expect(usedText(300, "do_duration")).toBe("300 GB-s of Durable Objects duration");
  });

  it("says how fresh the numbers are", () => {
    expect(updatedText(NOW - 50_000, NOW)).toBe("updated a minute ago");
    expect(updatedText(NOW - 12 * 60_000, NOW)).toBe("updated 12 minutes ago");
    expect(updatedText(NOW - 3 * 3_600_000, NOW)).toBe(`updated at ${clock(NOW - 3 * 3_600_000)}`);
  });
});
