import { env } from "cloudflare:workers";
import { z } from "zod";
import { getCfClient } from "../cloudflare/client.server";
import { createDb } from "../db/client";
import { INSTALL_ORIGINS } from "../db/schema";
import { parsePauseCause } from "./attention-cause";
import { HOUR_MS, hourStart, PERIODS, periodStart } from "./math";
import { type AppObservability, readAppObservability } from "./observability.server";
import { readSpendOverview } from "./overview.server";
import { ACTIVITY_FACTS } from "./store/activity";
import { listAlertRules } from "./store/alert-rules.server";
import { readAppSpendSettings } from "./store/app-settings.server";
import { readUsage, type UsageRow } from "./store/series.server";
import { resolveSpendSettings } from "./store/spend-settings";
import { readUsageState } from "./store/usage-state.server";
import { FRESH_MS, type UsageEvent, type UsageTabData } from "./tab";
import {
  accountHourlyFrom,
  appDailyFrom,
  appHourlyFrom,
  buildUsageTab,
  EPISODE_SLACK_MS,
  type UnusualFacts,
} from "./tab-build";
import { readSpendWatchStatus } from "./watcher-status";

/**
 * One app's Usage tab, read in one round of indexed reads beside the
 * account's spend protection overview (which reads the watcher's stored
 * numbers): the app's own hourly rows for 8 days and daily rows for 30
 * (by install and time), the account's rows of the same products this month
 * (by time), its settings, alert rules, pauses, activity and jobs. Workers
 * Logs are read from Cloudflare only for an app installed minutes ago, the
 * one state that offers to turn them on. Server only.
 */

/** Entries of the activity log the page reads: enough for Recent activity and the chart's markers. */
const ACTIVITY_LIMIT = 40;
/** Jobs of the app the page reads for its history. */
const JOB_LIMIT = 20;
/** Pauses of the app the page reads to say why each one happened. */
const PAUSE_LIMIT = 20;

const seconds = (ms: number) => Math.floor(ms / 1000);

interface ActivityRow {
  id: string;
  at: number;
  kind: string;
  by: string | null;
  facts_json: string;
  name: string | null;
}

interface PauseRow {
  id: string;
  paused_at: number;
  paused_by: string;
  reason: string;
  detail_json: string | null;
  resumed_at: number | null;
  name: string | null;
}

interface JobRow {
  id: string;
  kind: string;
  started_by: string;
  finished_at: number | null;
  version: string | null;
  to_version: string | null;
  restore: number | null;
  vars_json: string | null;
  secrets_json: string | null;
  access: string | null;
}

/** A person's name as the page shows it. */
function personName(name: string | null): string {
  return name?.trim() || "Someone";
}

function parseJson(raw: string): unknown {
  try {
    return JSON.parse(raw);
  } catch {
    return undefined;
  }
}

const unusualStartFacts = z.looseObject({
  times: z.number().nonnegative(),
  product: z.string().min(1).optional(),
  freeShare: z.number().nonnegative().optional(),
});

const alertSentFacts = z.looseObject({
  ruleId: z.string().min(1),
  periodStart: z.number().int(),
});

const alertChangeFacts = z.looseObject({
  alert: z.enum(["added", "changed", "removed"]),
  sentence: z.string().min(1),
});

/** One activity row as an event of the page; null for one it does not show or cannot read. */
function activityEvent(row: ActivityRow, pauses: ReadonlyMap<string, PauseRow>): UsageEvent | null {
  const kind = row.kind as keyof typeof ACTIVITY_FACTS;
  if (!Object.hasOwn(ACTIVITY_FACTS, kind)) return null;
  const parsed = ACTIVITY_FACTS[kind].safeParse(parseJson(row.facts_json));
  if (!parsed.success) return null;
  const base = { id: row.id, at: row.at };
  const by = row.by === null ? null : personName(row.name);
  const f = parsed.data as Record<string, unknown>;
  switch (kind) {
    case "unusual_started": {
      const u = unusualStartFacts.safeParse(f).data;
      return {
        ...base,
        kind,
        product: u?.product ?? null,
        times: u !== undefined && u.times > 0 ? u.times : null,
      };
    }
    case "unusual_ended":
      return { ...base, kind, startedAt: f.startedAt as number };
    case "alert_sent":
      return { ...base, kind, sentence: f.sentence as string };
    case "limit_near":
      return {
        ...base,
        kind,
        product: f.product as string,
        share: f.share as number,
        runsOutAt: (f.runsOutAt as number | null) ?? null,
      };
    case "paused": {
      const pause = pauses.get(f.pauseId as string);
      return {
        ...base,
        kind,
        by,
        cause:
          pause === undefined
            ? parsePauseCause(f.reason as string, null)
            : parsePauseCause(pause.reason, pause.detail_json),
      };
    }
    case "resumed":
      return { ...base, kind, by };
    case "pause_failed":
    case "resume_failed":
      return { ...base, kind, error: f.error as string };
    case "settings_changed": {
      const alert = alertChangeFacts.safeParse(f).data;
      return {
        ...base,
        kind,
        by,
        changed: f.changed as string[],
        alert: alert === undefined ? null : { change: alert.alert, sentence: alert.sentence },
      };
    }
    case "cap_set_aside":
      return { ...base, kind, by, until: f.until as number };
    case "observability_changed":
      return { ...base, kind, by, enabled: f.enabled as boolean };
    default:
      // The account's own (the budget reached) never names an install.
      return null;
  }
}

