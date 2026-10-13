import { PRODUCTS, type ProductKey } from "./math";

/**
 * Numbers and words for what spend protection tells people: notification
 * messages and Home's "Needs attention" rows. Fixed to English formatting so
 * a message reads the same in every channel. Client-safe and server-safe.
 */

const compact = new Intl.NumberFormat("en", { notation: "compact", maximumFractionDigits: 1 });
const whole = new Intl.NumberFormat("en", { maximumFractionDigits: 0 });

/** A count: "640", "48K", "1.2M". */
export function count(value: number): string {
  return value < 1000 ? whole.format(Math.round(value)) : compact.format(value);
}

/** The units that are plural nouns, and their singular. Measures ("GB-s", "CPU ms") stay as they are. */
const SINGULAR: Readonly<Record<string, string>> = {
  requests: "request",
  rows: "row",
  reads: "read",
  writes: "write",
  deletes: "delete",
  lists: "list",
  operations: "operation",
  steps: "step",
  neurons: "neuron",
  dimensions: "dimension",
  "data points": "data point",
  hours: "hour",
  events: "event",
  times: "time",
};

/** `unit` as it reads after `shown` (a number as shown): singular after "1". */
export function unitAfter(shown: string, unit: string): string {
  return shown === "1" ? (SINGULAR[unit] ?? unit) : unit;
}

/** A number as shown with its unit: "1 request", "48K requests", "1 GB-s". */
export function withUnit(shown: string, unit: string): string {
  return `${shown} ${unitAfter(shown, unit)}`;
}

/**
 * A product's name after a number, when the name ends in its unit:
 * "1 Durable Objects request", "4.2M Durable Objects requests".
 */
export function labelAfter(shown: string, label: string, unit: string): string {
  if (shown !== "1" || !label.endsWith(unit)) return label;
  return `${label.slice(0, label.length - unit.length)}${unitAfter(shown, unit)}`;
}

/** A count in full, for a limit people may look up: "100,000". */
export function fullCount(value: number): string {
  return whole.format(value);
}

/** Dollars: "$3.20", "$140", or "under $0.01" for a cent's fraction. */
export function usd(value: number): string {
  if (value > 0 && value < 0.01) return "under $0.01";
  return value.toLocaleString("en", {
    style: "currency",
    currency: "USD",
    minimumFractionDigits: value >= 100 ? 0 : 2,
    maximumFractionDigits: value >= 100 ? 0 : 2,
  });
}

/** A share (0.42) as a percent: "42%", or "under 1%". */
export function percent(share: number): string {
  return share > 0 && share < 0.01 ? "under 1%" : `${whole.format(share * 100)}%`;
}

/** How many times its normal: "3.5×", "120×", "3,000×". */
export function times(ratio: number): string {
  return ratio < 10 ? `${Math.round(ratio * 10) / 10}×` : `${whole.format(Math.round(ratio))}×`;
}

/** An instant as a UTC clock time, for messages read in any time zone: "14:05 UTC". */
export function utcClock(epochMs: number): string {
  return `${new Date(epochMs).toISOString().slice(11, 16)} UTC`;
}

/** An instant as a UTC date and time: "Oct 12, 14:05 UTC". */
export function utcDateTime(epochMs: number): string {
  const day = new Date(epochMs).toLocaleDateString("en", {
    month: "short",
    day: "numeric",
    timeZone: "UTC",
  });
  return `${day}, ${utcClock(epochMs)}`;
}

/** What a product is called in a sentence; a key this version does not know reads as itself. */
export function productLabel(key: string): string {
  return Object.hasOwn(PRODUCTS, key) ? PRODUCTS[key as ProductKey].label : key;
}

/**
 * A product's use in an hour: "Durable Objects requests at 48.2K an hour",
 * with the unit when the name does not end in it ("D1 rows read at 5M rows
 * an hour").
 */
export function productRate(key: string, perHour: number): string {
  const label = productLabel(key);
  const unit = Object.hasOwn(PRODUCTS, key) ? PRODUCTS[key as ProductKey].unit : "";
  const shown = count(perHour);
  const after = unit === "" || label.endsWith(unit) ? "" : ` ${unitAfter(shown, unit)}`;
  return `${label} at ${shown}${after} an hour`;
}

export const PERIOD_NOUN = { day: "today", week: "this week", month: "this month" } as const;
export const PERIOD_ADJECTIVE = { day: "daily", week: "weekly", month: "monthly" } as const;
