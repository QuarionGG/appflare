import { describe, expect, it } from "vitest";
import { billedPrice, freeDailyLimit, PRODUCT_KEYS, PRODUCTS } from "./products";

describe("PRODUCTS", () => {
  it("covers every product with a label, a unit and a price", () => {
    expect(PRODUCT_KEYS).toHaveLength(29);
    for (const key of PRODUCT_KEYS) {
      const p = PRODUCTS[key];
      expect(p.label, key).toMatch(/^[A-Z0-9]/);
      // Sentence case: no Title Case Words after the product's own name.
      expect(p.label, key).not.toMatch(/ (Requests|Rows|Storage|Reads|Writes|Operations|Hours)\b/);
      expect(p.unit, key).not.toBe("");
      expect(p.price, key).toBeGreaterThan(0);
      expect(p.included.amount, key).toBeGreaterThan(0);
    }
  });

  it("marks storage as a level and everything else as a count", () => {
    const levels = PRODUCT_KEYS.filter((key) => PRODUCTS[key].measure === "level");
    expect(levels.sort()).toEqual([
      "d1_storage",
      "do_storage",
      "kv_storage",
      "r2_storage",
      "vectorize_stored_dimensions",
    ]);
  });

  it("keeps the published prices that differ from older figures", () => {
    // Durable Objects requests are $0.15 per million, not $0.23.
    expect(PRODUCTS.do_requests.price * 1e6).toBeCloseTo(0.15);
    // Workers AI includes 10,000 neurons a day on Paid, not a month.
    expect(PRODUCTS.ai_neurons.included).toEqual({ amount: 10_000, per: "day" });
    // Workflow steps: $0.80 per 100,000 past 500,000 a month; 3,000 a day on Free.
    expect(PRODUCTS.workflow_steps.price * 100_000).toBeCloseTo(0.8);
    expect(PRODUCTS.workflow_steps.included).toEqual({ amount: 500_000, per: "month" });
    expect(freeDailyLimit("workflow_steps")).toBe(3_000);
  });

  it("estimates Analytics Engine at $0 while Cloudflare does not bill it", () => {
    expect(billedPrice("analytics_engine_data_points")).toBe(0);
    expect(billedPrice("kv_writes")).toBe(PRODUCTS.kv_writes.price);
  });

  it("only R2 bills past its free amount on Workers Free", () => {
    const billedOnFree = PRODUCT_KEYS.filter((key) => PRODUCTS[key].billedOnFree);
    expect(billedOnFree.sort()).toEqual(["r2_class_a", "r2_class_b", "r2_storage"]);
  });
});

describe("freeDailyLimit", () => {
  it("is the per-day free limit of a count", () => {
    expect(freeDailyLimit("workers_requests")).toBe(100_000);
    expect(freeDailyLimit("kv_writes")).toBe(1_000);
    expect(freeDailyLimit("browser_hours")).toBeCloseTo(10 / 60);
  });

  it("is null for monthly free amounts, storage, and products Free lacks", () => {
    expect(freeDailyLimit("r2_class_a")).toBeNull();
    expect(freeDailyLimit("d1_storage")).toBeNull();
    expect(freeDailyLimit("workers_cpu_ms")).toBeNull();
    expect(freeDailyLimit("containers_memory")).toBeNull();
  });
});
