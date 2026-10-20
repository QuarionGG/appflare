import type { FetchLike } from "@appflare/cf-api";
import {
  emdashUpgradeReportSchema,
  githubTokenSecretName,
  mergedEmdashUpgradeSchema,
  SANDBOX_PROTOCOL_VERSION,
} from "@appflare/schema";
import { ulid } from "ulidx";
import { readAccountPlan } from "../account/plan.server";
import { createDb } from "../db/client";
import {
  type RepositoryReader,
  readRepositoryRefs,
  repositoryReader,
} from "../github/access.server";
import { repositoryPatterns } from "../github/tokens";
import { readGithubTokens } from "../github/tokens.server";
import { jobCreator } from "../jobs/create-job.server";
import type { EmDashUpgradeJobParams } from "../jobs/emdash-upgrade";
import type { WorkflowLookup } from "../jobs/reconcile.server";
import type { JobEnv } from "../jobs/run-job";
import { NO_ACTIVE_SELF_UPDATE_SQL, refuseDuringSelfUpdate } from "../jobs/self-update/guard";
import {
  type SandboxBuildsBinding,
  sandboxBinding,
  sandboxGithubFetch,
  sandboxInfo,
} from "../sandbox/binding";
import {
  compareStableVersions,
  directDependencies,
  type EmDashUpgradePlan,
  type EmDashUpgradeView,
  lockedEmdashVersion,
  stableVersion,
} from "./emdash-upgrades";
import { resolveRef } from "./git-refs";
import { repoOfUrl, type SourceBuildDeps, startSourceBuildCore } from "./source-builds.server";
import { readInstall, statusRefusal } from "./versions.server";

export class EmDashUpgradeError extends Error {
  override name = "EmDashUpgradeError";
}
const fail = (message: string) => new EmDashUpgradeError(message);

export interface EmDashUpgradeDeps {
  db: D1Database;
  reader: RepositoryReader;
  fetch: FetchLike;
  sandbox?: SandboxBuildsBinding;
  workflows?: WorkflowLookup;
  createJob(id: string, params: EmDashUpgradeJobParams): Promise<{ id: string }>;
  sourceBuild: SourceBuildDeps;
  now?: () => Date;
  newId?: () => string;
}

/** Repository-only source builds reuse the normal pipeline, without catalog resolution. */
export function emdashUpgradeDeps(
  env: JobEnv,
  fetcher: FetchLike = (url, init) => fetch(url, init),
): EmDashUpgradeDeps {
  if (env.JOBS === undefined) throw fail("The manager job binding is missing.");
  const binding = sandboxBinding(env);
  const reader = repositoryReader(env);
  reader.fetch = fetcher;
  const create = jobCreator(env.JOBS);
  const sourceBuild: SourceBuildDeps = {
    db: env.DB,
    createJob: create,
    sandbox: async () => ({
      connected: binding !== undefined,
      info: binding === undefined ? null : await sandboxInfo(binding),
    }),
    listRefs: (repo) => readRepositoryRefs(reader, repo),
    loadCatalogApp: async () => {
      throw fail("EmDash upgrades use the custom repository source.");
    },
  };
  return {
    db: env.DB,
    reader,
    fetch: fetcher,
    ...(binding === undefined ? {} : { sandbox: binding }),
    createJob: create,
    sourceBuild,
  };
}

/** Only an explicitly opted-in token naming this exact repository may publish an upgrade. */
export async function emdashWriteToken(
  db: D1Database,
  repo: string,
): Promise<{ id: string; label: string } | null> {
  const tokens = await readGithubTokens(db);
  return (
    tokens.find(
      (token) =>
        token.forRepositoryUpdates &&
        !token.forBuilds &&
        !token.forReleases &&
        repositoryPatterns(token.repositories).length === 1 &&
        repositoryPatterns(token.repositories)[0] === repo.toLowerCase(),
    ) ?? null
  );
}

