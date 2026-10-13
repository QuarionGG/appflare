import { listWords } from "../attention";
import { pauseCauseSentence } from "../attention-cause";
import {
  count,
  fullCount,
  labelAfter,
  percent,
  productLabel,
  productRate,
  times,
  usd,
  withUnit,
} from "../attention-format";
import { PRODUCTS, type ProductKey } from "../math";
import type { ProductUsage, UsageEvent, UsageRange, UsageStatus } from "../tab";
import { clock, dateTime } from "../ui/format";

/**
 * The Usage tab's words: the status line, the banner above the tab, the
 * product amounts, and each event of Recent activity and the chart's
 * markers. Pure; times in the reader's own time zone, like the rest of the
 * spend protection pages.
 */

export type Tone = "bad" | "warn" | "muted" | "good";

/** A product's name, or the key of one this version does not know. */
export function label(key: ProductKey): string {
  return productLabel(key);
}

/**
 * Whether a product's name is plural ("Worker requests", "D1 rows read")
 * or not ("Worker CPU time", "R2 storage"), for the verb after it. A key
 * this version does not know reads as plural.
 */
export function plural(key: string): boolean {
  const name = productLabel(key);
  const last = name.split(" ").at(-1) ?? "";
  return /s$/.test(last) || /\brows\b/.test(name);
}

/** A level as "3.4 GB"; under 10, one decimal. */
function levelNumber(value: number): string {
  return value < 10 ? (Math.round(value * 10) / 10).toLocaleString("en") : count(value);
}

/** An amount of a product: "48K requests", "3.4 GB". */
export function amount(value: number, key: ProductKey): string {
  const p = PRODUCTS[key];
  return withUnit(p.measure === "level" ? levelNumber(value) : count(value), p.unit);
}

/** What it used of a product, in a sentence: "4.2M Durable Objects requests", "300 GB-s of Durable Objects duration". */
export function usedText(value: number, key: ProductKey): string {
  const p = PRODUCTS[key];
  const n = p.measure === "level" ? levelNumber(value) : count(value);
  return p.label.toLowerCase().includes(p.unit.toLowerCase())
    ? `${n} ${labelAfter(n, p.label, p.unit)}`
    : `${withUnit(n, p.unit)} of ${p.label}`;
}

const RANGE_WORDS: Record<UsageRange, string> = {
  "24h": "24 hours",
  "7d": "7 days",
  "30d": "30 days",
};

/** The chart's description for a screen reader. */
export function chartDescription(product: ProductKey, app: string, range: UsageRange): string {
  return `${label(product)} for ${app} over the last ${RANGE_WORDS[range]}. The table below has the numbers.`;
}

/** Over the chart: "48K requests in the last hour", or "3.4 GB stored". */
export function chartHeadline(p: ProductUsage): string {
  return p.level
    ? `${amount(p.lastHour, p.key)} stored`
    : `${amount(p.lastHour, p.key)} in the last hour`;
}

/** How many times its normal, short enough for a badge: "3.5×", "120×", "2.8K×". */
export function shortTimes(ratio: number): string {
  return ratio >= 1000 ? `${count(ratio)}×` : times(ratio);
}

/** "updated a minute ago", "updated 12 minutes ago", "updated at 2:05 PM". */
export function updatedText(updatedAt: number, now: number): string {
  const minutes = Math.round((now - updatedAt) / 60_000);
  if (minutes <= 1) return "updated a minute ago";
  if (minutes < 60) return `updated ${minutes} minutes ago`;
  return `updated at ${clock(updatedAt)}`;
}

/** "6 minutes", "1 minute". */
function minutesWord(ms: number): string {
  const minutes = Math.max(1, Math.round(ms / 60_000));
  return minutes === 1 ? "1 minute" : `${minutes} minutes`;
}

