import { reset } from "cloudflare:test";
import { env } from "cloudflare:workers";
import type { EmdashUpgradeReport } from "@appflare/schema";
import { beforeEach, describe, expect, it } from "vitest";
import { writeAccountPlan } from "../account/plan.server";
import { createDb } from "../db/client";
import { createMigrator } from "../db/migrate";
import { migrations } from "../db/migrations/index";
import { fakeSandbox } from "../test/fake-sandbox";
import { fakeStep } from "../test/fake-step";
import { seedInstall } from "../test/seed-install";
import { type EmDashUpgradeJobParams, runEmdashUpgrade } from "./emdash-upgrade";

const BASE = "a".repeat(40);
const HEAD = "b".repeat(40);
const TOKEN_ID = "01J8TOKENCCCCCCCCCCCCCCCCC";
const BRANCH = "appflare/emdash-upgrade-1";
const params: EmDashUpgradeJobParams = {
  kind: "emdash_upgrade",
  jobId: "upgrade-1",
  upgradeId: "upgrade-1",
  installId: "i1",
  repo: "acme/blog",
  baseRef: "main",
  baseSha: BASE,
  targetVersion: "1.3.0",
  readToken: null,
  writeToken: { id: TOKEN_ID, label: "Upgrade" },
  buildId: "pr-build",
  costConfirmed: true,
};
const report: EmdashUpgradeReport = {
  fromVersion: "1.1.0",
  targetVersion: "1.3.0",
  plugins: [],
  beforeMigrations: { emdashVersion: "1.1.0", names: [], fingerprint: "old" },
  afterMigrations: { emdashVersion: "1.3.0", names: ["0010.sql"], fingerprint: "new" },
  addedMigrations: ["0010.sql"],
  preservedPaths: ["theme", "plugins", "configuration"],
  buildVerified: true,
};
function pkt(value: string) {
  return `${(value.length + 4).toString(16).padStart(4, "0")}${value}`;
}
const ADVERTISEMENT = `${pkt("# service=git-upload-pack\n")}0000${pkt(`${BASE} HEAD\0symref=HEAD:refs/heads/main\n`)}${pkt(`${BASE} refs/heads/main\n`)}${pkt(`${HEAD} refs/heads/${BRANCH}\n`)}0000`;

beforeEach(async () => {
  await reset();
  await createMigrator(migrations).ensure(env.DB);
  await seedInstall();
  await writeAccountPlan(createDb(env.DB), "paid");
  await env.DB.prepare(
    "UPDATE installs SET origin='repository',source_url='https://github.com/acme/blog',source_ref='main',pin_sha=?1 WHERE id='i1'",
  )
    .bind(BASE)
    .run();
  await env.DB.prepare(
    "INSERT INTO github_tokens (id,label,repositories,for_builds,for_releases,for_repository_updates,created_at) VALUES (?1,'Upgrade','acme/blog',0,0,1,1)",
  )
    .bind(TOKEN_ID)
    .run();
  await env.DB.prepare(
    "INSERT INTO jobs (id,install_id,kind,status,input_json,started_by) VALUES ('upgrade-1','i1','emdash_upgrade','queued','{}','admin')",
  ).run();
  await env.DB.prepare(
    "INSERT INTO emdash_upgrades (id,install_id,repo,base_ref,base_sha,target_version,status,preparation_job_id,write_token_id,created_at,updated_at) VALUES ('upgrade-1','i1','acme/blog','main',?1,'1.3.0','preparing','upgrade-1',?2,1,1)",
  )
    .bind(BASE, TOKEN_ID)
    .run();
});

function setup(incompatible = false) {
  const sandbox = fakeSandbox(null, {
    info: {
      protocol: 1,
      sandboxVersion: "0.1.8",
      image: "test",
      features: ["repository-builds", "github-tokens", "emdash-upgrades"],
    },
  });
  let publishCalls = 0;
  const creations: Array<unknown> = [];
  sandbox.prepareEmdashUpgrade = async () => ({
    ok: true,
    baseSha: BASE,
    targetVersion: "1.3.0",
    files: [
      { path: "package.json", content: "{}" },
      { path: "pnpm-lock.yaml", content: "new lock" },
    ],
    report: {
      ...report,
      plugins: incompatible
        ? [{ name: "custom-plugin", version: "1.0.0", range: "<1.3.0", compatible: false }]
        : [],
    },
  });
  sandbox.publishEmdashUpgrade = async () => {
    publishCalls++;
    return {
      branch: BRANCH,
      headSha: HEAD,
      prNumber: 7,
      prUrl: "https://github.com/acme/blog/pull/7",
    };
  };
  const jobEnv = {
    DB: env.DB,
    SANDBOX: sandbox,
    JOBS: {
      create: async (input: { id: string; params: unknown }) => {
        creations.push(input);
        return { id: input.id };
      },
    },
  };
  const fetcher = async (url: string) => {
    if (url.includes("info/refs")) return new Response(ADVERTISEMENT);
    throw new Error(`Unexpected URL ${url}`);
  };
  return { sandbox, jobEnv, creations, published: () => publishCalls, fetcher };
}

describe("EmDash upgrade preparation job", () => {
  it("publishes only a review PR, then builds its actual commit without deploying", async () => {
    const test = setup();
    await runEmdashUpgrade({
      params,
      step: fakeStep(),
      env: test.jobEnv,
      deps: { fetch: test.fetcher },
    });
    expect(test.published()).toBe(1);
    expect(test.creations).toEqual([
      {
        id: "pr-build",
        params: expect.objectContaining({
          kind: "source_build",
          installId: "i1",
          commit: HEAD,
          ref: BRANCH,
        }),
      },
    ]);
    expect(
      await env.DB.prepare(
        "SELECT status,build_id,head_sha FROM emdash_upgrades WHERE id='upgrade-1'",
      ).first(),
    ).toEqual({ status: "building", build_id: "pr-build", head_sha: HEAD });
    expect(
      await env.DB.prepare(
        "SELECT status,current_version_id,source_ref FROM installs WHERE id='i1'",
      ).first(),
    ).toMatchObject({
      status: "installed",
      source_ref: "main",
      current_version_id: "99999999-8888-4777-8666-555555555555",
    });
    expect(await env.DB.prepare("SELECT status FROM jobs WHERE id='upgrade-1'").first()).toEqual({
      status: "succeeded",
    });
  });
  it("refuses a known incompatible plugin before publishing any source change", async () => {
    const test = setup(true);
    await expect(
      runEmdashUpgrade({
        params,
        step: fakeStep(),
        env: test.jobEnv,
        deps: { fetch: test.fetcher },
      }),
    ).rejects.toThrow(/incompatibility/);
    expect(test.published()).toBe(0);
    expect(test.creations).toHaveLength(0);
    expect(
      await env.DB.prepare("SELECT status FROM emdash_upgrades WHERE id='upgrade-1'").first(),
    ).toEqual({ status: "failed" });
    expect(await env.DB.prepare("SELECT status FROM installs WHERE id='i1'").first()).toEqual({
      status: "installed",
    });
  });
});
