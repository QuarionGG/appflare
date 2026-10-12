import type { SpendApp, SpendOverview } from "../usage/overview";
import type { SpendProtectionData } from "../usage/spend-defaults.functions";
import { DEFAULT_SPEND_DEFAULTS, type SpendDefaults } from "../usage/store/spend-settings";

/**
 * Test-only: spend protection data as the server returns it, for the pages'
 * tests and the screenshot harness. Every app is calm unless told otherwise.
 */

const NOW = Date.UTC(2026, 9, 12, 15, 30);
const QUIET = { money: false, abnormal: false, trips: false };

export function spendApp(installId: string, label: string, over: Partial<SpendApp> = {}): SpendApp {
  return {
    installId,
    label,
    paused: false,
    autoPause: false,
    followsAccountTriggers: true,
    budgetExempt: false,
    capSetAsideUntil: null,
    burnPerHour: 0.02,
    ratio: 1.1,
    loop: { relaxed: QUIET, standard: QUIET, strict: QUIET },
    spend: {
      day: { spent: 0.1, projected: 0.2, resetsAt: Date.UTC(2026, 9, 13) },
      week: { spent: 0.5, projected: 0.9, resetsAt: Date.UTC(2026, 9, 19) },
      month: { spent: 1.2, projected: 2.6, resetsAt: Date.UTC(2026, 10, 1) },
    },
    overageUsd: 0,
    ...over,
  };
}

/** An app whose loop check trips at every level, spending fast. */
export function loopingApp(
  installId: string,
  label: string,
  over: Partial<SpendApp> = {},
): SpendApp {
  const trips = { money: true, abnormal: true, trips: true };
  return spendApp(installId, label, {
    burnPerHour: 3.2,
    ratio: 3000,
    loop: {
      relaxed: { money: false, abnormal: true, trips: false },
      standard: trips,
      strict: trips,
    },
    spend: {
      day: { spent: 4.85, projected: 31.2, resetsAt: Date.UTC(2026, 9, 13) },
      week: { spent: 5.4, projected: 120, resetsAt: Date.UTC(2026, 9, 19) },
      month: { spent: 12.4, projected: 61.8, resetsAt: Date.UTC(2026, 10, 1) },
    },
    overageUsd: 48.3,
    ...over,
  });
}

export function spendOverviewFixture(over: Partial<SpendOverview> = {}): SpendOverview {
  return {
    plan: "paid",
    now: NOW,
    computedAt: NOW - 120_000,
    missingScopes: [],
    bill: { now: 7.4, projected: 11.2 },
    budgetPick: null,
    apps: [spendApp("install-cut", "Short links"), spendApp("install-emdash", "Journal")],
    ...over,
  };
}

export function spendData(
  over: { defaults?: Partial<SpendDefaults>; overview?: Partial<SpendOverview> } = {},
): SpendProtectionData {
  return {
    defaults: { ...DEFAULT_SPEND_DEFAULTS, ...over.defaults },
    overview: spendOverviewFixture(over.overview),
  };
}