/** The dot and the sentence under "Usage by product". */
export function statusLine(
  status: UsageStatus,
  context: { now: number; today: (key: ProductKey) => number },
): { tone: Tone; text: string } {
  switch (status.kind) {
    case "reconnect":
      return {
        tone: "muted",
        text:
          status.via === "token"
            ? "Appflare can't read this app's usage: the Cloudflare API token lacks the usage permissions."
            : "Appflare can't read this app's usage until Cloudflare is reconnected.",
      };
    case "fresh":
      return {
        tone: "muted",
        text: `Installed ${minutesWord(context.now - status.installedAt)} ago. Cloudflare reports a new app's usage after about an hour.`,
      };
    case "empty":
      return { tone: "muted", text: "No usage recorded for this app in the last 30 days." };
    case "paused": {
      const since = `Paused since ${clock(status.pause.pausedAt)}, so no usage since.`;
      if (status.product === null) return { tone: "muted", text: since };
      const used = context.today(status.product);
      return {
        tone: "muted",
        text:
          used > 0
            ? `${since} It used ${usedText(used, status.product)} before that today.`
            : since,
      };
    }
    case "limit":
      return {
        tone: "bad",
        text: `${label(status.product)} used up today's free limit${status.loopSince === null ? "" : ` after a loop from ${clock(status.loopSince)}`}. Requests fail until 00:00 UTC.`,
      };
    case "runaway": {
      const since = status.since === null ? "" : ` since ${clock(status.since)}`;
      const ratio = status.ratio === null ? "" : `, ${shortTimes(status.ratio)} its normal`;
      const money =
        status.freeShare !== null
          ? ` At this pace it uses ${percent(status.freeShare)} of today's free ${label(status.product)}.`
          : ` About ${usd(status.burnPerHour)} an hour.`;
      return {
        tone: "bad",
        text: status.newApp
          ? status.installedRecently === true
            ? `New and already using a lot: ${productRate(status.product, status.perHour)}${since}.${money}`
            : `Already using a lot, with no usual usage to compare against yet: ${productRate(status.product, status.perHour)}${since}.${money}`
          : `Far above normal: ${productRate(status.product, status.perHour)}${since}${ratio}.${money}`,
      };
    }
    case "busy":
      return {
        tone: "warn",
        text: `Busier than usual: ${productRate(status.product, status.perHour)}, ${times(status.ratio)} its normal. Not a loop.`,
      };
    case "normal":
      return {
        tone: "good",
        text:
          status.requestsShare === null
            ? "Normal for this app. Limits and included usage are shared by every app."
            : `Normal for this app. ${percent(status.requestsShare)} of today's Worker requests in this account; limits and included usage are shared by every app.`,
      };
  }
}

export interface BannerCopy {
  variant: "error" | "alert" | "default";
  title: string;
  description: string;
  /** The banner's button: Pause for a running app, Resume for a paused one. */
  action: "pause" | "resume" | null;
}

/** What to do about a pause before resuming, by its cause. */
function fixFirst(status: Extract<UsageStatus, { kind: "paused" }>): string {
  switch (status.pause.cause?.reason) {
    case "cap":
      return "Resume it when its cap resets, or change the cap below.";
    case "budget":
      return "Resume it when the bill allows, or exempt it from the budget below.";
    default:
      return "Fix the cause first, for example by undoing the settings change that started it.";
  }
}

/** The banner above the tab for a state that needs attention; null when calm. */
export function stateBanner(status: UsageStatus, autoPause: boolean): BannerCopy | null {
  switch (status.kind) {
    case "runaway": {
      const money =
        status.freeShare !== null
          ? `At this pace it uses ${percent(status.freeShare)} of today's free ${label(status.product)}.`
          : `About ${usd(status.burnPerHour)} an hour at Cloudflare's prices, ${usd(status.spentToday)} today.`;
      const after =
        status.after === null
          ? ""
          : status.after.kind === "update"
            ? ` It started right after the update${status.after.version === null ? "" : ` to ${status.after.version}`}.`
            : " It started right after a settings change.";
      return {
        variant: "error",
        title: status.newApp
          ? `${status.installedRecently === true ? "New and already using a lot" : "Using a lot"}${status.since === null ? "" : ` since ${clock(status.since)}`}`
          : status.since === null
            ? "Far above normal"
            : `Far above normal since ${clock(status.since)}`,
        description: `${productRate(status.product, status.perHour)}. ${money}${after} Auto-pause is ${autoPause ? "on" : "off"} for this app.`,
        action: "pause",
      };
    }
    case "limit": {
      const free = `${fullCount(status.limit)} free ${label(status.product)}`;
      return {
        variant: "error",
        title: `Used up today's free ${label(status.product)}`,
        description:
          status.loopSince !== null
            ? `A loop from ${clock(status.loopSince)} used the account's ${free}. Cloudflare refuses more until 00:00 UTC, then the loop will start again. Nothing is billed on the Free plan.`
            : `This account used its ${free} for today${status.appShare === null ? "" : `, ${percent(status.appShare)} of them by this app`}. Cloudflare refuses more until 00:00 UTC. Nothing is billed on the Free plan.`,
        action: "pause",
      };
    }
    case "paused": {
      const { pause } = status;
      if (pause.by !== null) {
        const after =
          pause.loopSince === null
            ? ""
            : ` after unusual usage that began at ${clock(pause.loopSince)}`;
        return {
          variant: "alert",
          title: `Paused by ${pause.by}`,
          description: `${pause.by} paused it at ${clock(pause.pausedAt)}${after}. Visitors see a "paused" page; its data is untouched.`,
          action: "resume",
        };
      }
      const why = pause.cause === null ? null : pauseCauseSentence(pause.cause);
      return {
        variant: "alert",
        title: `Paused by Appflare at ${clock(pause.pausedAt)}`,
        description: `${why === null ? "" : `${why} `}Visitors see a "paused" page; its data is untouched. ${fixFirst(status)}`,
        action: "resume",
      };
    }
    case "busy":
      return {
        variant: "default",
        title: "Busier than usual",
        description: `${label(status.product)} ${plural(status.product) ? "have" : "has"} been well above this app's normal: ${times(status.ratio)} in the last hour. Not a loop, so nothing is paused.`,
        action: null,
      };
    default:
      return null;
  }
}

