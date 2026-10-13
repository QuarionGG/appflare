import { z } from "zod";
import type { Database } from "../db/client";
import { readSettings, SETTING, type SettingKey, writeSettings } from "../db/settings";

/**
 * The spend watcher's last check, as the pages read it (`settings.spend_watch`):
 *
 * - `watching`: usage was read and judged at `at`;
 * - `needs_access`: the Cloudflare connection may not read usage. `via`
 *   `oauth`: the sign-in predates the analytics permissions (`missing` lists
 *   the OAuth scopes); `token`: the API token lacks "Account Analytics".
 *   Pages show "Reconnect to see usage"; nothing is collected or judged
 *   until a check succeeds again;
 * - `failed`: the check failed for another reason (`error`); the next one
 *   tries again, and the stored usage stays as it was.
 *
 * Absent until the first check. `at` is epoch ms.
 */

export const spendWatchStatusSchema = z.discriminatedUnion("state", [
  z.object({ state: z.literal("watching"), at: z.number().int() }),
  z.object({
    state: z.literal("needs_access"),
    at: z.number().int(),
    via: z.enum(["oauth", "token"]),
    missing: z.array(z.string()),
  }),
  z.object({ state: z.literal("failed"), at: z.number().int(), error: z.string() }),
]);
export type SpendWatchStatus = z.infer<typeof spendWatchStatusSchema>;

/** The last check's status, or null before the first (or when unreadable). */
export async function readSpendWatchStatus(db: Database): Promise<SpendWatchStatus | null> {
  const raw = (await readSettings(db, [SETTING.spendWatch]))[SETTING.spendWatch];
  if (raw === undefined) return null;
  try {
    return spendWatchStatusSchema.safeParse(JSON.parse(raw)).data ?? null;
  } catch {
    return null;
  }
}

/**
 * Stores the status, and in the same statement any other `settings` rows the
 * check stores with it. When that statement fails, the status is stored on
 * its own (a row stored with it must not cost the status), and what failed
 * is returned as `alongsideError`. Throws when the status itself cannot be
 * stored.
 */
export async function writeSpendWatchStatus(
  db: Database,
  status: SpendWatchStatus,
  alongside: Partial<Record<SettingKey, string>> = {},
): Promise<{ alongsideError?: unknown }> {
  const at = new Date(status.at);
  const text = statusText(status);
  if (Object.keys(alongside).length === 0) {
    await writeSettings(db, { [SETTING.spendWatch]: text }, at);
    return {};
  }
  try {
    await writeSettings(db, { ...alongside, [SETTING.spendWatch]: text }, at);
    return {};
  } catch (alongsideError) {
    await writeSettings(db, { [SETTING.spendWatch]: text }, at);
    return { alongsideError };
  }
}

/**
 * The stored text of a status: what `JSON.stringify(spendWatchStatusSchema.parse(status))`
 * gives (throws on what the schema refuses), without Zod, whose first parse in an
 * isolate costs milliseconds of a Workers Free run. A test holds the two to the same result.
 */
export function statusText(status: SpendWatchStatus): string {
  const fail = (what: string): never => {
    throw new Error(`Invalid spend watcher status: ${what}`);
  };
  if (!Number.isInteger(status.at)) fail("at is not an integer");
  switch (status.state) {
    case "watching":
      return JSON.stringify({ state: status.state, at: status.at });
    case "needs_access":
      if (status.via !== "oauth" && status.via !== "token") fail("via");
      if (!Array.isArray(status.missing) || status.missing.some((m) => typeof m !== "string")) {
        fail("missing");
      }
      return JSON.stringify({
        state: status.state,
        at: status.at,
        via: status.via,
        missing: [...status.missing],
      });
    case "failed":
      if (typeof status.error !== "string") fail("error");
      return JSON.stringify({ state: status.state, at: status.at, error: status.error });
    default:
      return fail("state");
  }
}
