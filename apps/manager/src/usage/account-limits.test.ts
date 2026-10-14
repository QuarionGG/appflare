import { describe, expect, it } from "vitest";
import {
  type AccountLimitNear,
  accountLimitDecisions,
  accountLimitsNear,
  accountLimitWords,
} from "./account-limits";
import { HOUR_MS, type Usage } from "./math";
import { NOW } from "./math/test-series";

/** One point of today (NOW is 12:30 UTC): `value` used in the hour before NOW. */
const today = (value: number) => [{ hour: NOW - HOUR_MS, value }];

describe("accountLimitsNear", () => {
  const usage = new Map<string, Usage>([
    ["links", { d1_rows_written: today(600), workers_requests: today(40_000) }],
    ["notes", { d1_rows_written: today(300) }],
    ["gone", { d1_rows_written: today(5_000) }],
  ]);
  const near = (accountToday: Record<string, number>) =>
    accountLimitsNear({ now: NOW, accountToday, usage, listed: new Set(["links", "notes"]) });

  it("finds the limits the whole account used 90% of, with who used them", () => {
    expect(near({ d1_rows_written: 95_000, workers_requests: 50_000, kv_writes: 0 })).toEqual([
      {
        product: "d1_rows_written",
        limit: 100_000,
        used: 95_000,
        share: 0.95,
        // Appflare's apps used 5,900 (a removed one included).
        otherShare: (95_000 - 5_900) / 95_000,
        // Only an app Home lists is named: the removed one used more.
        top: { installId: "links", share: 600 / 95_000 },
      },
    ]);
  });

  it("is quiet under 90%, and without a reading of the product", () => {
    expect(near({ d1_rows_written: 89_999 })).toEqual([]);
    expect(near({})).toEqual([]);
  });

  it("takes Appflare's own use when the reading is behind it", () => {
    const [limit] = accountLimitsNear({
      now: NOW,
      accountToday: { workers_requests: 10 },
      usage: new Map([["links", { workers_requests: today(95_000) }]]),
      listed: new Set(["links"]),
    });
    expect(limit).toMatchObject({ used: 95_000, otherShare: 0, top: { share: 1 } });
  });
});

describe("accountLimitDecisions: one message per product per UTC day", () => {
  const limit = (share: number, product = "d1_rows_written"): AccountLimitNear => ({
    product: product as AccountLimitNear["product"],
    limit: 100_000,
    used: share * 100_000,
    share,
    otherShare: 0.9,
    top: null,
  });
  const none = { accountShares: new Map<string, number>(), appWarned: new Set<string>() };

  it("warns the first time, with a message, and owns the product for the day", () => {
    const d = accountLimitDecisions([limit(0.92)], none);
    expect(d.records).toEqual([{ near: limit(0.92), message: true, appFirst: false }]);
    expect([...d.covered]).toEqual(["d1_rows_written"]);
  });

  it("does not warn again the same day, and still owns the product", () => {
    const d = accountLimitDecisions([limit(0.95)], {
      ...none,
      accountShares: new Map([["d1_rows_written", 0.92]]),
    });
    expect(d.records).toEqual([]);
    expect([...d.covered]).toEqual(["d1_rows_written"]);
  });

  it("records once more, without a message, when the limit runs out", () => {
    const d = accountLimitDecisions([limit(1.01)], {
      ...none,
      accountShares: new Map([["d1_rows_written", 0.92]]),
    });
    expect(d.records).toEqual([{ near: limit(1.01), message: false, appFirst: false }]);
    const again = accountLimitDecisions([limit(1.02)], {
      ...none,
      accountShares: new Map([["d1_rows_written", 1.01]]),
    });
    expect(again.records).toEqual([]);
  });

  it("still warns about a product an app was warned about first, marked to skip the app's channels", () => {
    const d = accountLimitDecisions([limit(0.95), limit(0.93, "kv_writes")], {
      ...none,
      appWarned: new Set(["d1_rows_written"]),
    });
    expect(d.records.map((r) => [r.near.product, r.appFirst])).toEqual([
      ["d1_rows_written", true],
      ["kv_writes", false],
    ]);
    expect([...d.covered].sort()).toEqual(["d1_rows_written", "kv_writes"]);
  });

  it("knows the products warned about earlier today without a reading now", () => {
    const d = accountLimitDecisions([], {
      ...none,
      accountShares: new Map([["kv_writes", 0.95]]),
    });
    expect(d.records).toEqual([]);
    expect([...d.covered]).toEqual(["kv_writes"]);
  });
});

describe("accountLimitWords", () => {
  const base = { product: "d1_rows_written", limit: 100_000, used: 90_329, share: 0.90329 };

  it("mostly other usage in this account", () => {
    expect(
      accountLimitWords({ ...base, otherShare: 0.99, top: { label: "Links", share: 0.01 } }),
    ).toEqual({
      title: "This account is near today's free D1 rows written limit",
      description:
        "This account has used 90% of today's free D1 rows written (90.3K of 100K), mostly other usage in this account. Cloudflare stops D1 for the whole account when it runs out, until 00:00 UTC.",
    });
  });

  it("mostly one Appflare app, named", () => {
    expect(
      accountLimitWords({ ...base, otherShare: 0.1, top: { label: "OpenSEO", share: 0.8 } })
        .description,
    ).toContain("(90.3K of 100K), mostly OpenSEO.");
  });

  it("mostly Appflare's apps, none of them most of it", () => {
    expect(
      accountLimitWords({ ...base, otherShare: 0.2, top: { label: "OpenSEO", share: 0.3 } })
        .description,
    ).toContain("mostly Appflare's apps, OpenSEO the most.");
    expect(accountLimitWords({ ...base, otherShare: 0.2, top: null }).description).toContain(
      "mostly Appflare's apps.",
    );
  });

  it("used up, naming what stops", () => {
    expect(
      accountLimitWords({
        product: "workers_requests",
        limit: 100_000,
        used: 100_200,
        share: 1.002,
        otherShare: 0.7,
        top: null,
      }),
    ).toEqual({
      title: "This account used up today's free Worker requests",
      description:
        "This account used all of today's free Worker requests (100K of 100K), mostly other usage in this account. Cloudflare stops Workers for the whole account until 00:00 UTC, Appflare's apps included.",
    });
  });
});
