import {
  CloudflareApiError,
  type CloudflareClient,
  type ScriptMetadata,
  type WorkerObservability,
} from "@appflare/cf-api";

/**
 * Workers Logs (Cloudflare's Workers Observability) of an app's Workers,
 * carried through every deploy.
 *
 * The setting is not part of a Worker version: Cloudflare keeps it per
 * script, and an admin turns it on or off per app. A full upload
 * (`PUT /workers/scripts/{name}`) whose metadata has no `observability`
 * turns it off again, so every upload Appflare makes reads the script's
 * current setting from Cloudflare first and sends exactly that. Appflare
 * keeps no copy of its own: Cloudflare's answer is the truth, also after a
 * change in the Cloudflare dashboard. A version upload ignores the field
 * (it keeps what the script has), and gets the same block all the same, so
 * no upload path depends on that.
 *
 * What Cloudflare answers, seen live on a Workers Free account (2026-10-12):
 * `null` for a script that never had the setting; after
 * `PATCH .../script-settings` `{ observability: { enabled: true } }` the
 * whole block (`enabled`, `head_sampling_rate`, `logs`, `traces`, ...) with
 * `logs.enabled` true, and after `{ enabled: false }` `null` again; a full
 * upload that sends that block back keeps it as it was, one without it
 * leaves `null`; a version upload and its deployment leave it alone, even
 * when the version's metadata says otherwise; a script that does not exist
 * answers 404 (code 10007).
 */

export type WorkersApi = Pick<CloudflareClient, "workers">;

/**
 * The `observability` block an upload sends: what Cloudflare reports for the
 * script (`WorkerObservability`, every field of it), or the manifest's.
 */
export type ObservabilityBlock = NonNullable<ScriptMetadata["observability"]>;

/** Whether a script's settings mean Workers Logs are on: on, and its logs not turned off. */
export function workersLogsOn(observability: WorkerObservability | null | undefined): boolean {
  return observability?.enabled === true && observability.logs?.enabled !== false;
}

/**
 * Why a deploy stopped before it uploaded anything: the script's Workers
 * Logs setting could not be read, and an upload without it would turn
 * Workers Logs off.
 */
export function observabilityReadSubject(scriptName: string): string {
  return `Appflare could not read whether Workers Logs are on for ${scriptName}, and deploying it without that setting would turn them off, so nothing was deployed`;
}

/**
 * A failed read of a script's Workers Logs setting. `cause` is the error the
 * read failed with (a `CloudflareApiError` for an answer), so a caller can
 * retry what is worth retrying (429, 5xx) and stop on the rest.
 */
export class ObservabilityReadError extends Error {
  override name = "ObservabilityReadError";
  readonly subject: string;

  constructor(
    readonly scriptName: string,
    override readonly cause: unknown,
  ) {
    const subject = observabilityReadSubject(scriptName);
    super(`${subject} (${cause instanceof Error ? cause.message : String(cause)})`);
    this.subject = subject;
  }
}

/**
 * The `observability` block an upload of `scriptName` sends:
 *
 * - for a script that exists, exactly what Cloudflare reports for it (null
 *   for one that never had the setting: the upload then sends none, which
 *   keeps it that way);
 * - for a script that does not exist yet, `whenNew` (the app's own setting,
 *   from its manifest), or null for none.
 *
 * Throws {@link ObservabilityReadError} when Cloudflare does not answer with
 * the setting: deploying without it would turn Workers Logs off.
 */
export async function observabilityToCarry(
  api: WorkersApi,
  scriptName: string,
  whenNew: ObservabilityBlock | null | undefined,
): Promise<ObservabilityBlock | null> {
  try {
    const settings = await api.workers.getScriptSettings(scriptName);
    return settings.observability ?? null;
  } catch (error) {
    // The script does not exist (yet): it gets the app's own setting.
    if (error instanceof CloudflareApiError && error.status === 404) return whenNew ?? null;
    throw new ObservabilityReadError(scriptName, error);
  }
}

/**
 * `metadata` with the `observability` block an upload of `scriptName` must
 * send ({@link observabilityToCarry}). The block `metadata` already has is
 * what a new script gets; for an existing one it is replaced by the
 * script's own, or left out when the script never had the setting.
 */
export async function withCarriedObservability<M extends ScriptMetadata>(
  api: WorkersApi,
  scriptName: string,
  metadata: M,
): Promise<M> {
  const { observability: whenNew, ...rest } = metadata;
  const carried = await observabilityToCarry(api, scriptName, whenNew);
  return (carried === null ? rest : { ...rest, observability: carried }) as M;
}
