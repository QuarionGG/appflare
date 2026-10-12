import { type AccountPlan, accountPlanSchema } from "../account/plan";
import { readAccountPlan } from "../account/plan.server";
import { createDb } from "../db/client";
import { installJobAppNameSql } from "../installs/install-names.server";
import type { PauseCause } from "../usage/attention-cause";
import { dayStart, freeDailyLimit, type Period, type ProductKey } from "../usage/math";
import { appRefOf, type InstallRow, readMessageLabels } from "./events.server";
import type { NotificationFacts } from "./messages";
import { type EmitInput, emitEvent, readChannels, wants } from "./outbox.server";
import type { NotificationEvent } from "./schema";
import { selfNotificationUnits } from "./units";

/**
 * Spend protection's notifications, emitted by the spend watcher and by the
 * pause and resume jobs as things happen, and sent at once like a job's end:
 * the event and its deliveries are recorded in the outbox, then the delivery
 * unit is asked over `SELF` to send them (one subrequest for the caller).
 * What it could not send, and everything on a manager without `SELF`, is
 * sent by the scheduled run.
 *
 * Each event happens once, by its dedupe key: an unusual-usage episode by
 * when it began, a usage alert per rule and period, a free daily limit per
 * app and UTC day, the monthly budget per month, a pause and its resume per
 * pause. Emitting the same event again is a no-op, so a retried step or an
 * overlapping check never sends twice.
 *
 * Callers pass ids and numbers; this module names the app as messages do and
 * the people by their names. Notifications never fail the caller: an error
 * is logged and returned.
 */

interface Base {
  /** When it happened (epoch ms); now by default. */
  at?: number;
}

/** The account's plan, when the caller knows it; read from settings otherwise. */
interface WithPlan {
  plan?: AccountPlan;
}

export type UsageEvent =
  | (Base &
      WithPlan & {
        type: "usage_unusual";
        installId: string;
        /** When the episode began (epoch ms): one message per episode. */
        since: number;
        product: ProductKey;
        perHour: number;
        times: number;
        factor: number;
        burnPerHour: number;
        spentToday: number;
        freeShare?: number | null;
      })
  | (Base &
      WithPlan & {
        type: "usage_alert";
        installId: string;
        ruleId: string;
        sentence: string;
        kind: "spent" | "pace";
        unit: "usd" | "pct";
        amount: number;
        value: number;
        period: Period;
        /** The unix second the rule's period began: one message per rule and period. */
        periodStart: number;
      })
  | (Base & {
      type: "usage_limit_near";
      installId: string;
      /** A product with a free daily limit. */
      product: ProductKey;
      used: number;
      /** Epoch ms; null once it has run out. */
      runsOutAt: number | null;
      appShare: number;
    })
  | (Base & {
      type: "app_paused";
      installId: string;
      pauseId: string;
      /** `auto` (a trigger), or the user id of who paused it, as the pause records it. */
      pausedBy: string;
      cause: PauseCause;
    })
  | (Base & {
      type: "app_resumed";
      installId: string;
      pauseId: string;
      /** Who paused it, as the pause records it (`auto` or a user id). */
      pausedBy: string;
      /** The user id of who resumed it; null when Appflare resumed it on its own. */
      resumedBy: string | null;
      capSetAsideUntil: number | null;
    })
  | (Base & {
      type: "budget_reached";
      budget: number;
      projected: number;
      /** The unix second the month began: one message per month. */
      monthStart: number;
    });

export interface UsageEventEnv {
  DB: D1Database;
  /** The manager's own service binding, for sending at once. */
  SELF?: unknown;
}

export interface UsageEventDeps {
  now?: () => number;
}

export type UsageEventOutcome =
  | {
      /** Recorded (or already recorded) and asked to be sent. */
      status: "queued";
      eventId: string;
      /** New deliveries; 0 when the event was already recorded for every channel. */
      queued: number;
      /** What the delivery unit did now; null when it was left to the scheduled run. */
      delivered: { sent: number; retrying: number; failed: number } | null;
    }
  | {
      /**
       * Nothing to send: no channel wants it, the install is gone, or it is
       * not news (someone resumed their own pause).
       */
      status: "skipped";
      reason: "no-channel" | "no-install" | "own-resume" | "no-free-limit";
    }
  | { status: "error"; error: string };

const PAUSED_BY_TRIGGER = "auto";

/** The dedupe key of an event: what makes it happen once. */
export function usageEventKey(event: UsageEvent, at: number): string {
  switch (event.type) {
    case "usage_unusual":
      return `usage_unusual:${event.installId}:${event.since}`;
    case "usage_alert":
      return `usage_alert:${event.ruleId}:${event.periodStart}`;
    case "usage_limit_near":
      return `usage_limit_near:${event.installId}:${dayStart(at) / 1000}`;
    case "app_paused":
      return `app_paused:${event.pauseId}`;
    case "app_resumed":
      return `app_resumed:${event.pauseId}`;
    case "budget_reached":
      return `budget_reached:${event.monthStart}`;
  }
}

/**
 * Whether a resume is news: Appflare resumed it on its own, or someone
 * other than whoever paused it did. Someone resuming their own pause knows.
 */
export function resumeIsNews(pausedBy: string, resumedBy: string | null): boolean {
  return resumedBy === null || resumedBy !== pausedBy;
}

