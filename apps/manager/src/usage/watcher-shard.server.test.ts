import { describe, expect, it } from "vitest";
import { DAY_MS, type Usage } from "./math";
import { hourly, NOW } from "./math/test-series";
import { spendSnapshot } from "./overview.server";
import { appNumbers, mergeSnapshot, partsToRun } from "./watcher-shard.server";

describe("partsToRun", () => {
  it("runs every part when they fit", () => {
    expect(partsToRun(3, 10, NOW)).toEqual([0, 1, 2]);
  });

  it("runs a window that moves on by itself each check, so every part gets its turn", () => {
    const tick = 5 * 60_000;
    const seen = new Set<number>();
    for (let i = 0; i < 4; i++) for (const p of partsToRun(5, 2, NOW + i * tick)) seen.add(p);
    expect(seen).toEqual(new Set([0, 1, 2, 3, 4]));
    expect(partsToRun(5, 2, NOW)).toHaveLength(2);
    expect(partsToRun(5, 0, NOW)).toEqual([]);
  });
});

describe("the parts' numbers", () => {
  const usage = (scale: number): Usage => ({
    workers_requests: hourly(20 * 24, (ago) => scale * (ago < 2 ? 40_000 : 3_000)),
    do_rows_written: hourly(20 * 24, scale * 2e6),
    r2_class_a: hourly(20 * 24, scale * 9e4),
  });

  it("are spendSnapshot's, the account's share of the overage filled in after", () => {
    for (const plan of ["free", "paid"] as const) {
      const all = new Map([
        ["a", usage(1)],
        ["b", usage(3)],
        ["gone", usage(2)],
      ]);
      const installs = [
        { installId: "a", installedAt: NOW - 30 * DAY_MS },
        { installId: "b", installedAt: NOW - 2 * DAY_MS },
      ];
      const paused = new Set(["b"]);
      const whole = spendSnapshot({ plan, now: NOW, usage: all, installs, paused });
      const merged = mergeSnapshot({
        plan,
        now: NOW,
        sums: all,
        paused,
        apps: installs.map((i) =>
          appNumbers(plan, NOW, all.get(i.installId) ?? {}, i.installedAt, i.installId),
        ),
      });
      expect(merged).toEqual(whole);
    }
  });
});
