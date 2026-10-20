import { describe, expect, it, vi } from "vitest";
import {
  mergeEmdashUpgrade,
  publishEmdashUpgrade,
  validateEmdashUpgradePackage,
} from "./emdash-upgrade-github";

const base = "a".repeat(40),
  head = "b".repeat(40),
  merged = "c".repeat(40);
const repo = "example/blog",
  upgradeId = "upgrade-1",
  branch = "appflare/emdash-upgrade-1";
const tokenSecret = "GITHUB_TOKEN_01ABCDEFGHJK";
const env = { [tokenSecret]: "test-credential-never-log" };
const original = {
  scripts: { build: "astro build" },
  dependencies: {
    emdash: "^1.1.0",
    "@emdash-cms/cloudflare": "^1.1.0",
    "@orangecrm/emdash": "file:vendor/custom.tgz",
  },
};
const next = {
  ...original,
  dependencies: { ...original.dependencies, emdash: "^1.3.0", "@emdash-cms/cloudflare": "^1.3.0" },
};
const files = [
  { path: "package.json", content: JSON.stringify(next) },
  { path: "pnpm-lock.yaml", content: "lockfileVersion: '9.0'\nupdated: true\n" },
];
const publish = {
  protocol: 1,
  upgradeId,
  repo,
  baseRef: "main",
  baseSha: base,
  targetVersion: "1.3.0",
  tokenSecret,
  files,
};
const merge = {
  protocol: 1,
  upgradeId,
  repo,
  prNumber: 7,
  expectedBaseRef: "main",
  expectedBaseSha: base,
  expectedHeadSha: head,
  tokenSecret,
};
const pull = () => ({
  number: 7,
  state: "open",
  draft: false,
  merged: false,
  mergeable: true,
  mergeable_state: "clean",
  base: { ref: "main", sha: base, repo: { full_name: repo } },
  head: { ref: branch, sha: head, repo: { full_name: repo } },
});
const json = (value: unknown, status = 200) => new Response(JSON.stringify(value), { status });

function api(
  options: {
    existing?: boolean;
    movedBase?: boolean;
    unsafeDiff?: boolean;
    pull?: ReturnType<typeof pull> & { merge_commit_sha?: string };
  } = {},
) {
  return vi.fn<typeof fetch>(async (input, init) => {
    const url = new URL(String(input)),
      method = init?.method ?? "GET";
    expect(url.origin).toBe("https://api.github.com");
    expect(init?.redirect).toBe("manual");
    expect(new Headers(init?.headers).get("authorization")).toBe(`Bearer ${env[tokenSecret]}`);
    const path = url.pathname.replace(`/repos/${repo}`, "");
    if (path === "/git/ref/heads/main")
      return json({ object: { sha: options.movedBase ? "e".repeat(40) : base } });
    if (path === "/contents/package.json")
      return new Response(
        url.searchParams.get("ref") === base ? JSON.stringify(original) : files[0]?.content,
      );
    if (path === "/contents/pnpm-lock.yaml") return new Response(files[1]?.content);
    if (path === `/git/ref/heads/${branch}`)
      return options.existing ? json({ object: { sha: head } }) : json({}, 404);
    if (path === `/git/commits/${base}`) return json({ tree: { sha: "d".repeat(40) } });
    if (path === `/git/commits/${merged}`) return json({ parents: [{ sha: base }, { sha: head }] });
    if (path === "/git/trees" && method === "POST") {
      expect(
        JSON.parse(String(init?.body)).tree.map((file: { path: string }) => file.path),
      ).toEqual(["package.json", "pnpm-lock.yaml"]);
      return json({ sha: "f".repeat(40) });
    }
    if (path === "/git/commits" && method === "POST") {
      expect(JSON.parse(String(init?.body)).parents).toEqual([base]);
      return json({ sha: head });
    }
    if (path === "/git/refs" && method === "POST") return json({ object: { sha: head } });
    if (path.startsWith("/compare/"))
      return json({
        status: "ahead",
        total_commits: 1,
        files: [
          { filename: "package.json", status: "modified" },
          {
            filename: options.unsafeDiff ? "src/theme.astro" : "pnpm-lock.yaml",
            status: "modified",
          },
        ],
      });
    if (path === "/pulls" && method === "GET") return json(options.existing ? [pull()] : []);
    if (path === "/pulls" && method === "POST") return json(pull());
    if (path === "/pulls/7" && method === "GET") return json(options.pull ?? pull());
    if (path === "/pulls/7/merge" && method === "PUT") {
      expect(JSON.parse(String(init?.body))).toEqual({ sha: head, merge_method: "merge" });
      return json({ merged: true, sha: merged });
    }
    throw new Error(`Unexpected mock API request: ${method} ${path}`);
  });
}

