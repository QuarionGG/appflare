import { env } from "cloudflare:workers";
import { createServerFn } from "@tanstack/react-start";
import { eq } from "drizzle-orm";
import { getCfClient } from "../cloudflare/client.server";
import { createDb } from "../db/client";
import { install_adoptions } from "../db/schema";
import { requireRole, requireSession } from "../server/auth.server";
import { adoptImportedAppCore, previewAdoptionCore } from "./adoptions.server";
import { adoptionCommitInput, adoptionInput } from "./adoptions-input";
import { importAppIdInput } from "./input";

export const previewAdoption = createServerFn({ method: "POST" })
  .validator(adoptionInput)
  .handler(async ({ data }) => {
    await requireRole("admin");
    return previewAdoptionCore({ db: env.DB, api: await getCfClient(env) }, data);
  });

export const adoptImportedApp = createServerFn({ method: "POST" })
  .validator(adoptionCommitInput)
  .handler(async ({ data }) => {
    await requireRole("admin");
    return adoptImportedAppCore({ db: env.DB, api: await getCfClient(env) }, data);
  });

/** An old imported-app bookmark follows the existing installation after adoption. */
export const getAdoptedInstall = createServerFn({ method: "GET" })
  .validator(importAppIdInput)
  .handler(async ({ data }) => {
    await requireSession();
    const [row] = await createDb(env.DB)
      .select({ installId: install_adoptions.install_id })
      .from(install_adoptions)
      .where(eq(install_adoptions.imported_app_id, data.appId))
      .limit(1);
    return row ?? null;
  });
