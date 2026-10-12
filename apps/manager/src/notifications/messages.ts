import { SITE_URL } from "@appflare/schema/links";
import { z } from "zod";
import { ACCOUNT_PLANS } from "../account/plan";
import { appLink, appTabLink } from "../components/app-links";
import { settingsLink } from "../components/settings-links";
import { managerSiteLink } from "../site-links";
import { pauseCauseSchema, pauseCauseSentence } from "../usage/attention-cause";
import {
  fullCount,
  PERIOD_NOUN,
  percent,
  productLabel,
  productRate,
  times,
  usd,
  utcClock,
  utcDateTime,
} from "../usage/attention-format";
import { PERIODS } from "../usage/math";
import type { NOTIFICATION_EVENTS } from "./schema";

/**
 * What a notification says. Facts are stored with the event
 * (`notification_events.facts_json`) and rendered per channel kind when it
 * is delivered. They hold only what a message may show: app and instance
 * names, versions, the Worker name, ids that form links into the manager,
 * spend protection's numbers and the names of the people who paused or
 * resumed an app. Never a secret, a token, an account id, or a job's error text (which can
 * name secrets and request paths): a failed job links to its log instead.
 */

const appRef = z.object({
  installId: z.string(),
  /** The catalog app's name ("Cut"). */
  app: z.string(),
  /**
   * What the UI calls the install (`distinctLabels`): its display name, else
   * the app's name, with its Worker name in parentheses when another install
   * reads the same. Events stored by older versions hold the Worker name.
   */
  instance: z.string(),
  workerName: z.string(),
});
export type AppRef = z.infer<typeof appRef>;

const outcome = z.enum(["succeeded", "failed"]);
const version = z.string().nullable();
/** Dollars at Cloudflare's list prices: an estimate, never the bill itself. */
const dollars = z.number().nonnegative();
const epochMs = z.number().int().nonnegative();
/** A usage product (`usage/math/products.ts`) by its key. */
const product = z.string().min(1);
/** Who did it, by name; null when Appflare did it on its own. */
const actor = z.string().min(1).nullable();