describe("dependency-only GitHub writes", () => {
  it("preserves theme/plugin declarations and scripts while changing only the two versions", () => {
    expect(() =>
      validateEmdashUpgradePackage(JSON.stringify(original), JSON.stringify(next), "1.3.0"),
    ).not.toThrow();
    expect(() =>
      validateEmdashUpgradePackage(
        JSON.stringify(original),
        JSON.stringify({ ...next, scripts: { build: "other" } }),
        "1.3.0",
      ),
    ).toThrow("more than");
    expect(() =>
      validateEmdashUpgradePackage(
        JSON.stringify(original),
        JSON.stringify({
          ...next,
          dependencies: { ...next.dependencies, "@orangecrm/emdash": "latest" },
        }),
        "1.3.0",
      ),
    ).toThrow("more than");
  });
  it("publishes an atomic dependency commit on a new branch and PR", async () => {
    const fetch = api();
    expect(await publishEmdashUpgrade(env, publish, fetch)).toEqual({
      branch,
      headSha: head,
      prNumber: 7,
      prUrl: `https://github.com/${repo}/pull/7`,
    });
    expect(fetch.mock.calls.filter(([, init]) => init?.method === "POST")).toHaveLength(4);
  });
  it("resumes the same branch and PR without another commit or PR", async () => {
    const fetch = api({ existing: true });
    expect((await publishEmdashUpgrade(env, publish, fetch)).headSha).toBe(head);
    expect(fetch.mock.calls.some(([, init]) => init?.method === "POST")).toBe(false);
  });
  it("rejects an unexpected file before contacting GitHub", async () => {
    const fetch = api();
    await expect(
      publishEmdashUpgrade(
        env,
        {
          ...publish,
          files: [files[0], { path: ".github/workflows/deploy.yml", content: "unexpected" }],
        },
        fetch,
      ),
    ).rejects.toThrow();
    expect(fetch).not.toHaveBeenCalled();
  });
  it("refuses stale source revisions without any writes", async () => {
    const fetch = api({ movedBase: true });
    await expect(publishEmdashUpgrade(env, publish, fetch)).rejects.toThrow(
      "source branch changed",
    );
    expect(fetch.mock.calls.every(([, init]) => init?.method === "GET")).toBe(true);
  });
  it("refuses scripts changed by a build before any writes", async () => {
    const fetch = api();
    await expect(
      publishEmdashUpgrade(
        env,
        {
          ...publish,
          files: [
            { ...files[0], content: JSON.stringify({ ...next, scripts: { build: "changed" } }) },
            files[1],
          ],
        },
        fetch,
      ),
    ).rejects.toThrow("more than");
    expect(fetch.mock.calls.every(([, init]) => init?.method === "GET")).toBe(true);
  });
  it("refuses an existing upgrade branch with changes outside dependency files", async () => {
    const fetch = api({ existing: true, unsafeDiff: true });
    await expect(publishEmdashUpgrade(env, publish, fetch)).rejects.toThrow("outside");
    expect(fetch.mock.calls.every(([, init]) => init?.method === "GET")).toBe(true);
  });
});

describe("reviewed merge", () => {
  it("merges only the reviewed SHA and verifies both merge parents", async () => {
    expect(await mergeEmdashUpgrade(env, merge, api())).toEqual({ merged: true, mergeSha: merged });
  });
  it("waits for GitHub checks and reviews", async () => {
    const fetch = api({ pull: { ...pull(), mergeable_state: "blocked" } });
    await expect(mergeEmdashUpgrade(env, merge, fetch)).rejects.toThrow(
      "checks and required reviews",
    );
    expect(fetch.mock.calls.some(([, init]) => init?.method === "PUT")).toBe(false);
  });
  it("refuses a changed PR head", async () => {
    const current = pull();
    current.head.sha = "e".repeat(40);
    const fetch = api({ pull: current });
    await expect(mergeEmdashUpgrade(env, merge, fetch)).rejects.toThrow("changed");
    expect(fetch.mock.calls.some(([, init]) => init?.method === "PUT")).toBe(false);
  });
  it("refuses a PR retargeted to another branch even at the same base SHA", async () => {
    const current = pull();
    current.base.ref = "other-branch";
    const fetch = api({ pull: current });
    await expect(mergeEmdashUpgrade(env, merge, fetch)).rejects.toThrow("changed");
    expect(fetch.mock.calls.some(([, init]) => init?.method === "PUT")).toBe(false);
  });
  it("recovers a completed merge even after GitHub advances its base metadata", async () => {
    const current = { ...pull(), merged: true, state: "closed", merge_commit_sha: merged };
    current.base.sha = merged;
    const fetch = api({ pull: current });
    expect(await mergeEmdashUpgrade(env, merge, fetch)).toEqual({ merged: true, mergeSha: merged });
    expect(fetch.mock.calls.some(([, init]) => init?.method === "PUT")).toBe(false);
  });
});
