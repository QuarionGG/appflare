import { sql } from "drizzle-orm";
import {
  index,
  integer,
  primaryKey,
  real,
  sqliteTable,
  text,
  uniqueIndex,
} from "drizzle-orm/sqlite-core";

/**
 * Usage and spend protection tables, re-exported by db/schema.ts so
 * drizzle-kit sees one schema. Their store functions live in usage/store/.
 *
 * Instants (`*_at`, `*_since`, `*_until`) are integer epoch milliseconds,
 * like every other table. Usage buckets and periods (`hour`, `day`,
 * `period_start`, `limit_warned_day`) are integer unix SECONDS of a UTC
 * boundary, the unit Cloudflare's GraphQL Analytics groups by.
 *
 * None of these tables references `installs`: usage history outlives the
 * install it belongs to (an uninstalled app keeps its history, and Cloudflare
 * deletes a Durable Object namespace's analytics with the namespace), and the
 * watcher writes them without reading `installs` first.
 */

const timestamp = (name: string) => integer(name, { mode: "timestamp_ms" });

/** Who decides whether an app pauses itself: the account's default, or the app's own choice. */
export const AUTO_PAUSE_CHOICES = ["default", "on", "off"] as const;
export type AutoPauseChoice = (typeof AUTO_PAUSE_CHOICES)[number];

/** How eagerly the loop trigger fires (thresholds live with the usage math). */
export const LOOP_LEVELS = ["relaxed", "standard", "strict"] as const;
export type LoopLevel = (typeof LOOP_LEVELS)[number];

/** UTC day, ISO week (Monday 00:00 UTC), calendar month. */
export const SPEND_PERIODS = ["day", "week", "month"] as const;
export type SpendPeriod = (typeof SPEND_PERIODS)[number];

/** `spent`: has passed the amount; `pace`: is on pace to pass it by the period's end. */
export const ALERT_RULE_KINDS = ["spent", "pace"] as const;
export type AlertRuleKind = (typeof ALERT_RULE_KINDS)[number];

/** `usd`: dollars at list price; `pct`: percent of included usage (of a free daily limit on Free). */
export const ALERT_RULE_UNITS = ["usd", "pct"] as const;
export type AlertRuleUnit = (typeof ALERT_RULE_UNITS)[number];

/**
 * What the usage activity log records, for an app's Recent activity, its
 * chart's markers and the "alerts sent" count: an unusual-usage episode
 * starting and ending, a usage alert sent, a free daily limit about to run
 * out, the monthly budget reached (account-wide), a pause or resume and
 * their failures, a spend protection settings change, the cap set aside
 * until it resets, Workers Logs turned on or off.
 */
export const ACTIVITY_KINDS = [
  "unusual_started",
  "unusual_ended",
  "alert_sent",
  "limit_near",
  "budget_reached",
  "paused",
  "resumed",
  "pause_failed",
  "resume_failed",
  "settings_changed",
  "cap_set_aside",
  "observability_changed",
] as const;
export type ActivityKind = (typeof ACTIVITY_KINDS)[number];

/** Why an app was paused: by someone, or by the loop, cap or monthly budget trigger. */
export const PAUSE_REASONS = ["manual", "loop", "cap", "budget"] as const;
export type PauseReason = (typeof PAUSE_REASONS)[number];

/**
 * One hour of one product of one install, from Cloudflare's GraphQL
 * Analytics. `hour` is the unix second the UTC hour starts. `value` is the
 * amount used in that hour, or for a level product (storage) the level.
 * Kept 45 days.
 */
export const usage_hourly = sqliteTable(
  "usage_hourly",
  {
    install_id: text("install_id").notNull(),
    product: text("product").notNull(),
    hour: integer("hour").notNull(),
    value: real("value").notNull(),
  },
  (t) => [
    primaryKey({ columns: [t.install_id, t.product, t.hour] }),
    // An install's hours in a range, every product (rollups, per-install
    // reads): the primary key would only narrow them to the install.
    index("usage_hourly_install_hour_idx").on(t.install_id, t.hour),
    index("usage_hourly_hour_idx").on(t.hour),
  ],
);

/**
 * One UTC day of one product of one install, rolled up from `usage_hourly`:
 * the day's total, or for a level product the day's last level. `day` is the
 * unix second the UTC day starts. Kept 400 days.
 */
export const usage_daily = sqliteTable(
  "usage_daily",
  {
    install_id: text("install_id").notNull(),
    product: text("product").notNull(),
    day: integer("day").notNull(),
    value: real("value").notNull(),
  },
  (t) => [
    primaryKey({ columns: [t.install_id, t.product, t.day] }),
    index("usage_daily_install_day_idx").on(t.install_id, t.day),
    index("usage_daily_day_idx").on(t.day),
  ],
);

/**
 * An app's own spend protection settings. No row means every setting follows
 * the account (the `spend_*` settings rows). See usage/store/spend-settings.
 */
export const app_spend_settings = sqliteTable("app_spend_settings", {
  install_id: text("install_id").primaryKey(),
  /** Unusual-usage alert at N× normal: null follows the account, 0 is off. */
  unusual_factor: integer("unusual_factor"),
  auto_pause: text("auto_pause", { enum: AUTO_PAUSE_CHOICES }).notNull().default("default"),
  /** Pauses on its own triggers below instead of the account's. */
  custom_triggers: integer("custom_triggers", { mode: "boolean" }).notNull().default(false),
  loop_on: integer("loop_on", { mode: "boolean" }).notNull().default(true),
  /** Null: the account's loop level. */
  loop_level: text("loop_level", { enum: LOOP_LEVELS }),
  cap_on: integer("cap_on", { mode: "boolean" }).notNull().default(true),
  /** Dollars per `cap_period`; null until an admin enters one (no cap). */
  cap_amount: real("cap_amount"),
  cap_period: text("cap_period", { enum: SPEND_PERIODS }).notNull().default("day"),
  /** The monthly budget never pauses this app (its spend still counts). */
  budget_exempt: integer("budget_exempt", { mode: "boolean" }).notNull().default(false),
  /**
   * "Resume until the cap resets": the cap does not pause the app again
   * before this instant (the end of the cap's period when it was resumed).
   * The loop check still runs.
   */
  cap_set_aside_until: timestamp("cap_set_aside_until"),
  updated_at: timestamp("updated_at").notNull(),
  /** The user id of the admin who last changed it. */
  updated_by: text("updated_by").notNull(),
});

