import { env } from "cloudflare:workers";
import { createServerFn } from "@tanstack/react-start";
import { requireRole, requireSession } from "../server/auth.server";
import {
  emdashUpgradeInstallInput,
  mergeEmdashUpgradeInput,
  prepareEmdashUpgradeInput,
} from "./emdash-upgrades";
import {
  checkEmdashUpgradeCore,
  emdashUpgradeDeps,
  emdashUpgradeForBuild,
  latestEmdashUpgrade,
  mergeAndBuildEmdashUpgradeCore,
  prepareEmdashUpgradeCore,
} from "./emdash-upgrades.server";
import { sourceBuildIdInput } from "./source-build-input";

export const checkEmdashUpgrade = createServerFn({ method: "POST" })
  .validator(emdashUpgradeInstallInput)
  .handler(async ({ data }) => {
    await requireRole("admin");
    return checkEmdashUpgradeCore(emdashUpgradeDeps(env), data.installId);
  });

export const prepareEmdashUpgrade = createServerFn({ method: "POST" })
  .validator(prepareEmdashUpgradeInput)
  .handler(async ({ data }) => {
    await requireRole("admin");
    return prepareEmdashUpgradeCore(emdashUpgradeDeps(env), data);
  });

export const mergeAndBuildEmdashUpgrade = createServerFn({ method: "POST" })
  .validator(mergeEmdashUpgradeInput)
  .handler(async ({ data }) => {
    await requireRole("admin");
    return mergeAndBuildEmdashUpgradeCore(emdashUpgradeDeps(env), data);
  });

/** Build reviews are readable by members; only preparation and merging need admin access. */
export const getEmdashUpgradeForBuild = createServerFn({ method: "GET" })
  .validator(sourceBuildIdInput)
  .handler(async ({ data }) => {
    await requireSession();
    return emdashUpgradeForBuild(env.DB, data.buildId);
  });

export const getLatestEmdashUpgrade = createServerFn({ method: "GET" })
  .validator(emdashUpgradeInstallInput)
  .handler(async ({ data }) => {
    await requireSession();
    return latestEmdashUpgrade(env.DB, data.installId);
  });
