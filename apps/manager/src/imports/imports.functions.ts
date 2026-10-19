import { env } from "cloudflare:workers";
import { createServerFn } from "@tanstack/react-start";
import { getCfClient } from "../cloudflare/client.server";
import { requireRole, requireSession } from "../server/auth.server";
import {
  discoverImportWorkersCore,
  forgetImportedAppCore,
  getImportedAppCore,
  importExistingAppCore,
  listImportedAppsCore,
  previewImportCore,
  refreshImportedAppCore,
} from "./imports.server";
import { importAppIdInput, importCommitInput, importSelectionInput } from "./input";

export type {
  ImportCandidate,
  ImportDiscovery,
  ImportedApp,
  ImportedBinding,
  ImportedDeployment,
  ImportedDomain,
  ImportedWorker,
  ImportPreview,
  ImportRoute,
  ImportSelection,
} from "./types";

export const listImportedApps = createServerFn({ method: "GET" }).handler(async () => {
  await requireSession();
  return listImportedAppsCore(env.DB);
});

export const getImportedApp = createServerFn({ method: "GET" })
  .validator(importAppIdInput)
  .handler(async ({ data }) => {
    await requireSession();
    return getImportedAppCore(env.DB, data.appId);
  });

export const discoverImportWorkers = createServerFn({ method: "GET" }).handler(async () => {
  await requireRole("admin");
  return discoverImportWorkersCore({ db: env.DB, api: await getCfClient(env) });
});

export const previewImport = createServerFn({ method: "POST" })
  .validator(importSelectionInput)
  .handler(async ({ data }) => {
    await requireRole("admin");
    return previewImportCore({ db: env.DB, api: await getCfClient(env) }, data);
  });

export const importExistingApp = createServerFn({ method: "POST" })
  .validator(importCommitInput)
  .handler(async ({ data }) => {
    await requireRole("admin");
    return importExistingAppCore({ db: env.DB, api: await getCfClient(env) }, data);
  });

export const refreshImportedApp = createServerFn({ method: "POST" })
  .validator(importAppIdInput)
  .handler(async ({ data }) => {
    await requireRole("admin");
    return refreshImportedAppCore({ db: env.DB, api: await getCfClient(env) }, data.appId);
  });

export const forgetImportedApp = createServerFn({ method: "POST" })
  .validator(importAppIdInput)
  .handler(async ({ data }) => {
    await requireRole("admin");
    return forgetImportedAppCore(env.DB, data.appId);
  });
