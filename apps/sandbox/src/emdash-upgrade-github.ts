import {
  emdashUpgradeBranch,
  type MergedEmdashUpgrade,
  mergeEmdashUpgradeRequestSchema,
  type PublishedEmdashUpgrade,
  publishEmdashUpgradeRequestSchema,
} from "@appflare/schema";
import { heldGithubToken } from "./github";

export class EmdashGithubUpgradeError extends Error {
  override name = "EmdashGithubUpgradeError";
}

function object(value: unknown): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new EmdashGithubUpgradeError("The repository's package metadata is not an object.");
  }
  return value as Record<string, unknown>;
}
function canonical(value: unknown): string {
  return JSON.stringify(value, (_key, item) =>
    item && typeof item === "object" && !Array.isArray(item)
      ? Object.fromEntries(
          Object.keys(item)
            .sort()
            .map((key) => [key, item[key]]),
        )
      : item,
  );
}

/** Validate again outside the build container, before granting its output a GitHub write. */
export function validateEmdashUpgradePackage(before: string, after: string, target: string): void {
  const original = object(JSON.parse(before));
  const expected = structuredClone(original);
  for (const name of ["emdash", "@emdash-cms/cloudflare"]) {
    let changed = 0;
    for (const section of ["dependencies", "devDependencies"]) {
      if (original[section] === undefined) continue;
      const deps = object(original[section]);
      if (!Object.hasOwn(deps, name)) continue;
      const current = deps[name];
      if (typeof current !== "string" || !/^[~^]?\d+\.\d+\.\d+$/.test(current)) {
        throw new EmdashGithubUpgradeError(
          `The ${name} dependency needs a regular release version.`,
        );
      }
      object(expected[section])[name] = `${/^[~^]/.exec(current)?.[0] ?? ""}${target}`;
      changed++;
    }
    if (changed !== 1)
      throw new EmdashGithubUpgradeError(`Declare ${name} exactly once as a direct dependency.`);
  }
  if (canonical(expected) !== canonical(object(JSON.parse(after)))) {
    throw new EmdashGithubUpgradeError(
      "The prepared package.json changes more than the two EmDash dependency versions.",
    );
  }
}