interface InstallRowForTab {
  installed_at: number;
  origin: string;
  config_json: string | null;
  vars_json: string | null;
  secrets_json: string | null;
}

const namedFields = z.array(z.looseObject({ name: z.string(), label: z.string().optional() }));
const textRecord = z.record(z.string(), z.string());

/** What a settings change can say about the app's settings: their names, and their values now. */
interface SettingWords {
  labels: Map<string, string>;
  secrets: Set<string>;
  /** The settings' values now (secrets are never here). */
  values: Record<string, string>;
  /** Settings a newer change already named, whose value now is not what an older one set. */
  seen: Set<string>;
}

function settingWords(install: InstallRowForTab): SettingWords {
  const vars = namedFields.safeParse(parseJson(install.vars_json ?? "null")).data ?? [];
  const secrets = namedFields.safeParse(parseJson(install.secrets_json ?? "null")).data ?? [];
  const labels = new Map<string, string>();
  for (const f of [...vars, ...secrets]) labels.set(f.name, f.label ?? f.name);
  return {
    labels,
    secrets: new Set(secrets.map((f) => f.name)),
    values: textRecord.safeParse(parseJson(install.config_json ?? "null")).data ?? {},
    seen: new Set(),
  };
}

/** A value short enough to name: one line, not long. */
function shortValue(value: string | undefined): value is string {
  return value !== undefined && value.length > 0 && value.length <= 40 && !value.includes("\n");
}

/**
 * What a settings job changed, as it recorded it (the settings' names,
 * never secret values): "Check interval set to 10", "API key changed",
 * "Cloudflare Access turned on". The newest change of a setting names its
 * value now; older ones only that it changed. Jobs come newest first.
 */
function settingsChanges(row: JobRow, words: SettingWords): string[] {
  const out: string[] = [];
  const vars = z.array(z.string()).safeParse(parseJson(row.vars_json ?? "null")).data ?? [];
  for (const name of vars) {
    const label = words.labels.get(name) ?? name;
    const value = words.values[name];
    out.push(
      !words.seen.has(name) && !words.secrets.has(name) && shortValue(value)
        ? `${label} set to ${value}`
        : `${label} changed`,
    );
    words.seen.add(name);
  }
  const secrets = z
    .object({ set: z.array(z.string()), unset: z.array(z.string()) })
    .safeParse(parseJson(row.secrets_json ?? "null")).data;
  for (const name of secrets?.set ?? []) out.push(`${words.labels.get(name) ?? name} changed`);
  for (const name of secrets?.unset ?? []) out.push(`${words.labels.get(name) ?? name} removed`);
  if (row.access === "on") out.push("Cloudflare Access turned on");
  if (row.access === "off") out.push("Cloudflare Access turned off");
  return out;
}

function jobEvent(
  row: JobRow,
  origin: (typeof INSTALL_ORIGINS)[number],
  words: SettingWords,
): UsageEvent | null {
  if (row.finished_at === null) return null;
  const base = { id: row.id, at: row.finished_at };
  const automatic = row.started_by === "schedule";
  switch (row.kind) {
    case "install":
      return { ...base, kind: "installed", from: origin };
    case "update":
      return { ...base, kind: "updated", version: row.version, automatic };
    case "rollback":
      // A database restore leaves the code as it is.
      return row.restore === 1 ? null : { ...base, kind: "rolled_back", version: row.to_version };
    case "reconfigure":
      return { ...base, kind: "app_settings", automatic, changes: settingsChanges(row, words) };
    default:
      return null;
  }
}

