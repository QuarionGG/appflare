import { isNotNull } from "drizzle-orm";
import { z } from "zod";
import { readAccountPlan } from "../account/plan.server";
import { createDb, type Database } from "../db/client";
import { app_usage_state } from "../db/schema";
import type { StillPastCap, UsageAttention } from "./attention";
import { parsePauseCause } from "./attention-cause";
import { stillPastCap } from "./cap-status";
import { DAY_MS, dayStart, freeDailyLimit, PRODUCTS, type ProductKey } from "./math";
import { listActivity } from "./store/activity.server";
import { effectiveSpendSettingsOf } from "./store/app-settings.server";
import { listOpenPauses } from "./store/pauses.server";
import type { EffectiveSpendSettings } from "./store/spend-settings";

/**
 * What Home's "Needs attention" shows of spend protection (see
 * `UsageAttention`), from what the spend watcher and the pause jobs record:
 * each install's usage state (an unusual-usage episode), the open pauses,
 * and the activity log (the episode's numbers, today's free daily limit
 * warnings). Server only. A handful of indexed reads, plus the plan, the
 * people who paused and the channels only when a row needs them.
 *
 * The watcher records the numbers a row shows in the activity's facts:
 * `unusual_started` with `product` (a product key), `perHour` (its use in
 * the last hour), `burnPerHour` and `spentToday` (dollars at list price) and,
 * on Free, `freeShare`; `limit_near` with `appShare` (the app's share of the
 * account's use of the product today). A row without them reads from the
 * usage state alone.
 */

const unusualFacts = z.object({
  times: z.number().nonnegative(),
  product: z.string().min(1).optional(),
  perHour: z.number().nonnegative().optional(),
  burnPerHour: z.number().nonnegative().optional(),
  spentToday: z.number().nonnegative().optional(),
  freeShare: z.number().nonnegative().optional(),
});

const limitFacts = z.object({
  product: z.string().min(1),
  /** How much of the free daily limit is used (1 once it is used up). */
  share: z.number().nonnegative(),
  runsOutAt: z.number().int().nullable(),
  appShare: z.number().min(0).max(1).optional(),
});

/** An unusual-usage activity this long before the state's start still belongs to its episode. */
const EPISODE_SLACK_MS = 10 * 60_000;

/** Episodes older than this are shown without the numbers their start recorded. */
const EPISODE_LOOKBACK_MS = 7 * DAY_MS;

function isProductKey(key: string): key is ProductKey {
  return Object.hasOwn(PRODUCTS, key);
}

async function readNames(d1: D1Database, ids: readonly string[]): Promise<Map<string, string>> {
  if (ids.length === 0) return new Map();
  const { results } = await d1
    .prepare("SELECT id, name FROM user WHERE id IN (SELECT value FROM json_each(?1))")
    .bind(JSON.stringify([...new Set(ids)]))
    .all<{ id: string; name: string | null }>();
  return new Map(results.map((r) => [r.id, r.name?.trim() || "Someone"]));
}

/** The labels of the channels that receive unusual-usage alerts, oldest first. */
async function unusualChannels(d1: D1Database): Promise<string[]> {
  const { results } = await d1
    .prepare("SELECT label, events_json FROM notification_channels ORDER BY created_at")
    .all<{ label: string; events_json: string }>();
  return results.flatMap((r) => {
    try {
      const events: unknown = JSON.parse(r.events_json);
      return Array.isArray(events) && events.includes("usage_unusual") ? [r.label] : [];
    } catch {
      return [];
    }
  });
}

/** An install in an unusual-usage episode, as its usage state records it. */
interface Episode {
  installId: string;
  unusualSince: number;
  lastBurn: number | null;
  normalBurn: number | null;
}

/**
 * The installs in an unusual-usage episode. The store reads states by
 * install; this asks for the few in an episode, so it needs no install ids
 * and runs beside the read of the installs.
 */
async function readEpisodes(db: Database): Promise<Map<string, Episode>> {
  const rows = await db
    .select({
      installId: app_usage_state.install_id,
      unusualSince: app_usage_state.unusual_since,
      lastBurn: app_usage_state.last_burn,
      normalBurn: app_usage_state.normal_burn,
    })
    .from(app_usage_state)
    .where(isNotNull(app_usage_state.unusual_since));
  return new Map(
    rows.flatMap((r) =>
      r.unusualSince === null
        ? []
        : [[r.installId, { ...r, unusualSince: r.unusualSince.getTime() }] as const],
    ),
  );
}