async function readText(fetcher: FetchLike, url: string, missing = false): Promise<string | null> {
  const githubSource = new URL(url).hostname === "api.github.com";
  const response = await fetcher(url, {
    headers: {
      accept: githubSource ? "application/vnd.github.raw+json" : "application/json",
      "user-agent": "Appflare",
    },
    signal: AbortSignal.timeout(15_000),
  });
  if (missing && response.status === 404) {
    await response.body?.cancel();
    return null;
  }
  if (!response.ok) {
    await response.body?.cancel();
    throw fail(
      `Reading the upgrade source failed (HTTP ${response.status}). Check repository access and try again.`,
    );
  }
  if (Number(response.headers.get("content-length") ?? 0) > 2 * 1024 * 1024) {
    await response.body?.cancel();
    throw fail("The upgrade source file is too large.");
  }
  const text = await response.text();
  if (text.length > 2 * 1024 * 1024) throw fail("The upgrade source file is too large.");
  return text;
}

export async function inspectEmdashUpgrade(
  deps: EmDashUpgradeDeps,
  installId: string,
): Promise<{
  plan: EmDashUpgradePlan;
  baseRef: string;
  readToken: { id: string; label: string } | null;
}> {
  const install = await readInstall(deps.db, installId);
  const repo = repoOfUrl(install.source_url);
  const blank: EmDashUpgradePlan = {
    supported: false,
    reason: null,
    installedVersion: null,
    sourceVersion: null,
    targetVersion: null,
    baseSha: null,
    repo,
    upToDate: false,
    writeTokenAvailable: false,
    plugins: [],
  };
  const refusal = statusRefusal(install.status);
  if (refusal !== null || install.origin !== "repository" || repo === null)
    return {
      plan: {
        ...blank,
        reason: refusal ?? "EmDash upgrades need an app built from its own GitHub repository.",
      },
      baseRef: "",
      readToken: null,
    };
  const remote = await readRepositoryRefs(deps.reader, repo);
  const resolved = resolveRef(remote, install.source_ref, repo);
  if (resolved.kind !== "branch")
    return {
      plan: { ...blank, reason: "Select a source branch before preparing an EmDash upgrade." },
      baseRef: resolved.ref,
      readToken: remote.token,
    };
  const fetcher =
    remote.token === null
      ? deps.reader.fetch
      : deps.reader.sandbox === undefined
        ? null
        : sandboxGithubFetch(deps.reader.sandbox, githubTokenSecretName(remote.token.id));
  if (fetcher === null)
    throw fail("Sandbox builds must be enabled to read this private repository.");
  const sourceFile = (file: string, sha: string, missing = false) =>
    readText(fetcher, `https://api.github.com/repos/${repo}/contents/${file}?ref=${sha}`, missing);
  const packageText = await sourceFile("package.json", resolved.commit);
  let pkg: unknown;
  try {
    pkg = JSON.parse(packageText ?? "null");
  } catch {
    throw fail("The repository package.json is not valid JSON.");
  }
  const dependencies = directDependencies(pkg);
  if (dependencies.emdash === undefined || dependencies["@emdash-cms/cloudflare"] === undefined)
    return {
      plan: {
        ...blank,
        reason: "This repository does not declare both EmDash and its Cloudflare adapter.",
      },
      baseRef: resolved.ref,
      readToken: remote.token,
    };
  const packageManager =
    typeof pkg === "object" && pkg !== null
      ? (pkg as { packageManager?: unknown }).packageManager
      : null;
  const lockName = "pnpm-lock.yaml";
  const lock = await sourceFile(lockName, resolved.commit, true);
  const installedLock =
    install.pin_sha === null || install.pin_sha === resolved.commit
      ? lock
      : await sourceFile(lockName, install.pin_sha, true);
  const [coreText, adapterText] = await Promise.all([
    readText(deps.fetch, "https://registry.npmjs.org/emdash/latest"),
    readText(deps.fetch, "https://registry.npmjs.org/@emdash-cms%2fcloudflare/latest"),
  ]);
  let core: unknown;
  let adapter: unknown;
  try {
    core = JSON.parse(coreText ?? "null");
    adapter = JSON.parse(adapterText ?? "null");
  } catch {
    throw fail("The npm registry did not return valid release metadata.");
  }
  const versionOf = (metadata: unknown) =>
    metadata !== null && typeof metadata === "object"
      ? stableVersion((metadata as { version?: unknown }).version)
      : null;
  const targetVersion = versionOf(core);
  const adapterVersion = versionOf(adapter);
  const sourceVersion = lockedEmdashVersion(lock, pkg);
  const installedVersion = lockedEmdashVersion(
    installedLock,
    install.pin_sha === null || install.pin_sha === resolved.commit ? pkg : null,
  );
  const reason =
    typeof packageManager !== "string" || !packageManager.startsWith("pnpm@") || lock === null
      ? "This upgrade path requires a pinned pnpm package manager and a tracked pnpm-lock.yaml."
      : sourceVersion === null
        ? "Appflare could not resolve the current EmDash version from the lockfile."
        : targetVersion === null || adapterVersion !== targetVersion
          ? "EmDash and its Cloudflare adapter do not currently publish the same stable version."
          : null;
  return {
    plan: {
      ...blank,
      supported: reason === null,
      reason,
      installedVersion,
      sourceVersion,
      targetVersion,
      baseSha: resolved.commit,
      writeTokenAvailable: (await emdashWriteToken(deps.db, repo)) !== null,
      upToDate:
        sourceVersion !== null &&
        targetVersion !== null &&
        compareStableVersions(sourceVersion, targetVersion) >= 0,
      plugins: Object.entries(dependencies)
        .filter(
          ([name]) =>
            name !== "emdash" &&
            name !== "@emdash-cms/cloudflare" &&
            (name.startsWith("@emdash-cms/") || name.includes("emdash")),
        )
        .map(([name, version]) => ({ name, version })),
    },
    baseRef: resolved.ref,
    readToken: remote.token,
  };
}