export const notificationFactsSchema = z.discriminatedUnion("type", [
  z.object({
    type: z.literal("update_available"),
    app: appRef,
    from: z.string(),
    to: z.string(),
    /** The entry changed how the app is installed: the new version takes a reinstall. */
    reinstall: z.literal(true).optional(),
  }),
  z.object({
    type: z.literal("update_applied"),
    app: appRef,
    from: version,
    to: version,
    jobId: z.string(),
  }),
  z.object({
    type: z.literal("update_failed"),
    app: appRef,
    from: version,
    to: version,
    jobId: z.string(),
  }),
  z.object({
    type: z.literal("install_finished"),
    app: appRef,
    version,
    outcome,
    jobId: z.string(),
  }),
  z.object({
    type: z.literal("uninstall_finished"),
    app: appRef,
    outcome,
    jobId: z.string(),
    /**
     * The removal of what an install that did not finish left, before
     * installing it again ("Install again"); only its failure is news.
     */
    replaced: z.literal(true).optional(),
  }),
  z.object({ type: z.literal("health_failing"), app: appRef }),
  z.object({
    type: z.literal("usage_unusual"),
    app: appRef,
    plan: z.enum(ACCOUNT_PLANS),
    /** When the episode began (epoch ms). */
    since: epochMs,
    /** The product furthest above its normal. */
    product,
    /** How much of it the app used in the last hour, in the product's unit. */
    perHour: z.number().nonnegative(),
    /** How many times its normal hour. */
    times: z.number().positive(),
    /** The alert's setting: an hour at this many times normal alerts. */
    factor: z.number().positive(),
    /** Its activity's cost an hour, and today so far. */
    burnPerHour: dollars,
    spentToday: dollars,
    /** Free: the share of the product's free daily limit it is on pace to use today. */
    freeShare: z.number().nonnegative().nullable().optional(),
  }),
  z.object({
    type: z.literal("usage_alert"),
    app: appRef,
    plan: z.enum(ACCOUNT_PLANS),
    ruleId: z.string().min(1),
    /** The rule as it read when it fired ("When it has spent $5.00 this week"). */
    sentence: z.string().min(1),
    kind: z.enum(["spent", "pace"]),
    /** `usd`: dollars; `pct`: percent of included usage (of a free daily limit on Free). */
    unit: z.enum(["usd", "pct"]),
    /** The rule's amount, in its unit (dollars, or a percent such as 80). */
    amount: z.number().positive(),
    /** What it saw, in the same unit. */
    value: z.number().nonnegative(),
    period: z.enum(PERIODS),
    /** The unix second the period began. */
    periodStart: z.number().int(),
  }),
  z.object({
    type: z.literal("usage_limit_near"),
    app: appRef,
    product,
    /** The account's free amount of the product a day. */
    limit: z.number().positive(),
    /** What the account used of it today. */
    used: z.number().nonnegative(),
    /** When it runs out at the current pace (epoch ms); null once it has. */
    runsOutAt: epochMs.nullable(),
    /** The app's share of the account's use of it today. */
    appShare: z.number().min(0).max(1),
    /** The unix second the UTC day began. */
    day: z.number().int(),
  }),
  z.object({
    type: z.literal("app_paused"),
    app: appRef,
    pauseId: z.string().min(1),
    by: actor,
    cause: pauseCauseSchema,
  }),
  z.object({
    type: z.literal("app_resumed"),
    app: appRef,
    pauseId: z.string().min(1),
    by: actor,
    /** "Resume until the cap resets": the cap does not pause it again before then (epoch ms). */
    capSetAsideUntil: epochMs.nullable(),
  }),
  z.object({
    type: z.literal("budget_reached"),
    /** The budget, including the $5 plan. */
    budget: z.number().positive(),
    /** The month's bill at the current pace. */
    projected: dollars,
    /** The unix second the month began. */
    monthStart: z.number().int(),
  }),
  z.object({ type: z.literal("manager_update_available"), from: z.string(), to: z.string() }),
  z.object({ type: z.literal("domain_active"), app: appRef, hostname: z.string() }),
  z.object({
    type: z.literal("domain_failed"),
    app: appRef,
    hostname: z.string(),
    /** Appflare's own sentence for the state Cloudflare reports (never Cloudflare's error text). */
    reason: z.string(),
  }),
  z.object({
    type: z.literal("manager_address_lost"),
    /** The custom domain Appflare was at. */
    hostname: z.string(),
    /**
     * Cloudflare Access could not be moved back to workers.dev, so it still
     * protects the lost hostname and Appflare refuses sign-in at workers.dev.
     */
    accessLeftBehind: z.boolean().optional(),
  }),
  z.object({
    type: z.literal("manager_move_finished"),
    /** The custom domain Appflare was moving to. */
    hostname: z.string(),
    outcome,
    jobId: z.string(),
    /** A failed job whose switch had committed: Appflare lives at `hostname` anyway. */
    moved: z.boolean().optional(),
  }),
  z.object({ type: z.literal("test") }),
]);
export type NotificationFacts = z.infer<typeof notificationFactsSchema>;
export type FactsType = NotificationFacts["type"];

// Every stored event type has facts of the same name.
type _Covered =
  Exclude<(typeof NOTIFICATION_EVENTS)[number], FactsType> extends never ? true : never;
const _covered: _Covered = true;
void _covered;

export interface Message {
  title: string;
  /** Plain sentences, one per line. */
  lines: string[];
  /** Absolute link into the manager; null when its URL is not known. */
  url: string | null;
}

/** The docs' Access recovery steps ("If you are locked out"). */
export const ACCESS_LOCKED_OUT_URL = managerSiteLink(
  `${SITE_URL}/security/#if-you-are-locked-out`,
  "accessLockedOut",
  "notification",
);

function managerLink(managerUrl: string | null, path: string): string | null {
  return managerUrl === null ? null : `${managerUrl.replace(/\/+$/, "")}${path}`;
}