export async function readUsageAttention(
  d1: D1Database,
  opts: {
    /**
     * The installs Home lists (not uninstalled); a promise to read the rest
     * in the same round as the installs themselves.
     */
    installIds: readonly string[] | Promise<readonly string[]>;
    /** Admins see which channels an alert went to; members cannot see channels. */
    isAdmin: boolean;
    now: number;
  },
): Promise<UsageAttention[]> {
  const { now } = opts;
  const db = createDb(d1);
  const today = dayStart(now);
  // One round: the episodes, the open pauses, and the week's episode starts
  // and today's limit warnings. More only when a row needs it.
  const [installIds, pauses, states, activity] = await Promise.all([
    opts.installIds,
    listOpenPauses(db),
    readEpisodes(db),
    listActivity(db, {
      since: new Date(Math.min(today, now - EPISODE_LOOKBACK_MS)),
      kinds: ["unusual_started", "limit_near"],
      limit: 200,
    }),
  ]);
  const listed = new Set(installIds);
  const paused = new Map(
    pauses.filter((p) => listed.has(p.installId)).map((p) => [p.installId, p]),
  );
  const episodes = [...states.values()].filter((s) => listed.has(s.installId));

  const rows: UsageAttention[] = [];

  // Today's free daily limit warnings, the newest of each install.
  const limits = new Map<string, z.infer<typeof limitFacts>>();
  for (const entry of activity) {
    if (entry.kind !== "limit_near" || entry.installId === null || entry.at < today) continue;
    if (limits.has(entry.installId) || !listed.has(entry.installId)) continue;
    const facts = limitFacts.safeParse(entry.facts);
    if (facts.success) limits.set(entry.installId, facts.data);
  }
  const usedUp = new Set<string>();
  for (const [installId, facts] of limits) {
    if (paused.has(installId) || !isProductKey(facts.product)) continue;
    const limit = freeDailyLimit(facts.product);
    if (limit === null) continue;
    const appShare = facts.appShare ?? null;
    if (facts.share >= 1 || facts.runsOutAt === null || facts.runsOutAt <= now) {
      usedUp.add(installId);
      rows.push({
        kind: "limit-used-up",
        installId,
        product: facts.product,
        limit,
        appShare,
        loopSince: states.get(installId)?.unusualSince ?? null,
      });
    } else {
      rows.push({
        kind: "limit-near",
        installId,
        product: facts.product,
        limit,
        runsOutAt: facts.runsOutAt,
        appShare,
      });
    }
  }

  // Unusual usage of apps not paused, and not already told as a used-up limit.
  const unusual = episodes.filter((s) => !paused.has(s.installId) && !usedUp.has(s.installId));
  const open = [...paused.values()];
  const capped = open.filter((p) => p.reason === "cap").map((p) => p.installId);
  // A second round, only for the rows that need it: the plan and channels of
  // unusual usage, the people and cap settings of pauses.
  const [plan, sentTo, names, settings] = await Promise.all([
    unusual.length > 0 ? readAccountPlan(db) : Promise.resolve("free" as const),
    unusual.length > 0 && opts.isAdmin ? unusualChannels(d1) : Promise.resolve([]),
    readNames(
      d1,
      open.map((p) => p.pausedBy).filter((by) => by !== "auto"),
    ),
    capped.length > 0
      ? effectiveSpendSettingsOf(db, capped)
      : Promise.resolve(new Map<string, EffectiveSpendSettings>()),
  ]);
  for (const state of unusual) {
    const since = state.unusualSince;
    const started = activity.find(
      (a) =>
        a.kind === "unusual_started" &&
        a.installId === state.installId &&
        a.at >= since - EPISODE_SLACK_MS,
    );
    const facts =
      started === undefined ? null : (unusualFacts.safeParse(started.facts).data ?? null);
    const ratio =
      facts?.times ??
      (state.lastBurn !== null && state.normalBurn !== null && state.normalBurn > 0
        ? state.lastBurn / state.normalBurn
        : null);
    rows.push({
      kind: "unusual",
      installId: state.installId,
      plan,
      since,
      product: facts?.product !== undefined && facts.perHour !== undefined ? facts.product : null,
      perHour: facts?.product !== undefined ? (facts.perHour ?? null) : null,
      times: ratio !== null && ratio > 0 ? ratio : null,
      burnPerHour: facts?.burnPerHour ?? state.lastBurn,
      spentToday: facts?.spentToday ?? null,
      freeShare: facts?.freeShare ?? null,
      sentTo,
    });
  }

  // Paused apps: who paused them and why; whether Resume must deal with the cap.
  for (const pause of open) {
    const cause = parsePauseCause(pause.reason, pause.detailJson);
    const effective = settings.get(pause.installId);
    const pastCap: StillPastCap | null =
      effective === undefined
        ? null
        : stillPastCap({ pausedAt: pause.pausedAt, cause }, effective, now);
    rows.push({
      kind: "paused",
      installId: pause.installId,
      pausedAt: pause.pausedAt,
      pausedBy: pause.pausedBy === "auto" ? null : (names.get(pause.pausedBy) ?? "Someone"),
      cause,
      loopSince: states.get(pause.installId)?.unusualSince ?? null,
      stillPastCap: pastCap,
    });
  }
  return rows;
}