export async function checkEmdashUpgradeCore(
  deps: EmDashUpgradeDeps,
  installId: string,
): Promise<EmDashUpgradePlan> {
  return (await inspectEmdashUpgrade(deps, installId)).plan;
}

type UpgradeRow = {
  id: string;
  install_id: string;
  repo: string;
  base_ref: string;
  base_sha: string;
  target_version: string;
  status: EmDashUpgradeView["status"];
  preparation_job_id: string;
  build_id: string | null;
  branch: string | null;
  head_sha: string | null;
  pr_number: number | null;
  pr_url: string | null;
  merge_sha: string | null;
  merged_build_id: string | null;
  error: string | null;
  report_json: string | null;
  write_token_id: string | null;
};
export function upgradeView(row: UpgradeRow): EmDashUpgradeView {
  let report: EmDashUpgradeView["report"] = null;
  try {
    const parsed = emdashUpgradeReportSchema.safeParse(
      row.report_json === null ? null : JSON.parse(row.report_json),
    );
    report = parsed.success ? parsed.data : null;
  } catch {
    /* Malformed stored reports are not trusted. */
  }
  return {
    id: row.id,
    installId: row.install_id,
    repo: row.repo,
    baseRef: row.base_ref,
    baseSha: row.base_sha,
    targetVersion: row.target_version,
    status: row.status,
    preparationJobId: row.preparation_job_id,
    buildId: row.build_id,
    branch: row.branch,
    headSha: row.head_sha,
    prNumber: row.pr_number,
    prUrl: row.pr_url,
    mergeSha: row.merge_sha,
    mergedBuildId: row.merged_build_id,
    error: row.error,
    report,
  };
}

