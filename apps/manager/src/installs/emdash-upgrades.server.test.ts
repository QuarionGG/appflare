import { reset } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { beforeEach, describe, expect, it } from "vitest";
import { writeAccountPlan } from "../account/plan.server";
import { createDb } from "../db/client";
import { createMigrator } from "../db/migrate";
import { migrations } from "../db/migrations/index";
import { sandboxInfo } from "../sandbox/binding";
import { fakeSandbox } from "../test/fake-sandbox";
import { seedInstall } from "../test/seed-install";
import {
  checkEmdashUpgradeCore,
  type EmDashUpgradeDeps,
  emdashWriteToken,
  latestEmdashUpgrade,
  mergeAndBuildEmdashUpgradeCore,
  prepareEmdashUpgradeCore,
} from "./emdash-upgrades.server";
import { assertEmdashUpgradeBuildDeployable } from "./source-builds.server";

const BASE = "a".repeat(40);
const HEAD = "b".repeat(40);
const MERGED = "c".repeat(40);
const NEWER = "d".repeat(40);
const TOKEN_ID = "01J8TOKENCCCCCCCCCCCCCCCCC";
const REPORT = {
  fromVersion: "1.1.0",
  targetVersion: "1.3.0",
  plugins: [],
  beforeMigrations: { emdashVersion: "1.1.0", names: [], fingerprint: "before" },
  afterMigrations: { emdashVersion: "1.3.0", names: [], fingerprint: "after" },
  addedMigrations: [],
  preservedPaths: ["theme", "plugins", "configuration"],
  buildVerified: true,
};
const PKG = {
  packageManager: "pnpm@10.34.1",
  dependencies: {
    emdash: "^1.1.0",
    "@emdash-cms/cloudflare": "^1.1.0",
    "@orangecrm/emdash": "file:vendor/custom.tgz",
  },
};
const LOCK =
  "importers:\n  .:\n    dependencies:\n      emdash:\n        specifier: ^1.1.0\n        version: 1.1.0(astro@7.0.0)\npackages:\n";
function pkt(value: string) {
  return `${(value.length + 4).toString(16).padStart(4, "0")}${value}`;
}
const ADVERTISEMENT = `${pkt("# service=git-upload-pack\n")}0000${pkt(`${BASE} HEAD\0symref=HEAD:refs/heads/main\n`)}${pkt(`${BASE} refs/heads/main\n`)}0000`;

async function writer(repo = "acme/blog", forBuilds = false) {
  await env.DB.prepare(
    "INSERT INTO github_tokens (id,label,repositories,for_builds,for_releases,for_repository_updates,created_at) VALUES (?1,'Upgrade',?2,?3,0,1,1)",
  )
    .bind(TOKEN_ID, repo, forBuilds ? 1 : 0)
    .run();
}
function dependencies() {
  const sandbox = fakeSandbox(null, {
    info: {
      protocol: 1,
      sandboxVersion: "0.1.8",
      image: "test",
      features: ["repository-builds", "github-tokens", "emdash-upgrades"],
    },
  });
  const jobs: Array<{ id: string; params: unknown }> = [];
  const requests: Array<{ url: string; accept: string | null }> = [];
  const fetcher = async (url: string, init?: RequestInit) => {
    const accept = new Headers(init?.headers).get("accept");
    requests.push({ url, accept });
    if (url.includes("info/refs")) return new Response(ADVERTISEMENT);
    if (url.includes("/contents/")) {
      if (accept !== "application/vnd.github.raw+json")
        return new Response("Not Acceptable", { status: 406 });
      if (url.includes("/contents/package.json?")) return new Response(JSON.stringify(PKG));
      if (url.includes("/contents/pnpm-lock.yaml?")) return new Response(LOCK);
    }
    if (url.startsWith("https://registry.npmjs.org/"))
      return accept === "application/json"
        ? Response.json({ version: "1.3.0" })
        : new Response("Not Acceptable", { status: 406 });
    throw new Error(`Unexpected test request ${url}`);
  };
  let sequence = 0;
  const createJob = async (id: string, params: unknown) => {
    jobs.push({ id, params });
    return { id };
  };
  const deps: EmDashUpgradeDeps = {
    db: env.DB,
    reader: { db: env.DB, fetch: fetcher, sandbox },
    fetch: fetcher,
    sandbox,
    createJob,
    newId: () => `upgrade-${++sequence}`,
    sourceBuild: {
      db: env.DB,
      createJob,
      sandbox: async () => ({ connected: true, info: await sandboxInfo(sandbox) }),
      listRefs: async () => ({
        refs: new Map([
          ["HEAD", NEWER],
          ["refs/heads/main", NEWER],
        ]),
        head: "refs/heads/main",
      }),
      loadCatalogApp: async () => {
        throw new Error("catalog must not be read");
      },
    },
  };
  return { deps, sandbox, jobs, requests };
}

