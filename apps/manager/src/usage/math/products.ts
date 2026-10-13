/**
 * What Cloudflare bills a Workers app for, with the published list prices.
 *
 * Every number comes from the pricing page cited above its entry (checked
 * 2026-10-12). They feed estimates only: Cloudflare rounds some meters up to
 * the next billable unit, and its own Billable Usage is the real bill.
 *
 * Units match what the usage collector stores, so it converts where
 * Cloudflare's analytics use another unit (browser time in hours, container
 * memory and disk in GiB-seconds and GB-seconds rather than byte-seconds).
 */

export type ProductKey =
  | "workers_requests"
  | "workers_cpu_ms"
  | "do_requests"
  | "do_duration"
  | "do_rows_read"
  | "do_rows_written"
  | "do_storage"
  | "d1_rows_read"
  | "d1_rows_written"
  | "d1_storage"
  | "kv_reads"
  | "kv_writes"
  | "kv_deletes"
  | "kv_lists"
  | "kv_storage"
  | "r2_class_a"
  | "r2_class_b"
  | "r2_storage"
  | "queues_operations"
  | "ai_neurons"
  | "vectorize_queried_dimensions"
  | "vectorize_stored_dimensions"
  | "analytics_engine_data_points"
  | "browser_hours"
  | "containers_memory"
  | "containers_cpu"
  | "containers_disk"
  | "workers_logs_events";

/**
 * An amount of a product for a stretch of time. For a count, how many units
 * may be used per day or month; for a level, how much may be held (in
 * unit-months for a monthly allowance).
 */
export interface Allowance {
  amount: number;
  per: "day" | "month";
}

export interface Product {
  /** Sentence case, for tables and messages. */
  label: string;
  /** Plural noun for the unit, for "1.2M requests" or "3.4 GB". */
  unit: string;
  /**
   * `count`: hourly values are what was used in that hour and add up over
   * time. `level`: hourly values are how much was held during that hour
   * (storage); they never add up, and cost accrues per unit-month held.
   */
  measure: "count" | "level";
  /** What the Workers Paid plan includes before charging. */
  included: Allowance;
  /** Dollars per unit past `included` (per unit-month for a level). */
  price: number;
  /**
   * The Workers Free plan's limit, or null when Free has none (CPU time is
   * capped per invocation, not per day) or cannot use the product at all
   * (Containers). Daily limits reset at 00:00 UTC and Cloudflare refuses
   * further use past them, unless `billedOnFree`.
   */
  free: Allowance | null;
  /** Past the free amount, Cloudflare bills instead of refusing, on any plan (R2). */
  billedOnFree: boolean;
  /** False while Cloudflare publishes a price but does not charge it yet. */
  billed: boolean;
}

const M = 1_000_000;

const count = (p: Omit<Product, "measure" | "billedOnFree" | "billed">): Product => ({
  ...p,
  measure: "count",
  billedOnFree: false,
  billed: true,
});
const level = (p: Omit<Product, "measure" | "billedOnFree" | "billed">): Product => ({
  ...p,
  measure: "level",
  billedOnFree: false,
  billed: true,
});

