import { NonRetryableError } from "cloudflare:workflows";
import {
  emdashUpgradeBranch,
  emdashUpgradeOutcomeSchema,
  githubTokenSecretName,
  gitShaSchema,
  publishedEmdashUpgradeSchema,
  SANDBOX_PROTOCOL_VERSION,
} from "@appflare/schema";
import { z } from "zod";
import { repositoryPatterns } from "../github/tokens";
import { readGithubToken } from "../github/tokens.server";
import { emdashUpgradeDeps } from "../installs/emdash-upgrades.server";
import { startSourceBuildCore } from "../installs/source-builds.server";
import { sandboxBinding, sandboxInfo } from "../sandbox/binding";
import type { JobContext } from "./run-job";
import { createJobSteps, errorMessage, JobError } from "./steps";

const token = z.object({ id: z.string().min(1).max(64), label: z.string().min(1).max(100) });
export const emdashUpgradeJobParams = z.object({
  kind: z.literal("emdash_upgrade"),
  jobId: z.string().min(1).max(64),
  upgradeId: z.string().min(1).max(64),
  installId: z.string().min(1).max(64),
  repo: z.string().min(3).max(140),
  baseRef: z.string().min(1).max(200),
  baseSha: gitShaSchema,
  targetVersion: z.string().regex(/^\d+\.\d+\.\d+$/),
  readToken: token.nullable(),
  writeToken: token,
  buildId: z.string().min(1).max(64),
  costConfirmed: z.literal(true),
});
export type EmDashUpgradeJobParams = z.infer<typeof emdashUpgradeJobParams>;