async function refreshUpgradeRow(db: D1Database, row: UpgradeRow): Promise<UpgradeRow> {
  if (row.merge_sha !== null) return row;
  const build =
    row.build_id === null
      ? null
      : await db
          .prepare(
            "SELECT b.status, j.status AS job_status, j.error FROM source_builds b LEFT JOIN jobs j ON j.id=b.id WHERE b.id=?1",
          )
          .bind(row.build_id)
          .first<{ status: string; job_status: string | null; error: string | null }>();
  const preparation =
    row.status === "preparing" || row.status === "pr_open"
      ? await db
          .prepare("SELECT status,error FROM jobs WHERE id=?1")
          .bind(row.preparation_job_id)
          .first<{ status: string; error: string | null }>()
      : null;
  let next: UpgradeRow["status"] = row.status;
  let error = row.error;
  if (
    build?.job_status === "failed" ||
    build?.status === "failed" ||
    build?.status === "discarded" ||
    build?.status === "discarding" ||
    preparation?.status === "failed"
  ) {
    next = "failed";
    error =
      build?.error ??
      preparation?.error ??
      "The pull request review build is no longer available. Prepare the upgrade again.";
  } else if (
    row.status === "building" &&
    build?.status === "built" &&
    build.job_status === "succeeded"
  )
    next = "ready";
  if (next !== row.status || error !== row.error)
    await db
      .prepare(
        "UPDATE emdash_upgrades SET status=?2,error=?3,updated_at=?4 WHERE id=?1 AND merge_sha IS NULL",
      )
      .bind(row.id, next, error, Date.now())
      .run();
  return { ...row, status: next, error };
}

export async function readEmdashUpgrade(
  db: D1Database,
  id: string,
): Promise<EmDashUpgradeView | null> {
  const row = await db
    .prepare("SELECT * FROM emdash_upgrades WHERE id = ?1")
    .bind(id)
    .first<UpgradeRow>();
  return row === null ? null : upgradeView(await refreshUpgradeRow(db, row));
}

export async function latestEmdashUpgrade(
  db: D1Database,
  installId: string,
): Promise<EmDashUpgradeView | null> {
  const row = await db
    .prepare(
      "SELECT * FROM emdash_upgrades WHERE install_id=?1 ORDER BY created_at DESC, id DESC LIMIT 1",
    )
    .bind(installId)
    .first<UpgradeRow>();
  return row === null ? null : upgradeView(await refreshUpgradeRow(db, row));
}

export async function emdashUpgradeForBuild(
  db: D1Database,
  buildId: string,
): Promise<EmDashUpgradeView | null> {
  const row = await db
    .prepare("SELECT * FROM emdash_upgrades WHERE build_id = ?1 OR merged_build_id = ?1 LIMIT 1")
    .bind(buildId)
    .first<UpgradeRow>();
  return row === null ? null : upgradeView(await refreshUpgradeRow(db, row));
}

