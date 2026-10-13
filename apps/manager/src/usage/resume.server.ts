import type { Read } from "../db/batch";
import type { Database } from "../db/client";
import {
  HOUR_MS,
  hourStart,
  type ResumeWindow,
  resumeBase,
  resumeMatters,
  type Usage,
} from "./math";
import { latestResumes, latestResumesRead } from "./store/pauses.server";

/**
 * The resume windows of the apps resumed lately (math/resume.ts): the loop
 * check and unusual usage judge such an app only on what it did after the
 * resume. Usage is kept by the hour, so each window needs how much the
 * resume hour held at the resume: the first check after it takes that from
 * the rows the last check before it stored (while the app was paused),
 * keeps it in KV, and the checks after read it back. Without such a row, or
 * without KV, the resume hour's value as it is now counts as from before
 * the resume, so nothing used before it is ever taken for after it.
 */

/** The latest resume of each app resumed in the last 3 hours (more than any window needs). */
export function recentResumes(db: Database, now: number): Promise<Map<string, number>> {
  return latestResumes(db, new Date(now - 3 * HOUR_MS));
}

/** {@link recentResumes} as a read that can share a round trip with others (db/batch.ts). */
export function recentResumesRead(db: Database, now: number): Read<Map<string, number>> {
  return latestResumesRead(db, new Date(now - 3 * HOUR_MS));
}

/** KV key of an install's resume base. */
export function resumeBaseKey(installId: string): string {
  return `usage:resume-base:${installId}`;
}

/** Long enough for the windows it serves (they end two hours after the resume hour began). */
const BASE_TTL_SECONDS = 3 * 60 * 60;

interface StoredBase {
  at: number;
  base: ResumeWindow["base"];
}

/** Whether `usage` holds a row of the hour `at` falls in, for some product. */
function hasHour(usage: Usage, at: number): boolean {
  const hour = hourStart(at);
  return Object.values(usage).some((series) => series?.some((p) => p.hour === hour) === true);
}

function parseBase(raw: string | null): StoredBase | null {
  if (raw === null) return null;
  try {
    const value = JSON.parse(raw) as Partial<StoredBase>;
    if (typeof value.at !== "number" || typeof value.base !== "object" || value.base === null) {
      return null;
    }
    return { at: value.at, base: value.base };
  } catch {
    return null;
  }
}

/**
 * The resume windows of `installIds` at `now`, from their usage. `keep`
 * stores the base of a resume seen for the first time (the watcher's
 * judging does; the pages' numbers only read). Never throws: a KV failure
 * leaves the base to the usage as it is now.
 */
export async function resumeWindows(
  db: Database,
  kv: KVNamespace | undefined,
  input: {
    now: number;
    installIds: readonly string[];
    usage: ReadonlyMap<string, Usage>;
    /**
     * The hourly rows as stored before this check wrote any: at the first
     * check after a resume, what the last check before it (while the app
     * was paused) stored.
     */
    before?: ReadonlyMap<string, Usage>;
    /** The latest resumes ({@link recentResumes}), when read already in another round. */
    resumes?: ReadonlyMap<string, number>;
    keep: boolean;
  },
): Promise<Map<string, ResumeWindow>> {
  const { now } = input;
  const out = new Map<string, ResumeWindow>();
  const wanted = new Set(input.installIds);
  if (wanted.size === 0) return out;
  const resumes = input.resumes ?? (await recentResumes(db, now));
  for (const [installId, at] of resumes) {
    if (!wanted.has(installId) || !resumeMatters(at, now)) continue;
    let stored: StoredBase | null = null;
    if (kv !== undefined) {
      try {
        stored = parseBase(await kv.get(resumeBaseKey(installId)));
      } catch (error) {
        console.warn("spend watcher: resume base not read", {
          installId,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }
    if (stored !== null && stored.at === at) {
      out.set(installId, { at, base: stored.base });
      continue;
    }
    // Seen for the first time: the resume hour as the last check before the
    // resume stored it (the app was paused then), so nothing it used after
    // the resume is taken for before. Without a stored row of that hour, the
    // hour as it is now.
    const earlier = input.before?.get(installId);
    const base =
      earlier !== undefined && hasHour(earlier, at)
        ? resumeBase(earlier, at)
        : resumeBase(input.usage.get(installId) ?? {}, at);
    out.set(installId, { at, base });
    if (input.keep && kv !== undefined) {
      try {
        await kv.put(resumeBaseKey(installId), JSON.stringify({ at, base } satisfies StoredBase), {
          expirationTtl: BASE_TTL_SECONDS,
        });
      } catch (error) {
        console.warn("spend watcher: resume base not kept", {
          installId,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }
  }
  return out;
}
