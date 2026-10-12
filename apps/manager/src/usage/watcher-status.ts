import { z } from "zod";
import type { Database } from "../db/client";
import { readSettings, SETTING, writeSettings } from "../db/settings";

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

export async function writeSpendWatchStatus(db: Database, status: SpendWatchStatus): Promise<void> {
  await writeSettings(
    db,
    { [SETTING.spendWatch]: JSON.stringify(spendWatchStatusSchema.parse(status)) },
    new Date(status.at),
  );
}
