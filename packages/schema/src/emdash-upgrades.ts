import semver from "semver";
import { z } from "zod";
import { gitShaSchema } from "./catalog";
import { githubTokenSecretNameSchema } from "./github-tokens";
import { buildInstallIdSchema, SANDBOX_PROTOCOL_VERSION } from "./sandbox";

export const SANDBOX_FEATURE_EMDASH_UPGRADES = "emdash-upgrades";
export const EMDASH_UPGRADE_FILE_BYTES = 2 * 1024 * 1024;
export const emdashUpgradeVersionSchema = z
  .string()
  .regex(/^\d+\.\d+\.\d+$/)
  .refine((version) => semver.valid(version) === version);
export const emdashUpgradeRepoSchema = z
  .string()
  .regex(/^[A-Za-z0-9][A-Za-z0-9-]{0,38}\/[A-Za-z0-9_.-]{1,100}$/)
  .refine((repo) => ![".", ".."].includes(repo.split("/")[1] ?? ""));
export const emdashUpgradeBaseRefSchema = z
  .string()
  .min(1)
  .max(200)
  .refine(
    (ref) =>
      !/[\s~^:?*[\\]/.test(ref) &&
      !ref.includes("..") &&
      !ref.includes("@{") &&
      !ref.startsWith("/") &&
      !ref.endsWith("/") &&
      !ref.endsWith(".") &&
      !ref.endsWith(".lock"),
    "must be a branch name",
  );

export const emdashUpgradeFileSchema = z
  .object({
    path: z.enum(["package.json", "pnpm-lock.yaml"]),
    content: z.string().min(1).max(EMDASH_UPGRADE_FILE_BYTES),
  })
  .strict();
export const emdashUpgradeFilesSchema = z
  .array(emdashUpgradeFileSchema)
  .length(2)
  .refine(
    (files) => new Set(files.map((file) => file.path)).size === 2,
    "must include package.json and pnpm-lock.yaml once each",
  );
export type EmdashUpgradeFile = z.infer<typeof emdashUpgradeFileSchema>;

export const emdashMigrationIdentitySchema = z
  .object({
    emdashVersion: z.string().min(1).max(100),
    names: z.array(z.string().min(1).max(300)).max(2000),
    fingerprint: z.string().min(1).max(200),
  })
  .strict();
export const emdashUpgradeReportSchema = z
  .object({
    fromVersion: z.string().min(1).max(100),
    targetVersion: emdashUpgradeVersionSchema,
    plugins: z
      .array(
        z
          .object({
            name: z.string().min(1).max(200),
            version: z.string().max(200),
            range: z.string().max(500).nullable(),
            compatible: z.boolean().nullable(),
          })
          .strict(),
      )
      .max(200),
    beforeMigrations: emdashMigrationIdentitySchema,
    afterMigrations: emdashMigrationIdentitySchema,
    addedMigrations: z.array(z.string().min(1).max(300)).max(2000),
    preservedPaths: z.tuple([z.literal("theme"), z.literal("plugins"), z.literal("configuration")]),
    buildVerified: z.literal(true),
  })
  .strict();
export type EmdashUpgradeReport = z.infer<typeof emdashUpgradeReportSchema>;

export const emdashUpgradeRequestSchema = z
  .object({
    protocol: z.literal(SANDBOX_PROTOCOL_VERSION),
    installId: buildInstallIdSchema,
    runId: buildInstallIdSchema,
    repo: emdashUpgradeRepoSchema,
    baseSha: gitShaSchema,
    targetVersion: emdashUpgradeVersionSchema,
    githubTokenSecret: githubTokenSecretNameSchema.optional(),
  })
  .strict();
export type EmdashUpgradeRequest = z.infer<typeof emdashUpgradeRequestSchema>;
export const emdashUpgradeOutcomeSchema = z.discriminatedUnion("ok", [
  z
    .object({
      ok: z.literal(true),
      baseSha: gitShaSchema,
      targetVersion: emdashUpgradeVersionSchema,
      files: emdashUpgradeFilesSchema,
      report: emdashUpgradeReportSchema,
      logTail: z.string().max(210000).optional(),
    })
    .strict(),
  z
    .object({ ok: z.literal(false), error: z.string().max(4000), logTail: z.string().max(210000) })
    .strict(),
]);
export type EmdashUpgradeOutcome = z.infer<typeof emdashUpgradeOutcomeSchema>;

export const publishEmdashUpgradeRequestSchema = z
  .object({
    protocol: z.literal(SANDBOX_PROTOCOL_VERSION),
    upgradeId: buildInstallIdSchema,
    repo: emdashUpgradeRepoSchema,
    baseRef: emdashUpgradeBaseRefSchema,
    baseSha: gitShaSchema,
    targetVersion: emdashUpgradeVersionSchema,
    tokenSecret: githubTokenSecretNameSchema,
    files: emdashUpgradeFilesSchema,
  })
  .strict();
export type PublishEmdashUpgradeRequest = z.infer<typeof publishEmdashUpgradeRequestSchema>;
export const publishedEmdashUpgradeSchema = z
  .object({
    branch: z.string().min(1).max(200),
    headSha: gitShaSchema,
    prNumber: z.number().int().positive(),
    prUrl: z.string().url().max(2048),
  })
  .strict();
export type PublishedEmdashUpgrade = z.infer<typeof publishedEmdashUpgradeSchema>;

export const mergeEmdashUpgradeRequestSchema = z
  .object({
    protocol: z.literal(SANDBOX_PROTOCOL_VERSION),
    upgradeId: buildInstallIdSchema,
    repo: emdashUpgradeRepoSchema,
    prNumber: z.number().int().positive(),
    expectedBaseRef: emdashUpgradeBaseRefSchema,
    expectedBaseSha: gitShaSchema,
    expectedHeadSha: gitShaSchema,
    tokenSecret: githubTokenSecretNameSchema,
  })
  .strict();
export type MergeEmdashUpgradeRequest = z.infer<typeof mergeEmdashUpgradeRequestSchema>;
export const mergedEmdashUpgradeSchema = z
  .object({ merged: z.literal(true), mergeSha: gitShaSchema })
  .strict();
export type MergedEmdashUpgrade = z.infer<typeof mergedEmdashUpgradeSchema>;

/** Null means a package supplied an unreadable compatibility constraint. */
export function emdashVersionSatisfies(version: string, range: string): boolean | null {
  if (semver.valid(version) === null || semver.validRange(range) === null) return null;
  return semver.satisfies(version, range, { includePrerelease: false });
}

export function emdashUpgradeBranch(id: string): string {
  return `appflare/emdash-${buildInstallIdSchema.parse(id).toLowerCase()}`;
}