const v = (value: string | null) => value ?? "an unknown version";

export function renderMessage(facts: NotificationFacts, managerUrl: string | null): Message {
  switch (facts.type) {
    case "update_available":
      return {
        title:
          facts.reinstall === true
            ? `New version takes a reinstall: ${facts.app.instance}`
            : `Update available: ${facts.app.instance}`,
        lines: [
          `${facts.app.app} ${facts.to} is available. ${facts.app.instance} runs ${facts.from}.`,
          ...(facts.reinstall === true
            ? [
                `${facts.app.app} changed how it is installed, so ${facts.app.instance} cannot be updated in place: uninstall it and install it again to get ${facts.to}.`,
              ]
            : []),
        ],
        url: managerLink(managerUrl, appLink(facts.app.installId)),
      };
    case "update_applied":
      return {
        title: `Updated ${facts.app.instance}`,
        lines: [
          `${facts.app.instance} now runs ${facts.app.app} ${v(facts.to)}, updated from ${v(facts.from)}.`,
        ],
        url: managerLink(managerUrl, `/jobs/${facts.jobId}`),
      };
    case "update_failed":
      return {
        title: `Update failed: ${facts.app.instance}`,
        lines: [
          `Updating ${facts.app.instance} from ${v(facts.from)} to ${v(facts.to)} failed. The job log says where.`,
        ],
        url: managerLink(managerUrl, `/jobs/${facts.jobId}`),
      };
    case "install_finished":
      return facts.outcome === "succeeded"
        ? {
            title: `Installed ${facts.app.instance}`,
            lines: [`${facts.app.app} ${v(facts.version)} is installed as ${facts.app.instance}.`],
            url: managerLink(managerUrl, `/jobs/${facts.jobId}`),
          }
        : {
            title: `Install failed: ${facts.app.instance}`,
            lines: [
              `Installing ${facts.app.app} ${v(facts.version)} as ${facts.app.instance} failed. The job log says where.`,
            ],
            url: managerLink(managerUrl, `/jobs/${facts.jobId}`),
          };
    case "uninstall_finished":
      return facts.outcome === "succeeded"
        ? {
            title: `Uninstalled ${facts.app.instance}`,
            lines: [`${facts.app.instance} was uninstalled.`],
            url: managerLink(managerUrl, `/jobs/${facts.jobId}`),
          }
        : facts.replaced === true
          ? {
              title: `Removing what the unfinished install of ${facts.app.instance} left failed`,
              lines: [
                `Installing ${facts.app.instance} again waits for this, so it did not start. The job log says where it stopped.`,
              ],
              url: managerLink(managerUrl, `/jobs/${facts.jobId}`),
            }
          : {
              title: `Uninstall failed: ${facts.app.instance}`,
              lines: [`Uninstalling ${facts.app.instance} failed. The job log says where.`],
              url: managerLink(managerUrl, `/jobs/${facts.jobId}`),
            };
    case "health_failing":
      return {
        title: `Health check failing: ${facts.app.instance}`,
        lines: [`${facts.app.instance} answers its health check with a server error.`],
        url: managerLink(managerUrl, appLink(facts.app.installId, "health")),
      };
    case "usage_unusual":
    case "usage_alert":
    case "usage_limit_near":
    case "app_paused":
    case "app_resumed":
    case "budget_reached":
      return usageMessage(facts, managerUrl);
    case "manager_update_available":
      return {
        title: "Appflare update available",
        lines: [`Appflare ${facts.to} is available. This manager runs ${facts.from}.`],
        url: managerLink(managerUrl, settingsLink("updates", "appflare")),
      };
    case "domain_active":
      return {
        title: `Domain active: ${facts.hostname}`,
        lines: [
          `${facts.hostname} now serves ${facts.app.instance}. Cloudflare validated it and issued its certificate.`,
        ],
        url: managerLink(managerUrl, appLink(facts.app.installId, "external-domains")),
      };
    case "domain_failed":
      return {
        title: `Domain failed: ${facts.hostname}`,
        lines: [
          `${facts.hostname}, an external domain of ${facts.app.instance}, does not serve the app. ${facts.reason}`,
        ],
        url: managerLink(managerUrl, appLink(facts.app.installId, "external-domains")),
      };
    case "manager_address_lost":
      return {
        title: "Appflare's address stopped working",
        lines: [
          `${facts.hostname} no longer serves Appflare, so Appflare is back at its workers.dev address. Sign in there with your password; passkeys added at ${facts.hostname} do not work there.`,
          ...(facts.accessLeftBehind === true
            ? [
                `Cloudflare Access could not be moved back to workers.dev, so Appflare refuses sign-in there until you follow the Access recovery steps: ${ACCESS_LOCKED_OUT_URL}`,
              ]
            : []),
        ],
        url: managerLink(managerUrl, settingsLink("domains", "address")),
      };
    case "manager_move_finished":
      if (facts.outcome === "failed" && facts.moved === true) {
        return {
          title: `Appflare moved to ${facts.hostname}; its job failed afterwards`,
          lines: [
            `Appflare now lives at ${facts.hostname}. Sign in again there; the job log says what did not finish.`,
          ],
          url: `https://${facts.hostname}/jobs/${facts.jobId}`,
        };
      }
      return facts.outcome === "succeeded"
        ? {
            title: `Appflare moved to ${facts.hostname}`,
            lines: [
              `Appflare now lives at ${facts.hostname}. Sign in again there; passkeys added at the old address work only there.`,
            ],
            url: `https://${facts.hostname}/`,
          }
        : {
            title: `Moving Appflare to ${facts.hostname} failed`,
            lines: [
              `Appflare stays at its current address. The job log says why; start the move again from the Domains settings.`,
            ],
            url: managerLink(managerUrl, `/jobs/${facts.jobId}`),
          };
    case "test":
      return {
        title: "Test message from Appflare",
        lines: ["This channel works. Appflare sends the events you picked for it here."],
        url: managerLink(managerUrl, settingsLink("notifications", "channels")),
      };
  }
}