export async function prepareEmdashUpgradeCore(
  deps: EmDashUpgradeDeps,
  input: {
    installId: string;
    expectedBaseSha: string;
    targetVersion: string;
    costConfirmed: boolean;
  },
): Promise<{ jobId: string }> {
  if (!input.costConfirmed) throw fail("Confirm the sandbox build cost to prepare the upgrade.");
  await refuseDuringSelfUpdate(deps.db, deps.workflows, fail);
  if ((await readAccountPlan(createDb(deps.db))) !== "paid")
    throw fail("EmDash upgrade builds need Workers Paid.");
  if (
    deps.sandbox === undefined ||
    !(await sandboxInfo(deps.sandbox)).features?.includes("emdash-upgrades")
  )
    throw fail("Update the sandbox Worker to enable EmDash upgrades.");
  const { plan, baseRef, readToken } = await inspectEmdashUpgrade(deps, input.installId);
  if (!plan.supported || plan.repo === null || plan.baseSha === null)
    throw fail(plan.reason ?? "This app cannot prepare an EmDash upgrade.");
  if (plan.upToDate) throw fail("The source already uses the current stable EmDash release.");
  if (input.expectedBaseSha !== plan.baseSha || input.targetVersion !== plan.targetVersion)
    throw fail("The source or the stable release changed. Check for updates again.");
  const writeToken = await emdashWriteToken(deps.db, plan.repo);
  if (writeToken === null)
    throw fail(
      "Add a repository update token for this exact repository in GitHub access settings. It needs Contents and Pull requests write access.",
    );
  const previous = await latestEmdashUpgrade(deps.db, input.installId);
  if (
    previous !== null &&
    (previous.status === "ready" || previous.status === "pr_open") &&
    previous.baseSha !== plan.baseSha
  )
    await deps.db
      .prepare(
        "UPDATE emdash_upgrades SET status='failed', error='The source branch changed. Prepare a new upgrade from its current commit.', updated_at=?2 WHERE id=?1",
      )
      .bind(previous.id, Date.now())
      .run();
  const newId = deps.newId ?? (() => ulid());
  const jobId = newId();
  const buildId = newId();
  const at = (deps.now ?? (() => new Date()))().getTime();
  const results = await deps.db.batch([
    deps.db
      .prepare(
        `INSERT INTO jobs (id, install_id, kind, status, input_json, started_by) SELECT ?1, ?2, 'emdash_upgrade', 'queued', ?3, 'admin' WHERE EXISTS (SELECT 1 FROM installs WHERE id = ?2 AND status = 'installed') AND NOT EXISTS (SELECT 1 FROM jobs WHERE install_id = ?2 AND status IN ('queued', 'running')) AND NOT EXISTS (SELECT 1 FROM emdash_upgrades WHERE install_id = ?2 AND status IN ('preparing','pr_open','building','ready')) AND NOT EXISTS (SELECT 1 FROM jobs WHERE kind IN ('sandbox_enable','sandbox_update','sandbox_disable') AND status IN ('queued','running')) AND ${NO_ACTIVE_SELF_UPDATE_SQL}`,
      )
      .bind(
        jobId,
        input.installId,
        JSON.stringify({
          runKind: "build",
          sandboxRun: `emdash-${jobId}`,
          buildInstallId: input.installId,
          buildConfirmed: true,
        }),
      ),
    deps.db
      .prepare(
        "INSERT INTO emdash_upgrades (id, install_id, repo, base_ref, base_sha, target_version, status, preparation_job_id, write_token_id, created_at, updated_at) SELECT ?1, ?2, ?3, ?4, ?5, ?6, 'preparing', ?1, ?8, ?7, ?7 WHERE EXISTS (SELECT 1 FROM jobs WHERE id = ?1)",
      )
      .bind(
        jobId,
        input.installId,
        plan.repo,
        baseRef,
        plan.baseSha,
        input.targetVersion,
        at,
        writeToken.id,
      ),
  ]);
  if (results[0]?.meta.changes !== 1)
    throw fail(
      "Another job or EmDash upgrade is active. Finish it before preparing another upgrade.",
    );
  const params: EmDashUpgradeJobParams = {
    kind: "emdash_upgrade",
    jobId,
    installId: input.installId,
    upgradeId: jobId,
    repo: plan.repo,
    baseRef,
    baseSha: plan.baseSha,
    targetVersion: input.targetVersion,
    readToken,
    writeToken,
    buildId,
    costConfirmed: true,
  };
  try {
    const instance = await deps.createJob(jobId, params);
    await deps.db
      .prepare("UPDATE jobs SET workflow_instance_id = ?2 WHERE id = ?1")
      .bind(jobId, instance.id)
      .run();
  } catch (error) {
    await deps.db.batch([
      deps.db
        .prepare("UPDATE jobs SET status='failed', error=?2, finished_at=?3 WHERE id=?1")
        .bind(jobId, "Could not start the EmDash upgrade job.", at),
      deps.db
        .prepare("UPDATE emdash_upgrades SET status='failed', updated_at=?2 WHERE id=?1")
        .bind(jobId, at),
    ]);
    throw error;
  }
  return { jobId };
}