function githubApi(env: object, secret: string, fetchImpl: typeof fetch) {
  const token = heldGithubToken(env, secret);
  if (token === null)
    throw new EmdashGithubUpgradeError(
      "The sandbox Worker does not hold the dedicated repository update token.",
    );
  return async <T>(
    path: string,
    method = "GET",
    body?: unknown,
    missing = false,
    raw = false,
  ): Promise<T | null> => {
    const response = await fetchImpl(`https://api.github.com${path}`, {
      method,
      headers: {
        authorization: `Bearer ${token}`,
        accept: raw ? "application/vnd.github.raw+json" : "application/vnd.github+json",
        "user-agent": "Appflare-EmDash-updates",
        "x-github-api-version": "2026-03-10",
        ...(body === undefined ? {} : { "content-type": "application/json" }),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      redirect: "manual",
      signal: AbortSignal.timeout(30000),
    });
    if (missing && response.status === 404) {
      await response.body?.cancel();
      return null;
    }
    if (!response.ok) {
      await response.body?.cancel();
      throw new EmdashGithubUpgradeError(
        `GitHub refused the repository update (HTTP ${response.status}). Check the dedicated token's Contents and Pull requests write permissions and the repository's merge requirements.`,
      );
    }
    const reader = response.body?.getReader();
    let text = "",
      bytes = 0;
    const decoder = new TextDecoder();
    if (reader) {
      for (;;) {
        const next = await reader.read();
        if (next.done) break;
        bytes += next.value.byteLength;
        if (bytes > 8 * 1024 * 1024) {
          await reader.cancel();
          throw new EmdashGithubUpgradeError("GitHub returned too much repository metadata.");
        }
        text += decoder.decode(next.value, { stream: true });
      }
      text += decoder.decode();
    }
    return (raw ? text : text.length === 0 ? null : JSON.parse(text)) as T;
  };
}

type Pull = {
  number: number;
  state: string;
  draft?: boolean;
  merged?: boolean;
  merge_commit_sha?: string;
  mergeable?: boolean | null;
  mergeable_state?: string;
  base: { ref: string; sha: string; repo: { full_name: string } };
  head: { ref: string; sha: string; repo: { full_name: string } };
};
function checkPull(
  pull: Pull,
  repo: string,
  branch: string,
  baseRef: string,
  baseSha: string,
  headSha: string,
): void {
  if (
    pull.base.repo.full_name.toLowerCase() !== repo.toLowerCase() ||
    pull.head.repo.full_name.toLowerCase() !== repo.toLowerCase() ||
    pull.head.ref !== branch ||
    pull.base.ref !== baseRef ||
    pull.base.sha !== baseSha ||
    pull.head.sha !== headSha
  ) {
    throw new EmdashGithubUpgradeError(
      "The upgrade pull request or its base changed. Check for updates and prepare a new upgrade.",
    );
  }
}

/** Bounded operation: only two dependency files on a new, deterministic branch and its PR. */
export async function publishEmdashUpgrade(
  env: object,
  input: unknown,
  fetchImpl: typeof fetch = fetch,
): Promise<PublishedEmdashUpgrade> {
  const request = publishEmdashUpgradeRequestSchema.parse(input);
  const api = githubApi(env, request.tokenSecret, fetchImpl);
  const root = `/repos/${request.repo}`;
  const branch = emdashUpgradeBranch(request.upgradeId);
  const base = await api<{ object: { sha: string } }>(
    `${root}/git/ref/heads/${request.baseRef.split("/").map(encodeURIComponent).join("/")}`,
  );
  if (base?.object.sha !== request.baseSha)
    throw new EmdashGithubUpgradeError(
      "The source branch changed while preparing the upgrade. Prepare it again from the newest commit.",
    );
  const before = await api<string>(
    `${root}/contents/package.json?ref=${request.baseSha}`,
    "GET",
    undefined,
    false,
    true,
  );
  const packageFile = request.files.find((file) => file.path === "package.json");
  if (before === null || packageFile === undefined)
    throw new EmdashGithubUpgradeError("The original package.json is unavailable.");
  validateEmdashUpgradePackage(before, packageFile.content, request.targetVersion);
  for (const file of request.files)
    if (new TextEncoder().encode(file.content).byteLength > 2 * 1024 * 1024)
      throw new EmdashGithubUpgradeError("The upgrade's dependency files are too large.");

  let ref = await api<{ object: { sha: string } }>(
    `${root}/git/ref/heads/${branch}`,
    "GET",
    undefined,
    true,
  );
  if (ref === null) {
    const commit = await api<{ tree: { sha: string } }>(`${root}/git/commits/${request.baseSha}`);
    if (!commit?.tree.sha) throw new EmdashGithubUpgradeError("The source commit has no tree.");
    const tree = await api<{ sha: string }>(`${root}/git/trees`, "POST", {
      base_tree: commit.tree.sha,
      tree: request.files.map((file) => ({
        path: file.path,
        mode: "100644",
        type: "blob",
        content: file.content,
      })),
    });
    const created = await api<{ sha: string }>(`${root}/git/commits`, "POST", {
      message: `chore: update EmDash to ${request.targetVersion}`,
      tree: tree?.sha,
      parents: [request.baseSha],
    });
    if (!created?.sha)
      throw new EmdashGithubUpgradeError("GitHub did not create the dependency commit.");
    ref = await api<{ object: { sha: string } }>(`${root}/git/refs`, "POST", {
      ref: `refs/heads/${branch}`,
      sha: created.sha,
    });
  }
  if (!ref?.object.sha) throw new EmdashGithubUpgradeError("The upgrade branch is unavailable.");
  const headSha = ref.object.sha;
  const comparison = await api<{
    status: string;
    total_commits: number;
    files: { filename: string; status: string }[];
  }>(`${root}/compare/${request.baseSha}...${headSha}`);
  if (
    comparison?.status !== "ahead" ||
    comparison.total_commits !== 1 ||
    comparison.files.length !== 2 ||
    comparison.files.some(
      (file) =>
        !request.files.some((wanted) => wanted.path === file.filename) ||
        file.status !== "modified",
    )
  ) {
    throw new EmdashGithubUpgradeError(
      "The upgrade branch contains changes outside the prepared dependency update.",
    );
  }
  for (const file of request.files) {
    const persisted = await api<string>(
      `${root}/contents/${file.path}?ref=${headSha}`,
      "GET",
      undefined,
      false,
      true,
    );
    if (persisted !== file.content)
      throw new EmdashGithubUpgradeError(
        "The upgrade branch changed after preparation. Prepare a new upgrade.",
      );
  }
  const owner = request.repo.split("/")[0];
  const pulls = await api<Pull[]>(
    `${root}/pulls?state=all&head=${encodeURIComponent(`${owner}:${branch}`)}&base=${encodeURIComponent(request.baseRef)}&per_page=10`,
  );
  let pull = pulls?.[0];
  if (pull === undefined)
    pull =
      (await api<Pull>(`${root}/pulls`, "POST", {
        title: `Update EmDash to ${request.targetVersion}`,
        head: branch,
        base: request.baseRef,
        body: `Updates only emdash and @emdash-cms/cloudflare plus the pnpm lockfile. Theme, plugin declarations, configuration and other source files are preserved.\n\nPrepared and built in Appflare's sandbox. Review the Appflare build before merging. Database migrations require the saved pre-update recovery point; a code rollback does not undo database migrations.`,
      })) ?? undefined;
  if (pull === undefined)
    throw new EmdashGithubUpgradeError("GitHub did not create the upgrade pull request.");
  checkPull(pull, request.repo, branch, request.baseRef, request.baseSha, headSha);
  if (pull.state !== "open")
    throw new EmdashGithubUpgradeError(
      "This upgrade pull request is already closed. Prepare a new upgrade.",
    );
  return {
    branch,
    headSha,
    prNumber: pull.number,
    prUrl: `https://github.com/${request.repo}/pull/${pull.number}`,
  };
}

/** Merge the reviewed PR only; ordinary repository builds then compile its actual merge SHA. */
export async function mergeEmdashUpgrade(
  env: object,
  input: unknown,
  fetchImpl: typeof fetch = fetch,
): Promise<MergedEmdashUpgrade> {
  const request = mergeEmdashUpgradeRequestSchema.parse(input);
  const api = githubApi(env, request.tokenSecret, fetchImpl);
  const root = `/repos/${request.repo}`;
  const pull = await api<Pull>(`${root}/pulls/${request.prNumber}`);
  if (!pull) throw new EmdashGithubUpgradeError("The upgrade pull request is unavailable.");
  // GitHub may advance base.sha after merging. Verify the merge's parents instead on replay.
  checkPull(
    pull,
    request.repo,
    emdashUpgradeBranch(request.upgradeId),
    request.expectedBaseRef,
    pull.merged ? pull.base.sha : request.expectedBaseSha,
    request.expectedHeadSha,
  );
  if (pull.merged && pull.merge_commit_sha) {
    const commit = await api<{ parents: { sha: string }[] }>(
      `${root}/git/commits/${pull.merge_commit_sha}`,
    );
    if (
      commit?.parents.length !== 2 ||
      commit.parents[0]?.sha !== request.expectedBaseSha ||
      commit.parents[1]?.sha !== request.expectedHeadSha
    ) {
      throw new EmdashGithubUpgradeError(
        "The already merged pull request has different source parents. Review it on GitHub before rebuilding.",
      );
    }
    return { merged: true, mergeSha: pull.merge_commit_sha };
  }
  if (
    pull.state !== "open" ||
    pull.draft ||
    pull.mergeable !== true ||
    pull.mergeable_state !== "clean"
  ) {
    throw new EmdashGithubUpgradeError(
      "GitHub has not marked this upgrade ready to merge. Wait for its checks and required reviews, or resolve it on GitHub, then try again.",
    );
  }
  const base = await api<{ object: { sha: string } }>(
    `${root}/git/ref/heads/${pull.base.ref.split("/").map(encodeURIComponent).join("/")}`,
  );
  if (base?.object.sha !== request.expectedBaseSha)
    throw new EmdashGithubUpgradeError(
      "The source branch changed. Prepare a new upgrade so it includes those changes.",
    );
  const merged = await api<{ merged: boolean; sha: string }>(
    `${root}/pulls/${request.prNumber}/merge`,
    "PUT",
    { sha: request.expectedHeadSha, merge_method: "merge" },
  );
  if (!merged?.merged || !merged.sha)
    throw new EmdashGithubUpgradeError(
      "GitHub did not merge the upgrade. Check its required reviews and checks.",
    );
  // Read back the merge parent identities: never build a later branch head by accident.
  const commit = await api<{ parents: { sha: string }[] }>(`${root}/git/commits/${merged.sha}`);
  if (
    commit?.parents.length !== 2 ||
    commit.parents[0]?.sha !== request.expectedBaseSha ||
    commit.parents[1]?.sha !== request.expectedHeadSha
  ) {
    throw new EmdashGithubUpgradeError(
      "The merge includes a newer source revision. Review the merged commit on GitHub before rebuilding it.",
    );
  }
  return { merged: true, mergeSha: merged.sha };
}