beforeEach(async () => {
  await reset();
  await createMigrator(migrations).ensure(env.DB);
  await seedInstall();
  await writeAccountPlan(createDb(env.DB), "paid");
  await env.DB.prepare(
    "UPDATE installs SET origin='repository', source_url='https://github.com/acme/blog', source_ref='main', pin_sha=?1 WHERE id='i1'",
  )
    .bind(BASE)
    .run();
});

describe("custom EmDash upgrade orchestration", () => {
  it("requests npm release metadata as JSON and GitHub source files as raw content", async () => {
    const { deps, requests } = dependencies();
    await checkEmdashUpgradeCore(deps, "i1");
    expect(requests.filter(({ url }) => url.startsWith("https://registry.npmjs.org/"))).toEqual([
      { url: "https://registry.npmjs.org/emdash/latest", accept: "application/json" },
      {
        url: "https://registry.npmjs.org/@emdash-cms%2fcloudflare/latest",
        accept: "application/json",
      },
    ]);
    expect(
      requests
        .filter(({ url }) => url.includes("/contents/"))
        .every(({ accept }) => accept === "application/vnd.github.raw+json"),
    ).toBe(true);
  });
  it("reports locked core and preserves custom plugin declarations", async () => {
    const { deps } = dependencies();
    const plan = await checkEmdashUpgradeCore(deps, "i1");
    expect(plan).toMatchObject({
      supported: true,
      sourceVersion: "1.1.0",
      installedVersion: "1.1.0",
      targetVersion: "1.3.0",
      baseSha: BASE,
      writeTokenAvailable: false,
    });
    expect(plan.plugins).toEqual([
      { name: "@orangecrm/emdash", version: "file:vendor/custom.tgz" },
    ]);
  });
  it("refuses catalog installs and never repurposes the existing read/build token", async () => {
    await writer("acme/blog", true);
    expect(await emdashWriteToken(env.DB, "acme/blog")).toBeNull();
    const { deps } = dependencies();
    await expect(
      prepareEmdashUpgradeCore(deps, {
        installId: "i1",
        expectedBaseSha: BASE,
        targetVersion: "1.3.0",
        costConfirmed: true,
      }),
    ).rejects.toThrow(/repository update token/);
    await env.DB.prepare("UPDATE installs SET origin='catalog' WHERE id='i1'").run();
    expect((await checkEmdashUpgradeCore(deps, "i1")).supported).toBe(false);
  });
  it("rejects stale checks before creating a job and claims preparations once", async () => {
    await writer();
    const { deps, jobs } = dependencies();
    await expect(
      prepareEmdashUpgradeCore(deps, {
        installId: "i1",
        expectedBaseSha: HEAD,
        targetVersion: "1.3.0",
        costConfirmed: true,
      }),
    ).rejects.toThrow(/changed/);
    expect(jobs).toHaveLength(0);
    await prepareEmdashUpgradeCore(deps, {
      installId: "i1",
      expectedBaseSha: BASE,
      targetVersion: "1.3.0",
      costConfirmed: true,
    });
    expect(jobs).toHaveLength(1);
    expect(jobs[0]?.params).toMatchObject({ writeToken: { id: TOKEN_ID } });
    await expect(
      prepareEmdashUpgradeCore(deps, {
        installId: "i1",
        expectedBaseSha: BASE,
        targetVersion: "1.3.0",
        costConfirmed: true,
      }),
    ).rejects.toThrow(/active/);
  });
  it("never permits a pull request artifact to deploy, including after its merge", async () => {
    await env.DB.prepare(
      "INSERT INTO emdash_upgrades (id,install_id,repo,base_ref,base_sha,target_version,status,preparation_job_id,build_id,merge_sha,merged_build_id,created_at,updated_at) VALUES ('u','i1','acme/blog','main',?1,'1.3.0','merged','prep','pr-build',?2,'merged-build',1,1)",
    )
      .bind(BASE, MERGED)
      .run();
    await expect(assertEmdashUpgradeBuildDeployable(env.DB, "pr-build")).rejects.toThrow(
      /Merge it/,
    );
    await expect(
      assertEmdashUpgradeBuildDeployable(env.DB, "merged-build"),
    ).resolves.toBeUndefined();
  });
  it("builds the verified merge SHA while retaining the main source branch", async () => {
    await writer();
    const { deps, sandbox, jobs } = dependencies();
    await env.DB.prepare(
      "INSERT INTO source_builds (id,install_id,purpose,origin,repo,status,created_at,updated_at) VALUES ('pr-build','i1','update','repository','acme/blog','built',1,1)",
    ).run();
    await env.DB.prepare(
      "INSERT INTO emdash_upgrades (id,install_id,repo,base_ref,base_sha,target_version,status,preparation_job_id,build_id,head_sha,pr_number,write_token_id,report_json,created_at,updated_at) VALUES ('u','i1','acme/blog','main',?1,'1.3.0','ready','prep','pr-build',?2,5,?3,?4,1,1)",
    )
      .bind(BASE, HEAD, TOKEN_ID, JSON.stringify(REPORT))
      .run();
    let mergedRequest: unknown;
    sandbox.mergeEmdashUpgrade = async (input) => {
      mergedRequest = input;
      return { merged: true, mergeSha: MERGED };
    };
    await mergeAndBuildEmdashUpgradeCore(deps, { upgradeId: "u", costConfirmed: true });
    expect(mergedRequest).toMatchObject({
      expectedBaseSha: BASE,
      expectedHeadSha: HEAD,
      expectedBaseRef: "main",
    });
    expect(jobs[0]?.params).toMatchObject({
      kind: "source_build",
      commit: MERGED,
      ref: "main",
      installId: "i1",
    });
    expect(await env.DB.prepare("SELECT source_ref FROM installs WHERE id='i1'").first()).toEqual({
      source_ref: "main",
    });
    expect(
      await env.DB.prepare(
        "SELECT build_id,merged_build_id,merge_sha FROM emdash_upgrades WHERE id='u'",
      ).first(),
    ).toMatchObject({ build_id: "pr-build", merge_sha: MERGED });
  });
  it("releases a discarded pull request review so a new upgrade can be prepared", async () => {
    await env.DB.prepare(
      "INSERT INTO source_builds (id,install_id,purpose,origin,repo,status,created_at,updated_at) VALUES ('discarded-pr','i1','update','repository','acme/blog','discarded',1,1)",
    ).run();
    await env.DB.prepare(
      "INSERT INTO emdash_upgrades (id,install_id,repo,base_ref,base_sha,target_version,status,preparation_job_id,build_id,created_at,updated_at) VALUES ('u','i1','acme/blog','main',?1,'1.3.0','ready','prep','discarded-pr',1,1)",
    )
      .bind(BASE)
      .run();
    expect((await latestEmdashUpgrade(env.DB, "i1"))?.status).toBe("failed");
    expect(await env.DB.prepare("SELECT status FROM emdash_upgrades WHERE id='u'").first()).toEqual(
      { status: "failed" },
    );
  });
});