async function readInstallRow(db: D1Database, installId: string): Promise<InstallRow | null> {
  return db
    .prepare(
      `SELECT i.id, i.app_slug, i.worker_name, i.display_name, i.catalog_version, i.manifest_json,
              CASE WHEN i.manifest_json IS NULL THEN ${installJobAppNameSql("i")} END AS app_name
       FROM installs i WHERE i.id = ?1`,
    )
    .bind(installId)
    .first<InstallRow>();
}

/**
 * A person's name for a message, by user id: null for Appflare (no id, or
 * `auto`), "Someone" for a user that is gone or has no name.
 */
async function personName(db: D1Database, by: string | null): Promise<string | null> {
  if (by === null || by === PAUSED_BY_TRIGGER) return null;
  const row = await db
    .prepare("SELECT name FROM user WHERE id = ?1")
    .bind(by)
    .first<{ name: string | null }>();
  const name = row?.name?.trim();
  return name === undefined || name === "" ? "Someone" : name;
}

async function planOf(db: D1Database, given: AccountPlan | undefined): Promise<AccountPlan> {
  return given === undefined ? readAccountPlan(createDb(db)) : accountPlanSchema.parse(given);
}

/** The event's facts, or the reason it is not news. */
async function factsOf(
  db: D1Database,
  event: UsageEvent,
  at: number,
): Promise<NotificationFacts | Extract<UsageEventOutcome, { status: "skipped" }>> {
  if (event.type === "budget_reached") {
    return {
      type: "budget_reached",
      budget: event.budget,
      projected: event.projected,
      monthStart: event.monthStart,
    };
  }
  if (event.type === "app_resumed" && !resumeIsNews(event.pausedBy, event.resumedBy)) {
    return { status: "skipped", reason: "own-resume" };
  }
  const row = await readInstallRow(db, event.installId);
  if (row === null) return { status: "skipped", reason: "no-install" };
  const app = appRefOf(row, await readMessageLabels(db, [row]));
  switch (event.type) {
    case "usage_unusual":
      return {
        type: "usage_unusual",
        app,
        plan: await planOf(db, event.plan),
        since: event.since,
        product: event.product,
        perHour: event.perHour,
        times: event.times,
        factor: event.factor,
        burnPerHour: event.burnPerHour,
        spentToday: event.spentToday,
        ...(event.freeShare == null ? {} : { freeShare: event.freeShare }),
      };
    case "usage_alert":
      return {
        type: "usage_alert",
        app,
        plan: await planOf(db, event.plan),
        ruleId: event.ruleId,
        sentence: event.sentence,
        kind: event.kind,
        unit: event.unit,
        amount: event.amount,
        value: event.value,
        period: event.period,
        periodStart: event.periodStart,
      };
    case "usage_limit_near": {
      const limit = freeDailyLimit(event.product);
      if (limit === null) return { status: "skipped", reason: "no-free-limit" };
      return {
        type: "usage_limit_near",
        app,
        product: event.product,
        limit,
        used: event.used,
        runsOutAt: event.runsOutAt,
        appShare: Math.min(1, Math.max(0, event.appShare)),
        day: dayStart(at) / 1000,
      };
    }
    case "app_paused":
      return {
        type: "app_paused",
        app,
        pauseId: event.pauseId,
        by: await personName(db, event.pausedBy),
        cause: event.cause,
      };
    case "app_resumed":
      return {
        type: "app_resumed",
        app,
        pauseId: event.pauseId,
        by: await personName(db, event.resumedBy),
        capSetAsideUntil: event.capSetAsideUntil,
      };
  }
}

/** When the event happened: an episode when it began, everything else when it was noticed. */
function occurredAt(event: UsageEvent, now: number): number {
  return event.at ?? (event.type === "usage_unusual" ? event.since : now);
}

/**
 * Records a spend protection event for every channel that wants it and
 * sends it at once over `SELF` (see the module comment). Never throws.
 */
export async function emitUsageEvent(
  env: UsageEventEnv,
  event: UsageEvent,
  deps: UsageEventDeps = {},
): Promise<UsageEventOutcome> {
  const now = (deps.now ?? Date.now)();
  try {
    const channels = await readChannels(env.DB);
    if (!wants(channels, event.type satisfies NotificationEvent)) {
      return { status: "skipped", reason: "no-channel" };
    }
    const at = occurredAt(event, now);
    const facts = await factsOf(env.DB, event, at);
    if ("status" in facts) return facts;
    const input: EmitInput = {
      type: event.type,
      dedupeKey: usageEventKey(event, at),
      facts,
      occurredAt: at,
    };
    const { eventId, queued } = await emitEvent(env.DB, channels, input, now);
    if (eventId === null) return { status: "skipped", reason: "no-channel" };
    const units = selfNotificationUnits(env);
    if (queued === 0 || units === undefined) {
      return { status: "queued", eventId, queued, delivered: null };
    }
    let delivered: { sent: number; retrying: number; failed: number } | null = null;
    try {
      const result = await units.deliverNotifications({ eventId });
      if (result.ok) {
        const { sent, retrying, failed } = result.value;
        delivered = { sent, retrying, failed };
      }
    } catch (error) {
      // The scheduled run retries what is still pending.
      console.warn("usage notification not sent now", {
        eventId,
        error: error instanceof Error ? error.message : String(error),
      });
    }
    return { status: "queued", eventId, queued, delivered };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.warn("usage notification failed", { type: event.type, error: message });
    return { status: "error", error: message };
  }
}