type UsageFacts = Extract<
  NotificationFacts,
  {
    type:
      | "usage_unusual"
      | "usage_alert"
      | "usage_limit_near"
      | "app_paused"
      | "app_resumed"
      | "budget_reached";
  }
>;

/** "Pause it ..." and "Resume it ..." point at the two places that do it. */
const PAUSE_HINT = "Pause it from Home or its Usage tab if this is not expected.";
const PAUSED_PAGE =
  'Visitors see a "paused" page and its scheduled work stops; its data stays as it is. Resume it from Home or its Usage tab.';

/** What a used-up free daily limit does, by product. */
function limitEffect(key: string): string {
  return key === "workers_requests" ? "every app stops answering" : "apps that need them fail";
}

/**
 * Spend protection's messages. Dollars are estimates at Cloudflare's list
 * prices ("about"); every app's message links to its Usage tab, the budget's
 * to the account's settings.
 */
function usageMessage(facts: UsageFacts, managerUrl: string | null): Message {
  const usageUrl = (installId: string) => managerLink(managerUrl, appTabLink(installId, "usage"));
  switch (facts.type) {
    case "usage_unusual": {
      const { instance } = facts.app;
      const cost =
        facts.plan === "paid"
          ? `About ${usd(facts.burnPerHour)} an hour at Cloudflare's prices, ${usd(facts.spentToday)} so far today.`
          : facts.freeShare != null
            ? `At this pace it uses ${percent(facts.freeShare)} of today's free ${productLabel(facts.product)}.`
            : null;
      return {
        title: `Unusual usage: ${instance}`,
        lines: [
          `${instance} is using far more than usual: ${productRate(facts.product, facts.perHour)} since ${utcClock(facts.since)}, ${times(facts.times)} its normal.`,
          ...(cost === null ? [] : [cost]),
          PAUSE_HINT,
        ],
        url: usageUrl(facts.app.installId),
      };
    }
    case "usage_alert": {
      const { instance } = facts.app;
      const when = PERIOD_NOUN[facts.period];
      let line: string;
      if (facts.unit === "usd") {
        const verb = facts.kind === "spent" ? "has spent" : "is on pace to spend";
        line = `${instance} ${verb} about ${usd(facts.value)} ${when} at Cloudflare's prices. The alert is at ${usd(facts.amount)}.`;
      } else {
        const verb = facts.kind === "spent" ? "has used" : "is on pace to use";
        const of = facts.plan === "free" ? "a free daily limit" : "included usage";
        line = `${instance} ${verb} ${percent(facts.value / 100)} of ${of} ${when}. The alert is at ${fullCount(facts.amount)}%.`;
      }
      return {
        title: `Usage alert: ${instance}`,
        lines: [line],
        url: usageUrl(facts.app.installId),
      };
    }
    case "usage_limit_near": {
      const { instance } = facts.app;
      const label = productLabel(facts.product);
      const limit = `${fullCount(facts.limit)} free ${label}`;
      if (facts.runsOutAt === null) {
        return {
          title: `Free ${label} used up for today`,
          lines: [
            `This account used its ${limit} for today, ${percent(facts.appShare)} of them by ${instance}. Cloudflare refuses more until 00:00 UTC, so ${limitEffect(facts.product)} until then.`,
            `The Free plan bills nothing; pausing ${instance} stops it happening again tomorrow.`,
          ],
          url: usageUrl(facts.app.installId),
        };
      }
      return {
        title: `Free ${label} run out around ${utcClock(facts.runsOutAt)}`,
        lines: [
          `${instance} is getting ${percent(facts.appShare)} of today's ${label}. When the account's ${limit} for the day are used, ${limitEffect(facts.product)} until 00:00 UTC.`,
        ],
        url: usageUrl(facts.app.installId),
      };
    }
    case "app_paused": {
      const { instance } = facts.app;
      const why = pauseCauseSentence(facts.cause);
      return {
        title: facts.by === null ? `Appflare paused ${instance}` : `${facts.by} paused ${instance}`,
        lines: [...(why === null ? [] : [why]), PAUSED_PAGE],
        url: usageUrl(facts.app.installId),
      };
    }
    case "app_resumed":
      return {
        title: `${facts.app.instance} resumed`,
        lines: [
          `${facts.by ?? "Appflare"} resumed it. Visitors reach it again.`,
          ...(facts.capSetAsideUntil === null
            ? []
            : [
                `Its cap is set aside until it resets at ${utcDateTime(facts.capSetAsideUntil)}; the loop check still runs.`,
              ]),
        ],
        url: usageUrl(facts.app.installId),
      };
    case "budget_reached":
      return {
        title: "Monthly budget reached",
        lines: [
          `This month's bill is on pace for about ${usd(facts.projected)} at Cloudflare's prices, past the ${usd(facts.budget)} budget (the $5 plan included).`,
          "Appflare pauses apps, the one with the largest share of this month's usage first, until the bill fits. Apps set to never pause for the budget keep running.",
        ],
        url: managerLink(managerUrl, settingsLink("account")),
      };
  }
}

/** Plain text: Telegram (no parse mode, so nothing needs escaping). */
export function plainText(message: Message): string {
  return [message.title, ...message.lines, ...(message.url === null ? [] : [message.url])].join(
    "\n",
  );
}

/** Slack mrkdwn: `&`, `<` and `>` are the only characters Slack asks to escape. */
export function slackText(message: Message): string {
  const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  const link = message.url === null ? [] : [`<${esc(message.url)}|Open in Appflare>`];
  return [`*${esc(message.title)}*`, ...message.lines.map(esc), ...link].join("\n");
}

/** Discord markdown, with names escaped; the link in `<>` so Discord adds no preview. */
export function discordText(message: Message): string {
  const esc = (s: string) => s.replace(/([\\*_~`|>#[\]])/g, "\\$1");
  const link = message.url === null ? [] : [`<${message.url}>`];
  return [`**${esc(message.title)}**`, ...message.lines.map(esc), ...link].join("\n");
}