/** A usage alert rule of an app: "When it [kind] [amount] [unit] [period]". */
export const usage_alert_rules = sqliteTable(
  "usage_alert_rules",
  {
    /** A ULID. */
    id: text("id").primaryKey(),
    install_id: text("install_id").notNull(),
    kind: text("kind", { enum: ALERT_RULE_KINDS }).notNull(),
    unit: text("unit", { enum: ALERT_RULE_UNITS }).notNull(),
    amount: real("amount").notNull(),
    period: text("period", { enum: SPEND_PERIODS }).notNull(),
    created_at: timestamp("created_at").notNull(),
    created_by: text("created_by").notNull(),
  },
  (t) => [index("usage_alert_rules_install_id_idx").on(t.install_id)],
);

/**
 * Each rule fires at most once per period: the primary key is the dedupe
 * key. `period_start` is the unix second the rule's period started, `value`
 * what the rule watched when it fired.
 */
export const usage_alert_firings = sqliteTable(
  "usage_alert_firings",
  {
    rule_id: text("rule_id").notNull(),
    period_start: integer("period_start").notNull(),
    fired_at: timestamp("fired_at").notNull(),
    value: real("value").notNull(),
  },
  (t) => [primaryKey({ columns: [t.rule_id, t.period_start] })],
);

/** What the spend watcher remembers about an install between checks. */
export const app_usage_state = sqliteTable("app_usage_state", {
  install_id: text("install_id").primaryKey(),
  /** Consecutive checks the loop trigger tripped on; 0 once one does not. */
  loop_checks: integer("loop_checks").notNull().default(0),
  /** When the current unusual-usage episode began; null outside one. */
  unusual_since: timestamp("unusual_since"),
  /** The UTC day (unix second it starts) a free daily limit warning was last sent. */
  limit_warned_day: integer("limit_warned_day"),
  /** When the watcher last checked the install; null until it did. */
  last_checked_at: timestamp("last_checked_at"),
  /** Dollars an hour at list price, as of the last check. */
  last_burn: real("last_burn"),
  /** The app's normal hourly cost (p95 of the week before the last day), as of the last check. */
  normal_burn: real("normal_burn"),
});

/**
 * One pause of an install, open until it is resumed. What the pause changed
 * is recorded as it happens, so Resume puts back exactly that: the version
 * each of the app's Workers served before its stand-in, and the containers,
 * queues and Workflow instances it paused. At most one open pause per install.
 */
export const app_pauses = sqliteTable(
  "app_pauses",
  {
    /** A ULID. */
    id: text("id").primaryKey(),
    install_id: text("install_id").notNull(),
    paused_at: timestamp("paused_at").notNull(),
    /** `auto` (a trigger), or the user id of who paused it. */
    paused_by: text("paused_by").notNull(),
    reason: text("reason", { enum: PAUSE_REASONS }).notNull(),
    /** The trigger's facts (cap amount and period, burn and normal, budget), as JSON. */
    detail_json: text("detail_json"),
    /**
     * JSON `{ [Worker name]: version id }`: the version each Worker of the
     * app served before its stand-in, every Worker the app deployed (an app
     * may ship several). Resume redeploys each. Null until recorded.
     */
    worker_versions_json: text("worker_versions_json"),
    /**
     * What to restore on Resume, as JSON written by the pause job: the
     * container applications it set to no instances (with the count each
     * had), the queues whose delivery it paused, the Workflow instances it
     * paused. Null when there was nothing of that kind (or not yet).
     */
    containers_json: text("containers_json"),
    queues_json: text("queues_json"),
    workflows_json: text("workflows_json"),
    /** The pause job. */
    job_id: text("job_id"),
    /** The resume job, once one started. */
    resume_job_id: text("resume_job_id"),
    resumed_at: timestamp("resumed_at"),
    /** The user id of who resumed it. */
    resumed_by: text("resumed_by"),
  },
  (t) => [uniqueIndex("app_pauses_open_idx").on(t.install_id).where(sql`resumed_at IS NULL`)],
);

/**
 * The usage activity log: what spend protection noticed and did, and what
 * people changed, per install (`install_id` null for the account, like the
 * monthly budget being reached). Notifications go through the outbox, which
 * keeps nothing when no channel listens; this is the history the app's page
 * shows. `by` is the user id, null for Appflare on its own. `facts_json`
 * holds the kind's facts (usage/store/activity.ts). Kept 400 days; an
 * uninstalled app's rows stay until then.
 */
export const usage_activity = sqliteTable(
  "usage_activity",
  {
    /** A ULID. */
    id: text("id").primaryKey(),
    install_id: text("install_id"),
    at: timestamp("at").notNull(),
    kind: text("kind", { enum: ACTIVITY_KINDS }).notNull(),
    by: text("by"),
    facts_json: text("facts_json").notNull(),
  },
  (t) => [
    index("usage_activity_install_at_idx").on(t.install_id, t.at),
    index("usage_activity_at_idx").on(t.at),
  ],
);
