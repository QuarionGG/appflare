import { z } from "zod";

/**
 * Words and inputs of an app's Workers Logs switch (Cloudflare's Workers
 * Observability), shared by the server and the pages. Client-safe.
 */

export const setObservabilityInput = z.object({
  installId: z.string().min(1),
  enabled: z.boolean(),
});
export type SetObservabilityInput = z.infer<typeof setObservabilityInput>;

export const readObservabilityInput = z.object({ installId: z.string().min(1) });

export const OBSERVABILITY_MESSAGES = {
  /** Cloudflare refused to read or change the setting (an API token's words). */
  permission:
    "Cloudflare refused the Workers Logs settings: the token needs Workers Scripts: Edit. Add it to the token in the Cloudflare dashboard, then try again.",
  noInstall: "There is no such app.",
  notInstalled: "Workers Logs can be turned on or off once the app is installed.",
  jobRunning: "Wait for the running job to finish, then try again.",
  /** Some Workers were changed before a refusal. */
  partlyChanged: (done: readonly string[]) =>
    `Workers Logs are changed for ${done.join(", ")} already.`,
  /** A Worker of the app is not in the account any more. */
  workerGone: (workerName: string) =>
    `The Worker ${workerName} is not in the Cloudflare account any more, so its Workers Logs cannot be changed.`,
  /** Cloudflare refused or failed the change for one Worker; `done` were changed before it. */
  changeFailed: (workerName: string, said: string, done: readonly string[]) =>
    `Cloudflare did not change Workers Logs for ${workerName} (${said}).${
      done.length === 0 ? "" : ` Workers Logs are changed for ${done.join(", ")} already.`
    } Try again.`,
  /** One Worker's setting could not be read. */
  readFailed: (workerName: string, said: string) =>
    `Appflare could not read whether Workers Logs are on for ${workerName} (${said}).`,
} as const;
