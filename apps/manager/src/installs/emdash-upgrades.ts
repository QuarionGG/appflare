import { type EmdashUpgradeReport, gitShaSchema } from "@appflare/schema";
import { z } from "zod";

export const emdashUpgradeInstallInput = z.object({ installId: z.string().min(1).max(64) });
export const prepareEmdashUpgradeInput = emdashUpgradeInstallInput.extend({
  expectedBaseSha: gitShaSchema,
  targetVersion: z.string().regex(/^\d+\.\d+\.\d+$/),
  costConfirmed: z.boolean(),
});
export const mergeEmdashUpgradeInput = z.object({
  upgradeId: z.string().min(1).max(64),
  costConfirmed: z.boolean(),
});

export interface EmDashUpgradePlan {
  supported: boolean;
  reason: string | null;
  installedVersion: string | null;
  sourceVersion: string | null;
  targetVersion: string | null;
  baseSha: string | null;
  repo: string | null;
  upToDate: boolean;
  writeTokenAvailable: boolean;
  plugins: Array<{ name: string; version: string }>;
}

export interface EmDashUpgradeView {
  id: string;
  installId: string;
  repo: string;
  baseRef: string;
  baseSha: string;
  targetVersion: string;
  status: "preparing" | "pr_open" | "building" | "ready" | "merged" | "failed";
  preparationJobId: string;
  buildId: string | null;
  branch: string | null;
  headSha: string | null;
  prNumber: number | null;
  prUrl: string | null;
  mergeSha: string | null;
  mergedBuildId: string | null;
  error: string | null;
  report: EmdashUpgradeReport | null;
}

/** Stable release versions are the only ones an unattended preparation may select. */
export function stableVersion(value: unknown): string | null {
  return typeof value === "string" && /^\d+\.\d+\.\d+$/.test(value) ? value : null;
}

export function compareStableVersions(left: string, right: string): number {
  const a = left.split(".").map(Number);
  const b = right.split(".").map(Number);
  for (let i = 0; i < 3; i++) {
    const difference = (a[i] ?? 0) - (b[i] ?? 0);
    if (difference !== 0) return Math.sign(difference);
  }
  return 0;
}

export function directDependencies(pkg: unknown): Record<string, string> {
  if (pkg === null || typeof pkg !== "object" || Array.isArray(pkg)) return {};
  const input = pkg as Record<string, unknown>;
  const output: Record<string, string> = {};
  for (const key of ["dependencies", "devDependencies", "optionalDependencies"]) {
    const dependencies = input[key];
    if (dependencies === null || typeof dependencies !== "object" || Array.isArray(dependencies))
      continue;
    for (const [name, version] of Object.entries(dependencies)) {
      if (typeof version === "string") output[name] = version;
    }
  }
  return output;
}

/** Resolve an importer's locked core version without interpreting YAML as executable data. */
export function lockedEmdashVersion(lock: string | null, packageJson: unknown): string | null {
  if (lock !== null) {
    try {
      const parsed = JSON.parse(lock) as { packages?: Record<string, { version?: unknown }> };
      const found = stableVersion(parsed.packages?.["node_modules/emdash"]?.version);
      if (found !== null) return found;
    } catch {
      // pnpm's importer entry precedes package and snapshot records.
      const importer = lock.split(/^packages:/m)[0] ?? lock;
      const found =
        /\n {6}emdash:\n {8}specifier: [^\n]+\n {8}version: ['"]?(\d+\.\d+\.\d+)(?:[('"\n]|$)/.exec(
          importer,
        )?.[1];
      if (found !== undefined) return found;
    }
  }
  const specifier = directDependencies(packageJson).emdash;
  return stableVersion(specifier);
}
