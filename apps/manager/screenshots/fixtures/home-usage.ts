import type { HomeUsageApp, HomeUsageData, HomeUsageSeries } from "../../src/usage/home";
import type { ProductKey } from "../../src/usage/math";

/**
 * Home's usage for the pictures: six apps with a daily rhythm, hour by hour
 * as the spend watcher's history keeps them, calm on Workers Paid; or, with
 * the variant that names Home's spend protection rows, Service status in an
 * alarm loop (`usage-runaway`), the same loop using up the Free plan's
 * Durable Objects requests (`usage-capped`), Short links gone viral on Free
 * (`usage-limit`), Service status paused after its loop (`usage-paused`),
 * Contact forms installed 6 minutes ago (`usage-fresh`), and a connection
 * without the usage permissions (`usage-reconnect`). Times are relative to
 * when the page loads.
 */

const HOUR = 3_600_000;
const DAY = 24 * HOUR;
const PAST_HOURS = 6 * 24;

/** Hourly use per app before the time of day bends it. */
const BASE: Record<string, Partial<Record<ProductKey, number>>> = {
  "install-cloudmark": { workers_requests: 120, d1_rows_read: 4_000, d1_rows_written: 40 },
  "install-formzero": { workers_requests: 30, d1_rows_read: 200, d1_rows_written: 5 },
  "install-r2-explorer": { workers_requests: 60, r2_class_a: 20 },
  "install-emdash": { workers_requests: 400, d1_rows_read: 30_000, kv_reads: 300 },
  "install-statusbeam": { workers_requests: 250, do_requests: 1_440, d1_rows_written: 120 },
  "install-cut": { workers_requests: 900, kv_reads: 900, kv_writes: 2 },
};

function seeded(seed: number) {
  let s = seed;
  return () => {
    s = (s * 1664525 + 1013904223) % 4294967296;
    return s / 4294967296;
  };
}

/** Busiest mid-afternoon UTC, quietest at night. */
const rhythm = (hourOfDay: number) => 0.55 + 0.45 * Math.sin(((hourOfDay - 9) / 24) * 2 * Math.PI);

export function homeUsageFixture(variant: string | null): HomeUsageData {
  const now = Date.now();
  const today = Math.floor(now / DAY) * DAY;
  const windowStart = today - 6 * DAY;
  const month = Date.UTC(new Date(now).getUTCFullYear(), new Date(now).getUTCMonth(), 1);
  const hourCount = Math.floor((now - today) / HOUR) + 1;
  const plan =
    variant === "usage-capped" || variant === "usage-limit" ? ("free" as const) : ("paid" as const);

  const series: HomeUsageSeries[] = [];
  const account: HomeUsageData["account"] = {};
  Object.entries(BASE).forEach(([installId, products], appIndex) => {
    for (const [product, base] of Object.entries(products) as [ProductKey, number][]) {
      if (installId === "install-formzero" && variant === "usage-fresh") continue;
      const rand = seeded(appIndex * 97 + product.length * 13 + 7);
      const loop = installId === "install-statusbeam" && product === "do_requests";
      const viral =
        installId === "install-cut" &&
        variant === "usage-limit" &&
        (product === "workers_requests" || product === "kv_reads");
      // Every hour from the window's start up to the one still running.
      const timeline = Array.from({ length: PAST_HOURS + hourCount }, (_, k) => {
        const at = windowStart + k * HOUR;
        const ago = (now - at) / HOUR;
        let value = base * rhythm(new Date(at).getUTCHours()) * (0.8 + rand() * 0.4);
        if (loop && variant === "usage-runaway" && ago < 2.7) value = 4_400_000;
        if (installId === "install-statusbeam" && variant === "usage-paused") {
          if (loop && ago < 5.2 && ago > 2.8) value = 4_400_000;
          // Paused: the stand-in answers with 503 and touches nothing else.
          if (ago <= 2.8) value = product === "workers_requests" ? 0.3 : 0;
        }
        if (loop && variant === "usage-capped" && ago < 2.7) value = 60_000;
        if (viral && ago < 10) value *= 6;
        // The running hour holds only what its minutes so far used.
        return value * Math.min(1, ago);
      });
      const past = timeline.slice(0, PAST_HOURS);
      const hours = timeline.slice(PAST_HOURS);
      if (variant === "usage-capped" && product === "do_requests") {
        // Cloudflare refuses Durable Object requests past the Free plan's
        // 100,000 a day: the loop used them up, and nothing more counts.
        let room = 100_000;
        for (let h = 0; h < hours.length; h++) {
          const used = Math.min(hours[h] ?? 0, room);
          hours[h] = used;
          room -= used;
        }
      }
      const ratio =
        loop && (variant === "usage-runaway" || variant === "usage-capped") ? 3000 : viral ? 6 : 1;
      series.push({ installId, product, past, hours, ratio });
      const today = hours.reduce((t, v) => t + v, 0);
      const pastThisMonth = past
        .filter((_, i) => windowStart + i * HOUR >= month)
        .reduce((t, v) => t + v, 0);
      const before = Math.max(0, (windowStart - month) / DAY) * base * 24;
      const use = account[product] ?? { today: 0, month: 0 };
      use.today += today;
      use.month += today + pastThisMonth + before;
      account[product] = use;
    }
  });

  const runaway = variant === "usage-runaway";
  const apps: HomeUsageApp[] = Object.keys(BASE).map((installId, i) => ({
    installId,
    installedAt:
      installId === "install-formzero" && variant === "usage-fresh"
        ? now - 6 * 60_000
        : now - (24 + i * 3) * DAY,
    paused: installId === "install-statusbeam" && variant === "usage-paused",
    burnPerHour: installId === "install-statusbeam" && runaway ? 0.66 : 0.002 + (i % 3) * 0.004,
    ratio: installId === "install-statusbeam" && runaway ? 3000 : 1.1,
  }));
  return {
    plan,
    now,
    needsAccess: variant === "usage-reconnect" ? { via: "oauth" } : null,
    bill:
      plan === "free"
        ? { now: 0, projected: 0 }
        : runaway
          ? { now: 7.85, projected: 66.45 }
          : variant === "usage-paused"
            ? { now: 8.2, projected: 9.4 }
            : { now: 5.4, projected: 6.1 },
    apps,
    windowStart,
    grain: "hour",
    series,
    account,
  };
}