export async function mergeAndBuildEmdashUpgradeCore(
  deps: EmDashUpgradeDeps,
  input: { upgradeId: string; costConfirmed: boolean },
): Promise<{ jobId: string }> {
  if (!input.costConfirmed)
    throw fail("Confirm the sandbox build cost before merging and building.");
  await refuseDuringSelfUpdate(deps.db, deps.workflows, fail);
  const upgrade = await readEmdashUpgrade(deps.db, input.upgradeId);
  if (
    upgrade === null ||
    (upgrade.status !== "ready" && upgrade.status !== "merged") ||
    upgrade.prNumber === null ||
    upgrade.headSha === null
  )
    throw fail("This upgrade pull request has not passed its build review.");
  const build =
    upgrade.buildId === null
      ? null
      : await deps.db
          .prepare("SELECT status FROM source_builds WHERE id = ?1")
          .bind(upgrade.buildId)
          .first<{ status: string }>();
  if (upgrade.mergeSha === null && build?.status !== "built")
    throw fail("The pull request build is not ready. Build it successfully before merging.");
  if (upgrade.report === null)
    throw fail(
      "The verified EmDash upgrade report is missing. Prepare the upgrade again before merging.",
    );
  if (upgrade.report?.plugins.some((plugin) => plugin.compatible === false))
    throw fail(
      "A plugin declares an incompatibility with the target EmDash release. Resolve it in the repository before merging.",
    );
  if (upgrade.mergeSha !== null && upgrade.mergedBuildId !== null) {
    const existing = await deps.db
      .prepare("SELECT status FROM source_builds WHERE id=?1")
      .bind(upgrade.mergedBuildId)
      .first<{ status: string }>();
    if (existing !== null && (existing.status === "building" || existing.status === "built"))
      return { jobId: upgrade.mergedBuildId };
  }
  const stored = await deps.db
    .prepare("SELECT write_token_id FROM emdash_upgrades WHERE id=?1")
    .bind(upgrade.id)
    .first<{ write_token_id: string | null }>();
  const tokens = await readGithubTokens(deps.db);
  const token = tokens.find(
    (candidate) =>
      candidate.id === stored?.write_token_id &&
      candidate.forRepositoryUpdates &&
      !candidate.forBuilds &&
      !candidate.forReleases &&
      repositoryPatterns(candidate.repositories).length === 1 &&
      repositoryPatterns(candidate.repositories)[0] === upgrade.repo.toLowerCase(),
  );
  if (token === undefined || deps.sandbox === undefined)
    throw fail(
      "The repository update token used for this upgrade and sandbox builds are required to merge it.",
    );
  let mergeSha = upgrade.mergeSha;
  if (mergeSha === null) {
    const result = await deps.sandbox.mergeEmdashUpgrade({
      protocol: SANDBOX_PROTOCOL_VERSION,
      upgradeId: upgrade.id,
      repo: upgrade.repo,
      prNumber: upgrade.prNumber,
      expectedBaseSha: upgrade.baseSha,
      expectedBaseRef: upgrade.baseRef,
      expectedHeadSha: upgrade.headSha,
      tokenSecret: githubTokenSecretName(token.id),
    });
    const parsed = mergedEmdashUpgradeSchema.parse(result);
    mergeSha = parsed.mergeSha;
    await deps.db
      .prepare(
        "UPDATE emdash_upgrades SET merge_sha=?2, status='merged', updated_at=?3 WHERE id=?1",
      )
      .bind(upgrade.id, mergeSha, (deps.now ?? (() => new Date()))().getTime())
      .run();
  }
  const { jobId } = await startSourceBuildCore(deps.sourceBuild, {
    kind: "emdash-upgrade-build",
    installId: upgrade.installId,
    commitSha: mergeSha,
    ref: upgrade.baseRef,
    costConfirmed: true,
  });
  await deps.db
    .prepare("UPDATE emdash_upgrades SET merged_build_id=?2, updated_at=?3 WHERE id=?1")
    .bind(upgrade.id, jobId, (deps.now ?? (() => new Date()))().getTime())
    .run();
  return { jobId };
}