/** Spend protection settings by the names a change records. */
const SETTING_WORDS: Record<string, string> = {
  unusualFactor: "unusual usage alert",
  autoPause: "pause automatically",
  customTriggers: "own triggers",
  loop: "loop trigger",
  cap: "spending cap",
  budgetExempt: "budget exemption",
  usageAlerts: "usage alerts",
};

function sentenceCase(text: string): string {
  return text.charAt(0).toUpperCase() + text.slice(1);
}

function byWho(by: string | null): string {
  return by === null ? "by Appflare" : `by ${by}`;
}

export interface EventCopy {
  label: string;
  description: string;
  /** Alerts and pauses stand out in the list and on the chart. */
  alert: boolean;
}

/** One event as Recent activity and the chart's markers say it. */
export function eventCopy(
  event: UsageEvent,
  /** The channels usage alerts go to; null when the viewer may not see them. */
  channels: readonly string[] | null = null,
): EventCopy {
  switch (event.kind) {
    case "installed":
      return {
        label: "Installed",
        description:
          event.from === "catalog"
            ? "From the catalog"
            : event.from === "repository"
              ? "From a repository"
              : "Built from source",
        alert: false,
      };
    case "updated":
      return {
        label: event.version === null ? "Updated" : `Updated to ${event.version}`,
        description: event.automatic ? "Automatic update" : "By an admin",
        alert: false,
      };
    case "rolled_back":
      return {
        label: event.version === null ? "Rolled back" : `Rolled back to ${event.version}`,
        description: "By an admin",
        alert: false,
      };
    case "app_settings":
      return {
        label: "Settings changed",
        description:
          event.changes.length > 0
            ? sentenceCase(listWords(event.changes))
            : event.automatic
              ? "Deployed again by Appflare"
              : "The app's settings, saved and deployed",
        alert: false,
      };
    case "unusual_started": {
      const lot =
        event.installedRecently === true
          ? "a lot for a new app, with no usual week yet to compare with."
          : "a lot, with no usual usage to compare against yet.";
      const what = event.newApp
        ? event.product !== null
          ? `${productLabel(event.product)}: ${lot}`
          : `${lot.charAt(0).toUpperCase()}${lot.slice(1)}`
        : event.product !== null && event.times !== null
          ? `${productLabel(event.product)} at about ${times(event.times)} this app's normal.`
          : "Far above this app's normal.";
      const sent =
        channels !== null && channels.length > 0 ? ` Sent to ${listWords([...channels])}.` : "";
      return { label: "Unusual usage", description: `${what}${sent}`, alert: true };
    }
    case "unusual_ended":
      return {
        label: "Back to normal",
        description: `The unusual usage from ${clock(event.startedAt)} ended.`,
        alert: false,
      };
    case "alert_sent":
      return { label: "Usage alert sent", description: `${event.sentence}.`, alert: true };
    case "limit_near": {
      const product = productLabel(event.product);
      if (event.share >= 1 || event.runsOutAt === null) {
        return {
          label: "Free limit used up",
          description: `Today's free ${product} ${plural(event.product) ? "are" : "is"} used up.`,
          alert: true,
        };
      }
      return {
        label: "Free limit running low",
        description: `Today's free ${product} ${plural(event.product) ? "run" : "runs"} out around ${clock(event.runsOutAt)}.`,
        alert: true,
      };
    }
    case "paused":
      if (event.by !== null) {
        return {
          label: `Paused by ${event.by}`,
          description: "Visitors see a “paused” page.",
          alert: true,
        };
      }
      return {
        label: "Paused automatically",
        description:
          (event.cause === null ? null : pauseCauseSentence(event.cause)) ?? "Appflare paused it.",
        alert: true,
      };
    case "resumed":
      return {
        label: event.by === null ? "Resumed" : `Resumed by ${event.by}`,
        description:
          event.by === null
            ? "Appflare put back a pause that could not finish."
            : "The loop check still runs.",
        alert: false,
      };
    case "pause_failed":
      return { label: "Pause failed", description: event.error, alert: true };
    case "resume_failed":
      return { label: "Resume failed", description: event.error, alert: true };
    case "settings_changed": {
      if (event.alert !== null) {
        return {
          label: `Usage alert ${event.alert.change}`,
          description: `${event.alert.sentence}, ${byWho(event.by)}.`,
          alert: false,
        };
      }
      const names = event.changed.map((name) => SETTING_WORDS[name] ?? name);
      return {
        label: "Spend protection changed",
        description: `${sentenceCase(listWords(names))}, ${byWho(event.by)}.`,
        alert: false,
      };
    }
    case "cap_set_aside":
      return {
        label: "Cap set aside",
        description: `Until ${dateTime(event.until)}, ${byWho(event.by)}.`,
        alert: false,
      };
    case "observability_changed":
      return {
        label: event.enabled ? "Workers Logs turned on" : "Workers Logs turned off",
        description: `${sentenceCase(byWho(event.by))}.`,
        alert: false,
      };
  }
}

/** Events that mark the chart: updates, settings changes, alerts, pauses and resumes. */
export function isMarker(event: UsageEvent): boolean {
  return event.kind !== "installed" && event.kind !== "observability_changed";
}