/** Prepare only dependency files, publish them to a review branch, then build that real commit. */
export async function runEmdashUpgrade(ctx: JobContext): Promise<void> {
  const parsed = emdashUpgradeJobParams.safeParse(ctx.params);
  if (!parsed.success) throw new NonRetryableError("invalid EmDash upgrade payload");
  const params = parsed.data;
  const steps = createJobSteps(ctx, params.jobId);
  const { env, step } = ctx;
  try {
    if (
      (await steps.start(async ({ log }) => {
        log.info(
          `Preparing EmDash ${params.targetVersion} on a review branch. The running app and its data are unchanged.`,
        );
        return {};
      })) === null
    )
      return;
    const published = await steps.run(
      "prepare and publish upgrade",
      async ({ log }) => {
        const binding = sandboxBinding(env);
        if (
          binding === undefined ||
          !(await sandboxInfo(binding)).features?.includes("emdash-upgrades")
        )
          throw new JobError("Update the sandbox Worker to enable EmDash upgrades.");
        const write = await readGithubToken(env.DB, params.writeToken.id);
        if (
          write === null ||
          !write.forRepositoryUpdates ||
          write.forBuilds ||
          write.forReleases ||
          repositoryPatterns(write.repositories).length !== 1 ||
          repositoryPatterns(write.repositories)[0] !== params.repo.toLowerCase()
        )
          throw new JobError(
            "The repository update token was removed or no longer covers this exact repository.",
          );
        const outcome = emdashUpgradeOutcomeSchema.parse(
          await binding.prepareEmdashUpgrade({
            protocol: SANDBOX_PROTOCOL_VERSION,
            installId: params.installId,
            runId: `emdash-${params.jobId}`,
            repo: params.repo,
            baseSha: params.baseSha,
            targetVersion: params.targetVersion,
            ...(params.readToken === null
              ? {}
              : { githubTokenSecret: githubTokenSecretName(params.readToken.id) }),
          }),
        );
        if (outcome.logTail) log.log("debug", outcome.logTail.slice(-16000));
        if (!outcome.ok) throw new JobError(outcome.error);
        if (outcome.baseSha !== params.baseSha || outcome.targetVersion !== params.targetVersion)
          throw new JobError("The sandbox prepared a different EmDash source or target release.");
        if (outcome.report.plugins.some((plugin) => plugin.compatible === false))
          throw new JobError(
            "A plugin declares an incompatibility with the target EmDash release. Nothing was published.",
          );
        // Files remain in this callback. Workflows persist only the small report and PR metadata,
        // never the lockfile or credentials, so step replay stays below the output limit.
        const publication = publishedEmdashUpgradeSchema.parse(
          await binding.publishEmdashUpgrade({
            protocol: SANDBOX_PROTOCOL_VERSION,
            upgradeId: params.upgradeId,
            repo: params.repo,
            baseRef: params.baseRef,
            baseSha: params.baseSha,
            targetVersion: params.targetVersion,
            tokenSecret: githubTokenSecretName(params.writeToken.id),
            files: outcome.files,
          }),
        );
        if (
          publication.branch !== emdashUpgradeBranch(params.upgradeId) ||
          publication.prUrl !== `https://github.com/${params.repo}/pull/${publication.prNumber}`
        )
          throw new JobError("The sandbox published an unexpected upgrade branch or pull request.");
        if (JSON.stringify({ publication, report: outcome.report }).length > 700000)
          throw new JobError("The upgrade report is too large to retain safely.");
        await env.DB.prepare(
          "UPDATE emdash_upgrades SET status='pr_open', branch=?2, head_sha=?3, pr_number=?4, pr_url=?5, report_json=?6, updated_at=?7 WHERE id=?1",
        )
          .bind(
            params.upgradeId,
            publication.branch,
            publication.headSha,
            publication.prNumber,
            publication.prUrl,
            JSON.stringify(outcome.report),
            steps.now(),
          )
          .run();
        log.info(
          `Created the upgrade pull request: ${publication.prUrl}. Theme, plugins, and configuration files were preserved.`,
        );
        return publication;
      },
      { retries: { limit: 1, delay: "5 seconds", backoff: "constant" }, timeout: "60 minutes" },
    );

    await steps.run("build upgrade pull request", async ({ log }) => {
      if (env.JOBS === undefined) throw new JobError("The manager job binding is missing.");
      const existing = await env.DB.prepare("SELECT id FROM source_builds WHERE id=?1")
        .bind(params.buildId)
        .first();
      await env.DB.prepare(
        "UPDATE emdash_upgrades SET build_id=?2, status=CASE WHEN status='ready' THEN status ELSE 'building' END, updated_at=?3 WHERE id=?1",
      )
        .bind(params.upgradeId, params.buildId, steps.now())
        .run();
      // Release the preparation's install lock before claiming the ordinary source build.
      await env.DB.prepare(
        "UPDATE jobs SET status='succeeded', finished_at=?2, error=NULL WHERE id=?1",
      )
        .bind(params.jobId, steps.now())
        .run();
      if (existing === null) {
        const deps = emdashUpgradeDeps(env, steps.baseFetch);
        await startSourceBuildCore(
          { ...deps.sourceBuild, newId: () => params.buildId },
          {
            kind: "emdash-upgrade-build",
            installId: params.installId,
            ref: published.branch,
            commitSha: published.headSha,
            costConfirmed: true,
          },
        );
      }
      log.info(
        `The pull request is being built for review: /jobs/${params.buildId}. Nothing was deployed.`,
      );
      return { buildId: params.buildId };
    });
  } catch (error) {
    const reason = `${steps.current}: ${errorMessage(error)}`;
    await step.do("mark EmDash upgrade failed", async () => {
      await env.DB.batch([
        env.DB.prepare(
          "UPDATE jobs SET status='failed', error=?2, finished_at=?3 WHERE id=?1",
        ).bind(params.jobId, reason, steps.now()),
        env.DB.prepare(
          "UPDATE emdash_upgrades SET status='failed', error=?2, updated_at=?3 WHERE id=?1",
        ).bind(params.upgradeId, reason, steps.now()),
      ]);
      return {};
    });
    throw new NonRetryableError(reason);
  }
}
