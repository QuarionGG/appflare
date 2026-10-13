import { env } from "cloudflare:workers";
import { createServerFn } from "@tanstack/react-start";
import { CfTokenNotConfiguredError, getCfClient } from "../cloudflare/client.server";
import { requireRole, requireSession } from "../server/auth.server";
import {
  type AppObservability,
  ObservabilityError,
  readAppObservability,
  setAppObservability,
} from "./observability.server";
import { readObservabilityInput, setObservabilityInput } from "./observability-copy";

/** Errors the admin can act on, as plain errors with their words; others as they are. */
function plain(error: unknown): unknown {
  return error instanceof ObservabilityError || error instanceof CfTokenNotConfiguredError
    ? new Error(error.message)
    : error;
}

/** Whether Workers Logs are on for an app, per Worker, read from Cloudflare. Members may read it. */
export const getObservabilityFn = createServerFn({ method: "GET" })
  .validator(readObservabilityInput)
  .handler(async ({ data }): Promise<AppObservability> => {
    await requireSession();
    try {
      return await readAppObservability(
        { db: env.DB, api: () => getCfClient(env) },
        data.installId,
      );
    } catch (error) {
      throw plain(error);
    }
  });

/**
 * Admin only: turns Workers Logs on or off for every Worker of an app, and
 * records the change in the app's activity.
 */
export const setObservabilityFn = createServerFn({ method: "POST" })
  .validator(setObservabilityInput)
  .handler(async ({ data }): Promise<AppObservability> => {
    const session = await requireRole("admin");
    try {
      return await setAppObservability(
        { db: env.DB, api: () => getCfClient(env) },
        { ...data, by: session.user.id },
      );
    } catch (error) {
      throw plain(error);
    }
  });