export const PRODUCTS: Readonly<Record<ProductKey, Product>> = {
  // https://developers.cloudflare.com/workers/platform/pricing/#workers
  workers_requests: count({
    label: "Worker requests",
    unit: "requests",
    included: { amount: 10 * M, per: "month" },
    price: 0.3 / M,
    free: { amount: 100_000, per: "day" },
  }),
  workers_cpu_ms: count({
    label: "Worker CPU time",
    unit: "CPU ms",
    included: { amount: 30 * M, per: "month" },
    price: 0.02 / M,
    free: null,
  }),

  // https://developers.cloudflare.com/durable-objects/platform/pricing/
  do_requests: count({
    label: "Durable Objects requests",
    unit: "requests",
    included: { amount: 1 * M, per: "month" },
    price: 0.15 / M,
    free: { amount: 100_000, per: "day" },
  }),
  do_duration: count({
    label: "Durable Objects duration",
    unit: "GB-s",
    included: { amount: 400_000, per: "month" },
    price: 12.5 / M,
    free: { amount: 13_000, per: "day" },
  }),
  do_rows_read: count({
    label: "Durable Objects rows read",
    unit: "rows",
    included: { amount: 25_000 * M, per: "month" },
    price: 0.001 / M,
    free: { amount: 5 * M, per: "day" },
  }),
  do_rows_written: count({
    label: "Durable Objects rows written",
    unit: "rows",
    included: { amount: 50 * M, per: "month" },
    price: 1 / M,
    free: { amount: 100_000, per: "day" },
  }),
  do_storage: level({
    label: "Durable Objects storage",
    unit: "GB",
    included: { amount: 5, per: "month" },
    price: 0.2,
    free: { amount: 5, per: "month" },
  }),

  // https://developers.cloudflare.com/d1/platform/pricing/
  d1_rows_read: count({
    label: "D1 rows read",
    unit: "rows",
    included: { amount: 25_000 * M, per: "month" },
    price: 0.001 / M,
    free: { amount: 5 * M, per: "day" },
  }),
  d1_rows_written: count({
    label: "D1 rows written",
    unit: "rows",
    included: { amount: 50 * M, per: "month" },
    price: 1 / M,
    free: { amount: 100_000, per: "day" },
  }),
  d1_storage: level({
    label: "D1 storage",
    unit: "GB",
    included: { amount: 5, per: "month" },
    price: 0.75,
    free: { amount: 5, per: "month" },
  }),

  // https://developers.cloudflare.com/kv/platform/pricing/
  kv_reads: count({
    label: "KV reads",
    unit: "reads",
    included: { amount: 10 * M, per: "month" },
    price: 0.5 / M,
    free: { amount: 100_000, per: "day" },
  }),
  kv_writes: count({
    label: "KV writes",
    unit: "writes",
    included: { amount: 1 * M, per: "month" },
    price: 5 / M,
    free: { amount: 1_000, per: "day" },
  }),
  kv_deletes: count({
    label: "KV deletes",
    unit: "deletes",
    included: { amount: 1 * M, per: "month" },
    price: 5 / M,
    free: { amount: 1_000, per: "day" },
  }),
  kv_lists: count({
    label: "KV lists",
    unit: "lists",
    included: { amount: 1 * M, per: "month" },
    price: 5 / M,
    free: { amount: 1_000, per: "day" },
  }),
  kv_storage: level({
    label: "KV storage",
    unit: "GB",
    included: { amount: 1, per: "month" },
    price: 0.5,
    free: { amount: 1, per: "month" },
  }),

  // https://developers.cloudflare.com/r2/pricing/ (Standard storage class).
  // R2's free tier is monthly and the same on every plan; past it R2 bills,
  // also on Workers Free.
  r2_class_a: {
    ...count({
      label: "R2 class A operations",
      unit: "operations",
      included: { amount: 1 * M, per: "month" },
      price: 4.5 / M,
      free: { amount: 1 * M, per: "month" },
    }),
    billedOnFree: true,
  },
  r2_class_b: {
    ...count({
      label: "R2 class B operations",
      unit: "operations",
      included: { amount: 10 * M, per: "month" },
      price: 0.36 / M,
      free: { amount: 10 * M, per: "month" },
    }),
    billedOnFree: true,
  },
  r2_storage: {
    ...level({
      label: "R2 storage",
      unit: "GB",
      included: { amount: 10, per: "month" },
      price: 0.015,
      free: { amount: 10, per: "month" },
    }),
    billedOnFree: true,
  },

  // https://developers.cloudflare.com/queues/platform/pricing/
  queues_operations: count({
    label: "Queue operations",
    unit: "operations",
    included: { amount: 1 * M, per: "month" },
    price: 0.4 / M,
    free: { amount: 10_000, per: "day" },
  }),

  // https://developers.cloudflare.com/workers-ai/platform/pricing/
  // Paid includes 10,000 neurons a day, not a month.
  ai_neurons: count({
    label: "Workers AI neurons",
    unit: "neurons",
    included: { amount: 10_000, per: "day" },
    price: 0.011 / 1_000,
    free: { amount: 10_000, per: "day" },
  }),

  // https://developers.cloudflare.com/vectorize/platform/pricing/
  vectorize_queried_dimensions: count({
    label: "Vectorize queried dimensions",
    unit: "dimensions",
    included: { amount: 50 * M, per: "month" },
    price: 0.01 / M,
    free: { amount: 30 * M, per: "month" },
  }),
  vectorize_stored_dimensions: level({
    label: "Vectorize stored dimensions",
    unit: "dimensions",
    included: { amount: 10 * M, per: "month" },
    price: 0.05 / (100 * M),
    free: { amount: 5 * M, per: "month" },
  }),

  // https://developers.cloudflare.com/analytics/analytics-engine/pricing/
  // "Currently, you will not be billed": the price is announced, not charged.
  analytics_engine_data_points: {
    ...count({
      label: "Analytics Engine data points",
      unit: "data points",
      included: { amount: 10 * M, per: "month" },
      price: 0.25 / M,
      free: { amount: 100_000, per: "day" },
    }),
    billed: false,
  },

  // https://developers.cloudflare.com/browser-run/pricing/ (Browser Rendering
  // is now called Browser Run). Free: 10 minutes a day.
  browser_hours: count({
    label: "Browser Run hours",
    unit: "hours",
    included: { amount: 10, per: "month" },
    price: 0.09,
    free: { amount: 10 / 60, per: "day" },
  }),

  // https://developers.cloudflare.com/containers/platform/pricing/
  // Included: 25 GiB-hours, 375 vCPU-minutes and 200 GB-hours a month.
  containers_memory: count({
    label: "Container memory",
    unit: "GiB-s",
    included: { amount: 25 * 3_600, per: "month" },
    price: 0.0000025,
    free: null,
  }),
  containers_cpu: count({
    label: "Container CPU",
    unit: "vCPU-s",
    included: { amount: 375 * 60, per: "month" },
    price: 0.00002,
    free: null,
  }),
  containers_disk: count({
    label: "Container disk",
    unit: "GB-s",
    included: { amount: 200 * 3_600, per: "month" },
    price: 0.00000007,
    free: null,
  }),

  // https://developers.cloudflare.com/workers/observability/logs/workers-logs/#pricing
  // TODO: from 2026-12-01 Workers Logs moves to Cloudflare Observability
  // pricing (https://developers.cloudflare.com/observability/pricing/), billed
  // per GB ingested ($0.25/GB past 50 GB; Free 0.5 GB a day), not per event.
  // Events cannot be turned into GB without the log sizes, so this entry stays
  // on the per-event price until the collector reports ingested bytes.
  workers_logs_events: count({
    label: "Workers Logs events",
    unit: "events",
    included: { amount: 20 * M, per: "month" },
    price: 0.6 / M,
    free: { amount: 200_000, per: "day" },
  }),
};

export const PRODUCT_KEYS = Object.keys(PRODUCTS) as ProductKey[];

/** The Workers Paid plan's monthly price, part of every Paid bill. */
export const PAID_PLAN_MONTHLY_USD = 5;

/** The price to estimate with: zero while Cloudflare does not charge it. */
export function billedPrice(key: ProductKey): number {
  const p = PRODUCTS[key];
  return p.billed ? p.price : 0;
}

/** A product's daily free limit, or null when Free has none per day. */
export function freeDailyLimit(key: ProductKey): number | null {
  const free = PRODUCTS[key].free;
  return PRODUCTS[key].measure === "count" && free?.per === "day" ? free.amount : null;
}