/** The labels of the channels that receive any usage alert, oldest first. */
async function usageChannels(d1: D1Database): Promise<string[]> {
  const { results } = await d1
    .prepare("SELECT label, events_json FROM notification_channels ORDER BY created_at")
    .all<{ label: string; events_json: string }>();
  return results.flatMap((r) => {
    const events = parseJson(r.events_json);
    return Array.isArray(events) &&
      (events.includes("usage_unusual") || events.includes("usage_alert"))
      ? [r.label]
      : [];
  });
}

export interface ReadUsageTabOptions {
  /** Admins see which channels alerts go to; members cannot see channels. */
  isAdmin: boolean;
  now?: number;
  /** Reads Workers Logs from Cloudflare; called only for an app installed minutes ago. */
  readLogs?: () => Promise<AppObservability | null>;
}

/** The app's Usage tab; null when there is no such install. */
export async function readUsageTab(
  d1: D1Database,
  installId: string,
  options: ReadUsageTabOptions,
): Promise<UsageTabData | null> {
  const now = options.now ?? Date.now();
  const db = createDb(d1);
  const to = seconds(hourStart(now) + HOUR_MS);
  const dailyFrom = seconds(appDailyFrom(now));
  // The products the app used in the chart's 30 days: the account's rows are read for these only.
  const appProducts =
    "SELECT DISTINCT product FROM usage_daily WHERE install_id = ?3 AND day >= ?4";
  const alertsFrom = Math.min(...PERIODS.map((p) => periodStart(p, now)));

  const [
    { defaults, overview },
    install,
    appHourly,
    appDaily,
    accountDaily,
    accountHourly,
    own,
    rules,
    alertsSent,
    pauses,
    state,
    activity,
    jobs,
    channels,
    watch,
  ] = await Promise.all([
    readSpendOverview(d1, now),
    d1
      .prepare(
        `SELECT installed_at, origin, config_json,
           CASE WHEN json_valid(manifest_json) THEN json_extract(manifest_json, '$.catalog.vars') END AS vars_json,
           CASE WHEN json_valid(manifest_json) THEN json_extract(manifest_json, '$.catalog.secrets') END AS secrets_json
         FROM installs WHERE id = ?1`,
      )
      .bind(installId)
      .first<InstallRowForTab>(),
    readUsage(db, {
      from: seconds(appHourlyFrom(now)),
      to,
      grain: "hour",
      installIds: [installId],
    }),
    readUsage(db, { from: dailyFrom, to, grain: "day", installIds: [installId] }),
    d1
      .prepare(
        `SELECT install_id AS installId, product, day AS t, value FROM usage_daily
         WHERE day >= ?1 AND day < ?2 AND product IN (${appProducts})`,
      )
      .bind(seconds(periodStart("month", now)), to, installId, dailyFrom)
      .all<UsageRow>(),
    d1
      .prepare(
        `SELECT install_id AS installId, product, hour AS t, value FROM usage_hourly
         WHERE hour >= ?1 AND hour < ?2 AND product IN (${appProducts})`,
      )
      .bind(seconds(accountHourlyFrom(now)), to, installId, dailyFrom)
      .all<UsageRow>(),
    readAppSpendSettings(db, installId),
    listAlertRules(db, installId),
    d1
      .prepare(
        `SELECT facts_json FROM usage_activity
         WHERE install_id = ?1 AND kind = 'alert_sent' AND at >= ?2`,
      )
      .bind(installId, alertsFrom)
      .all<{ facts_json: string }>(),
    d1
      .prepare(
        `SELECT p.id, p.paused_at, p.paused_by, p.reason, p.detail_json, p.resumed_at, u.name
         FROM app_pauses p LEFT JOIN user u ON u.id = p.paused_by
         WHERE p.install_id = ?1 ORDER BY p.paused_at DESC LIMIT ?2`,
      )
      .bind(installId, PAUSE_LIMIT)
      .all<PauseRow>(),
    readUsageState(db, installId),
    d1
      .prepare(
        `SELECT a.id, a.at, a.kind, a.by, a.facts_json, u.name
         FROM usage_activity a LEFT JOIN user u ON u.id = a.by
         WHERE a.install_id = ?1 ORDER BY a.at DESC, a.id DESC LIMIT ?2`,
      )
      .bind(installId, ACTIVITY_LIMIT)
      .all<ActivityRow>(),
    d1
      .prepare(
        `SELECT id, kind, started_by, finished_at,
           CASE WHEN json_valid(input_json) THEN json_extract(input_json, '$.version') END AS version,
           CASE WHEN json_valid(input_json) THEN json_extract(input_json, '$.toVersion') END AS to_version,
           CASE WHEN json_valid(input_json) THEN json_extract(input_json, '$.restore') END AS restore,
           CASE WHEN json_valid(input_json) THEN json_extract(input_json, '$.vars') END AS vars_json,
           CASE WHEN json_valid(input_json) THEN json_extract(input_json, '$.secrets') END AS secrets_json,
           CASE WHEN json_valid(input_json) THEN json_extract(input_json, '$.access') END AS access
         FROM jobs
         WHERE install_id = ?1 AND status = 'succeeded'
           AND kind IN ('install', 'update', 'rollback', 'reconfigure')
         ORDER BY id DESC LIMIT ?2`,
      )
      .bind(installId, JOB_LIMIT)
      .all<JobRow>(),
    options.isAdmin ? usageChannels(d1) : Promise.resolve(null),
    readSpendWatchStatus(db),
  ]);
  if (install === null) return null;

  const origin = INSTALL_ORIGINS.find((o) => o === install.origin) ?? ("catalog" as const);
  const words = settingWords(install);
  const pauseById = new Map(pauses.results.map((p) => [p.id, p]));
  const events = [
    ...activity.results.map((row) => activityEvent(row, pauseById)),
    ...jobs.results.map((row) => jobEvent(row, origin, words)),
  ]
    .filter((e): e is UsageEvent => e !== null)
    .sort((a, b) => b.at - a.at || b.id.localeCompare(a.id));

  const open = pauses.results.find((p) => p.resumed_at === null);
  const since = state.unusualSince;
  const startRow =
    since === null
      ? undefined
      : activity.results.find(
          (r) => r.kind === "unusual_started" && r.at >= since - EPISODE_SLACK_MS,
        );
  const startFacts =
    startRow === undefined
      ? undefined
      : unusualStartFacts.safeParse(parseJson(startRow.facts_json)).data;
  const unusual: UnusualFacts | null =
    startRow === undefined
      ? null
      : {
          at: startRow.at,
          product: startFacts?.product ?? null,
          times: startFacts !== undefined && startFacts.times > 0 ? startFacts.times : null,
          freeShare: startFacts?.freeShare ?? null,
        };

  const snapshot = overview.apps.find((a) => a.installId === installId);
  const fresh = now - install.installed_at < FRESH_MS && appDaily.length === 0;
  let logs: AppObservability | null = null;
  if (fresh && options.readLogs !== undefined) {
    try {
      logs = await options.readLogs();
    } catch {
      // Not connected to Cloudflare, say: the page offers the switch without its state.
      logs = null;
    }
  }

  return buildUsageTab({
    installId,
    now,
    plan: overview.plan,
    installedAt: install.installed_at,
    missingScopes: overview.missingScopes,
    watch,
    updatedAt: watch?.at ?? state.lastCheckedAt ?? overview.computedAt,
    appHourly,
    appDaily,
    accountDaily: accountDaily.results,
    accountHourly: accountHourly.results,
    paused: new Set(overview.apps.filter((a) => a.paused).map((a) => a.installId)),
    defaults,
    own,
    effective: resolveSpendSettings(defaults, own),
    snapshot,
    rules,
    alertsSent: alertsSent.results.flatMap((r) => {
      const f = alertSentFacts.safeParse(parseJson(r.facts_json)).data;
      return f === undefined ? [] : [{ ruleId: f.ruleId, periodStart: f.periodStart }];
    }),
    pause:
      open === undefined
        ? null
        : {
            pausedAt: open.paused_at,
            by: open.paused_by === "auto" ? null : personName(open.name),
            cause: parsePauseCause(open.reason, open.detail_json),
          },
    unusualSince: since,
    unusual,
    events,
    channels,
    logs,
  });
}

/** The tab for `installId` from the manager's own database, with Workers Logs read from Cloudflare. */
export function readTabFor(installId: string, isAdmin: boolean): Promise<UsageTabData | null> {
  return readUsageTab(env.DB, installId, {
    isAdmin,
    readLogs: () => readAppObservability({ db: env.DB, api: () => getCfClient(env) }, installId),
  });
}
