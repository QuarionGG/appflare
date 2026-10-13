import { describe, expect, it } from "vitest";
import {
  count,
  fullCount,
  labelAfter,
  percent,
  productLabel,
  productRate,
  times,
  usd,
  utcClock,
  utcDateTime,
  withUnit,
} from "./attention-format";

describe("units after a number", () => {
  it("are singular after 1, plural otherwise, and measures stay as they are", () => {
    expect(withUnit("1", "requests")).toBe("1 request");
    expect(withUnit("48K", "requests")).toBe("48K requests");
    expect(withUnit("0", "rows")).toBe("0 rows");
    expect(withUnit("1", "data points")).toBe("1 data point");
    expect(withUnit("1", "GB-s")).toBe("1 GB-s");
    expect(withUnit("1", "CPU ms")).toBe("1 CPU ms");
  });

  it("make a product's name singular after 1 when it ends in its unit", () => {
    expect(labelAfter("1", "Durable Objects requests", "requests")).toBe("Durable Objects request");
    expect(labelAfter("2", "Durable Objects requests", "requests")).toBe(
      "Durable Objects requests",
    );
  });

  it("read in a rate", () => {
    expect(productRate("workflow_steps", 1)).toBe("Workflow steps at 1 an hour");
    expect(productRate("d1_rows_read", 1)).toBe("D1 rows read at 1 row an hour");
  });
});

describe("spend protection's numbers", () => {
  it("writes counts short, and limits in full", () => {
    expect(count(640.4)).toBe("640");
    expect(count(48_200)).toBe("48.2K");
    expect(count(2_400_000)).toBe("2.4M");
    expect(fullCount(100_000)).toBe("100,000");
  });

  it("writes dollars with cents below $100, and a cent's fraction in words", () => {
    expect(usd(3.2)).toBe("$3.20");
    expect(usd(0)).toBe("$0.00");
    expect(usd(0.004)).toBe("under $0.01");
    expect(usd(140.4)).toBe("$140");
  });

  it("writes shares and how many times normal", () => {
    expect(percent(0.4)).toBe("40%");
    expect(percent(0.004)).toBe("under 1%");
    expect(percent(1.3)).toBe("130%");
    expect(times(3.46)).toBe("3.5×");
    expect(times(120)).toBe("120×");
    expect(times(3000)).toBe("3,000×");
  });

  it("writes times in UTC, for messages read anywhere", () => {
    expect(utcClock(Date.UTC(2026, 9, 12, 9, 5))).toBe("09:05 UTC");
    expect(utcDateTime(Date.UTC(2026, 9, 13))).toBe("Oct 13, 00:00 UTC");
  });

  it("names products, with the unit when the name lacks it", () => {
    expect(productRate("do_requests", 48_200)).toBe("Durable Objects requests at 48.2K an hour");
    expect(productRate("d1_rows_read", 5_000_000)).toBe("D1 rows read at 5M rows an hour");
    expect(productLabel("not_a_product")).toBe("not_a_product");
  });
});
