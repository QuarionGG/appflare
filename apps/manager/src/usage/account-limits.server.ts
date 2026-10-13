import type { Database } from "../db/client";
import { deliverRecordedEvent, emitUsageEvent } from "../notifications/usage-events.server";
import { accountLimitDecisions, accountLimitsNear } from "./account-limits";
import { dayStart, type Usage } from "./math";
import { listActivity, recordActivity } from "./store/activity.server";
import type { SpendWatchDeps, SpendWatchEnv, SpendWatchReport } from "./watcher-judge.server";

/**
 * Workers Free: the account-level warning that the whole account is near a
 * free daily limit (account-limits.ts), recorded as an account-level
 * `limit_near` entry (no install) and sent as `usage_account_limit`. Run
 * once per check by the invocation that works out the account's numbers,
 * before the apps are judged.
 *
 * Each warning goes into the outbox as soon as its entry is recorded, so it
 * is sent even if judging the apps fails afterwards (the scheduled run
 * delivers it); only asking the delivery unit to send it at once waits until
 * after the apps are judged ({@link deliverAccountLimitEvents}), so a pause
 * never waits for a subrequest a message took.
 *
 * Returns the products the account was warned about today (from today's
 * recorded entries, even when this check has no reading or fails partway),
 * whose app warnings skip the channels that get the account's, and the
 * outbox events to send at once. Never throws.
 */
export async function checkAccountLimits(
  env: SpendWatchEnv,
  db: Database,
  input: {
    now: number;
    /** The watcher's reading of the whole account today (account-day.ts); null without one. */
    accountToday: Readonly<Record<string, number>> | null;
    /** Every install's usage, removed ones included. */
    usage: ReadonlyMap<string, Usage>;
    /** The installs not removed: the ones a warning may name. */
    listed: ReadonlySet<string>;
  },
  deps: SpendWatchDeps,
  report: SpendWatchReport,
): Promise<{ covered: Set<string>; deliver: string[] }> {
  const { now } = input;
  const covered = new Set<string>();
  const deliver: string[] = [];
  try {
    const entries = await listActivity(db, {
      since: new Date(dayStart(now)),
      kinds: ["limit_near"],
      limit: 200,
    });
    // Newest first: the first account entry of a product is its latest.
    const accountShares = new Map<string, number>();
    const appWarned = new Set<string>();
    for (const entry of entries) {
      if (entry.kind !== "limit_near") continue;
      const { product, share } = entry.facts;
      if (entry.installId !== null) appWarned.add(product);
      else if (!accountShares.has(product)) accountShares.set(product, share);
    }
    for (const product of accountShares.keys()) covered.add(product);
    if (input.accountToday === null) return { covered, deliver };
    const decisions = accountLimitDecisions(
      accountLimitsNear({
        now,
        accountToday: input.accountToday,
        usage: input.usage,
        listed: input.listed,
      }),
      { accountShares, appWarned },
    );
    const emit = deps.emit ?? emitUsageEvent;
    for (const { near, message, appFirst } of decisions.records) {
      await recordActivity(db, {
        installId: null,
        kind: "limit_near",
        facts: {
          product: near.product,
          share: near.share,
          runsOutAt: null,
          account: true,
          used: near.used,
          limit: near.limit,
          otherShare: near.otherShare,
          ...(near.top === null
            ? {}
            : { topInstallId: near.top.installId, topShare: near.top.share }),
        },
        at: new Date(now),
      });
      covered.add(near.product);
      if (!message) continue;
      report.alerts += 1;
      // Into the outbox now (no `SELF`: nothing is sent yet); the dedupe key
      // keeps a retried check from recording it twice.
      const outcome = await emit(
        { DB: env.DB },
        {
          type: "usage_account_limit",
          product: near.product,
          limit: near.limit,
          used: near.used,
          otherShare: near.otherShare,
          top: near.top,
          // Channels that already heard an app's warning about it today.
          ...(appFirst ? { exceptChannelsWith: "usage_limit_near" as const } : {}),
        },
        { now: () => now },
      );
      if (outcome.status === "queued" && outcome.queued > 0) deliver.push(outcome.eventId);
    }
    return { covered, deliver };
  } catch (error) {
    console.error("spend watcher: the account's free daily limits not checked", {
      error: error instanceof Error ? error.message : String(error),
    });
    return { covered, deliver };
  }
}

/**
 * Asks the delivery unit to send the account warnings now in the outbox, at
 * once while the check has a subrequest to spare; the scheduled run sends
 * the rest. Called after the apps are judged.
 */
export async function deliverAccountLimitEvents(
  env: SpendWatchEnv,
  eventIds: readonly string[],
  /** Subrequests the check may make in all; sending at once takes one. */
  budget: number,
  report: SpendWatchReport,
): Promise<void> {
  for (const eventId of eventIds) {
    if (report.subrequests + 1 > budget) {
      report.deferred += 1;
      continue;
    }
    if (await deliverRecordedEvent({ DB: env.DB, SELF: env.SELF }, eventId)) {
      report.subrequests += 1;
    }
  }
}
