import { env } from "cloudflare:workers";
import { createServerFn } from "@tanstack/react-start";
import { createDb } from "../db/client";
import { requireRole, requireSession } from "../server/auth.server";
import type { SpendOverview } from "./overview";
import { readSpendOverview } from "./overview.server";
import { setSpendDefaultsInput } from "./spend-defaults";
import { changeSpendDefaults } from "./spend-defaults.server";
import type { SpendDefaults } from "./store/spend-settings";

/** Settings → Your account → Spend protection: the account's defaults and where apps stand. */

export interface SpendProtectionData {
  defaults: SpendDefaults;
  overview: SpendOverview;
}

/** Any signed-in user: members see the defaults and the numbers read-only. */
export const getSpendProtection = createServerFn({ method: "GET" }).handler(
  async (): Promise<SpendProtectionData> => {
    await requireSession();
    return readSpendOverview(env.DB);
  },
);

/** Admin only: changes one or more of the defaults, recorded in the account's usage activity. */
export const setSpendDefaults = createServerFn({ method: "POST" })
  .validator(setSpendDefaultsInput)
  .handler(async ({ data }): Promise<SpendDefaults> => {
    const session = await requireRole("admin");
    return changeSpendDefaults(createDb(env.DB), data, { userId: session.user.id });
  });
