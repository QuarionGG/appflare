import { env } from "cloudflare:workers";
import { createServerFn } from "@tanstack/react-start";
import { createDb } from "../db/client";
import { requireRole, requireSession } from "../server/auth.server";
import { setAppSpendInput } from "./app-spend";
import { AppSpendError, changeAppSpendSettings } from "./app-spend.server";
import type { UsageTabData } from "./tab";
import { usageTabInput } from "./tab";
import { readTabFor } from "./tab.server";

/**
 * An app's Usage tab: its usage and spend protection, read by anyone signed
 * in (members see it all, unchangeable), and its spend protection settings
 * changed by an admin. Each change answers with the tab read again, so the
 * page shows the effect at once.
 */

export const getUsageTab = createServerFn({ method: "GET" })
  .validator(usageTabInput)
  .handler(async ({ data }): Promise<UsageTabData | null> => {
    const session = await requireSession();
    return readTabFor(data.installId, session.user.role === "admin");
  });

/** Admin only: changes part of the app's spend protection, recorded in its activity. */
export const setAppSpend = createServerFn({ method: "POST" })
  .validator(setAppSpendInput)
  .handler(async ({ data }): Promise<UsageTabData | null> => {
    const session = await requireRole("admin");
    try {
      await changeAppSpendSettings(createDb(env.DB), data.installId, data.patch, {
        userId: session.user.id,
      });
    } catch (error) {
      if (error instanceof AppSpendError) throw new Error(error.message);
      throw error;
    }
    return readTabFor(data.installId, true);
  });
