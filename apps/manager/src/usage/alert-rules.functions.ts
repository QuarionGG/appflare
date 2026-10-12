import { env } from "cloudflare:workers";
import { createServerFn } from "@tanstack/react-start";
import { createDb } from "../db/client";
import { requireRole } from "../server/auth.server";
import { createAlertRuleInput, deleteAlertRuleInput, updateAlertRuleInput } from "./alert-rules";
import {
  AlertRuleError,
  addAlertRule,
  changeAlertRule,
  removeAlertRule,
} from "./alert-rules.server";
import type { UsageTabData } from "./tab";
import { readTabFor } from "./tab.server";

/**
 * An app's usage alerts on its Usage tab. Admin only; each change is
 * recorded in the app's activity, and answers with the tab read again.
 */

/** A refusal reads as the sentence it carries; anything else as it is. */
async function asUserError(change: () => Promise<unknown>): Promise<void> {
  try {
    await change();
  } catch (error) {
    if (error instanceof AlertRuleError) throw new Error(error.message);
    throw error;
  }
}

export const createAlertRuleFn = createServerFn({ method: "POST" })
  .validator(createAlertRuleInput)
  .handler(async ({ data }): Promise<UsageTabData | null> => {
    const session = await requireRole("admin");
    await asUserError(() =>
      addAlertRule(createDb(env.DB), data.installId, data.rule, { userId: session.user.id }),
    );
    return readTabFor(data.installId, true);
  });

export const updateAlertRuleFn = createServerFn({ method: "POST" })
  .validator(updateAlertRuleInput)
  .handler(async ({ data }): Promise<UsageTabData | null> => {
    const session = await requireRole("admin");
    await asUserError(() =>
      changeAlertRule(createDb(env.DB), data.installId, data.ruleId, data.rule, {
        userId: session.user.id,
      }),
    );
    return readTabFor(data.installId, true);
  });

export const deleteAlertRuleFn = createServerFn({ method: "POST" })
  .validator(deleteAlertRuleInput)
  .handler(async ({ data }): Promise<UsageTabData | null> => {
    const session = await requireRole("admin");
    await asUserError(() =>
      removeAlertRule(createDb(env.DB), data.installId, data.ruleId, {
        userId: session.user.id,
      }),
    );
    return readTabFor(data.installId, true);
  });
