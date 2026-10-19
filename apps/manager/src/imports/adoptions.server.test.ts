import { reset } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { createClient, type FetchLike, type WorkerScript } from "@appflare/cf-api";
import { buildKeys } from "@appflare/schema";
import { beforeEach, describe, expect, it } from "vitest";
import { createDb } from "../db/client";
import { createMigrator } from "../db/migrate";
import { migrations } from "../db/migrations/index";
import { installs, resources, source_builds } from "../db/schema";
import { SETTING, writeSettings } from "../db/settings";
import { updateFromSourceBuildCore } from "../installs/source-builds.server";
import { repositoryAppSlug } from "../installs/source-review";
import { diffBindings } from "../jobs/update/plan";
import { buildArtifactFixture } from "../test/artifact-fixture";
import { ACC, SUBDOMAIN } from "../test/fake-account";
import { adoptImportedAppCore, previewAdoptionCore } from "./adoptions.server";
import { getImportedAppCore, importExistingAppCore, previewImportCore } from "./imports.server";

const source = {
  displayName: "QuarionGG blog",
  appName: "EmDash custom",
  repository: "quariongg/custom-blog",
  ref: "main",
};

function fakeCloudflare() {
  const calls: string[] = [];
  const scripts: WorkerScript[] = [
    {
      id: "site",
      handlers: ["fetch"],
      routes: [{ id: "existing-route", pattern: "blog.example.com/blog/*" }],
    },
  ];
  const bindings: Record<string, unknown>[] = [
    { name: "DB", type: "d1", id: "original-db" },
    { name: "MEDIA", type: "r2_bucket", bucket_name: "original-media" },
    { name: "SESSION", type: "kv_namespace", namespace_id: "original-session" },
    { name: "KEY", type: "secret_text", text: "never-persist-this-secret" },
    { name: "SITE_NAME", type: "plain_text", text: "Original blog" },
    { name: "OPTIONS", type: "json", json: { enabled: true } },
    { name: "ASSETS", type: "assets" },
    { name: "IMAGES", type: "images" },
    { name: "LOADER", type: "worker_loader" },
  ];
  let version = "original-worker-version";
  let schedule = "0 * * * *";
  let failBindings = false;
  let bookmark = "original-bookmark";
  const fetch: FetchLike = async (input, init) => {
    const url = new URL(input);
    const path = url.pathname.replace(`/client/v4/accounts/${ACC}`, "");
    const method = init?.method ?? "GET";
    calls.push(`${method} ${path}`);
    if (method !== "GET") throw new Error("Adoption attempted a Cloudflare mutation");
    if (failBindings && path.endsWith("/bindings")) {
      return Response.json(
        { success: false, errors: [{ code: 10000, message: "cannot read" }] },
        { status: 403 },
      );
    }
    let result: unknown;
    if (path === "/workers/scripts") result = scripts;
    else if (path.endsWith("/bindings")) result = bindings;
    else if (path.endsWith("/schedules")) result = { schedules: [{ cron: schedule }] };
    else if (path.endsWith("/subdomain")) result = { enabled: false };
    else if (path.endsWith("/deployments"))
      result = {
        deployments: [
          {
            id: "original-deployment",
            created_on: "2026-10-01T00:00:00Z",
            source: "wrangler",
            versions: [{ version_id: version, percentage: 100 }],
          },
        ],
      };
    else if (path === "/workers/domains")
      result = [
        {
          id: "original-domain",
          hostname: "blog.example.com",
          zone_name: "example.com",
          service: "site",
          zone_id: "zone",
        },
      ];
    else if (path === "/d1/database")
      result = [{ uuid: "original-db", name: "existing-blog-data" }];
    else if (path === "/storage/kv/namespaces")
      result = [{ id: "original-session", title: "existing-sessions" }];
    else if (path === "/d1/database/original-db/time_travel/bookmark") result = { bookmark };
    else throw new Error(`Unexpected read: ${path}`);
    return Response.json({ success: true, result });
  };
  return {
    api: createClient({ accountId: ACC, token: "token", fetch }),
    calls,
    scripts,
    bindings,
    setVersion(value: string) {
      version = value;
    },
    setSchedule(value: string) {
      schedule = value;
    },
    failBindings() {
      failBindings = true;
    },
    setBookmark(value: string) {
      bookmark = value;
    },
  };
}

async function saveImport(fake: ReturnType<typeof fakeCloudflare>, workers = ["site"]) {
  const selection = { workerNames: workers, primaryWorker: "site", displayName: "Existing blog" };
  const deps = { db: env.DB, api: fake.api };
  const preview = await previewImportCore(deps, selection);
  return importExistingAppCore(deps, { ...selection, fingerprint: preview.fingerprint });
}

beforeEach(async () => {
  await reset();
  await createMigrator(migrations).ensure(env.DB);
  await writeSettings(createDb(env.DB), {
    [SETTING.accountId]: ACC,
    [SETTING.workerName]: "manager",
    [SETTING.accountSubdomain]: SUBDOMAIN,
  });
});

describe("managing an imported deployment", () => {
  it("previews without writes and atomically adopts exact Worker, resources, settings and baseline", async () => {
    const fake = fakeCloudflare();
    const imported = await saveImport(fake);
    const deps = { db: env.DB, api: fake.api, now: () => 1234 };
    const input = { ...source, appId: imported.id };
    const preview = await previewAdoptionCore(deps, input);
    expect(preview).toMatchObject({
      repository: "https://github.com/quariongg/custom-blog",
      currentVersionId: "original-worker-version",
      workerName: "site",
      address: "https://blog.example.com",
    });
    expect((await env.DB.prepare("SELECT * FROM installs").all()).results).toEqual([]);
    expect(await getImportedAppCore(env.DB, imported.id)).toEqual(imported);
    const result = await adoptImportedAppCore(deps, { ...input, fingerprint: preview.fingerprint });
    expect(result.installId).toBe(imported.id);
    expect(await getImportedAppCore(env.DB, imported.id)).toBeNull();
    const install = await env.DB.prepare("SELECT * FROM installs WHERE id = ?1")
      .bind(imported.id)
      .first();
    expect(install).toMatchObject({
      worker_name: "site",
      display_name: source.displayName,
      catalog_version: "Existing deployment",
      artifact_url: "",
      artifact_digest: null,
      manifest_json: null,
      build_kind: "adopted",
      origin: "repository",
      source_url: "https://github.com/quariongg/custom-blog",
      source_ref: "main",
      pin_sha: null,
      auto_update: "off",
      catalog_id: null,
      status: "installed",
      current_version_id: "original-worker-version",
      workers_dev_enabled: 0,
      workers_dev_choice: "manual",
      served_domain: "blog.example.com",
    });
    expect(JSON.parse(install?.config_json as string)).toEqual({
      SITE_NAME: "Original blog",
      OPTIONS: '{"enabled":true}',
    });
    const rows = (
      await env.DB.prepare("SELECT * FROM resources WHERE install_id = ?1").bind(imported.id).all()
    ).results;
    expect(rows).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: `${imported.id}:d1:DB`,
          binding: "DB",
          cf_id: "original-db",
          name: "existing-blog-data",
          managed_by: "appflare",
        }),
        expect.objectContaining({
          id: `${imported.id}:r2:MEDIA`,
          binding: "MEDIA",
          cf_id: "original-media",
        }),
        expect.objectContaining({
          id: `${imported.id}:kv:SESSION`,
          binding: "SESSION",
          cf_id: "original-session",
          name: "existing-sessions",
        }),
        expect.objectContaining({ kind: "secret", binding: "KEY", name: "KEY" }),
        expect.objectContaining({ kind: "cron", name: "0 * * * *" }),
        expect.objectContaining({
          kind: "domain",
          name: "blog.example.com",
          cf_id: "original-domain",
        }),
        expect.objectContaining({
          kind: "worker_route",
          name: "blog.example.com/blog/*",
          cf_id: null,
          managed_by: "app",
        }),
      ]),
    );
    const adoption = await env.DB.prepare("SELECT * FROM install_adoptions").first();
    expect(adoption).toMatchObject({
      install_id: imported.id,
      imported_app_id: imported.id,
      app_name: source.appName,
    });
    expect(JSON.parse(adoption?.inventory_json as string)).toEqual(imported);
    const snapshot = await env.DB.prepare("SELECT * FROM snapshots").first();
    expect(snapshot).toMatchObject({
      install_id: imported.id,
      worker_version_id: "original-worker-version",
      build_kind: "adopted",
      origin: "repository",
      artifact_url: "",
      manifest_json: null,
      d1_bookmarks_json: '{"original-db":"original-bookmark"}',
    });
    expect(await env.DB.prepare("SELECT kind, status FROM jobs").first()).toEqual({
      kind: "adopt",
      status: "succeeded",
    });
    expect(JSON.stringify({ install, rows, adoption, snapshot })).not.toContain(
      "never-persist-this-secret",
    );
    expect(fake.calls.every((call) => call.startsWith("GET "))).toBe(true);
  });

  it("requires a new review when the live deployment, schedules, vars or source choices change", async () => {
    const fake = fakeCloudflare();
    const imported = await saveImport(fake);
    const deps = { db: env.DB, api: fake.api };
    const input = { ...source, appId: imported.id };
    const preview = await previewAdoptionCore(deps, input);
    fake.setVersion("changed-version");
    await expect(
      adoptImportedAppCore(deps, { ...input, fingerprint: preview.fingerprint }),
    ).rejects.toThrow("changed since the preview");
    fake.setVersion("original-worker-version");
    fake.setSchedule("30 * * * *");
    await expect(
      adoptImportedAppCore(deps, { ...input, fingerprint: preview.fingerprint }),
    ).rejects.toThrow("changed since the preview");
    fake.setSchedule("0 * * * *");
    const siteName = fake.bindings.find((binding) => binding.name === "SITE_NAME");
    if (siteName === undefined) throw new Error("Missing SITE_NAME fixture");
    siteName.text = "Changed blog";
    await expect(
      adoptImportedAppCore(deps, { ...input, fingerprint: preview.fingerprint }),
    ).rejects.toThrow("changed since the preview");
    siteName.text = "Original blog";
    await expect(
      adoptImportedAppCore(deps, { ...input, ref: "custom", fingerprint: preview.fingerprint }),
    ).rejects.toThrow("changed since the preview");
    expect(await getImportedAppCore(env.DB, imported.id)).toEqual(imported);
    expect((await env.DB.prepare("SELECT * FROM installs").all()).results).toEqual([]);
  });

  it("refuses incomplete inventory and binding lifecycles it cannot yet manage", async () => {
    const fake = fakeCloudflare();
    const imported = await saveImport(fake);
    const deps = { db: env.DB, api: fake.api };
    for (const type of ["durable_object_namespace", "queue", "workflow", "service"]) {
      fake.bindings.push({ name: "UNSUPPORTED", type });
      await expect(previewAdoptionCore(deps, { ...source, appId: imported.id })).rejects.toThrow(
        "does not support yet",
      );
      fake.bindings.pop();
    }
    fake.failBindings();
    await expect(previewAdoptionCore(deps, { ...source, appId: imported.id })).rejects.toThrow(
      "inventory is incomplete",
    );
  });

  it("leaves a multi-Worker import intact", async () => {
    const fake = fakeCloudflare();
    fake.scripts.push({ id: "site-api", handlers: ["fetch"] });
    const imported = await saveImport(fake, ["site", "site-api"]);
    await expect(
      previewAdoptionCore({ db: env.DB, api: fake.api }, { ...source, appId: imported.id }),
    ).rejects.toThrow("supports one Worker");
    expect(await getImportedAppCore(env.DB, imported.id)).toEqual(imported);
  });

  it("refuses data already owned by another active or retained install", async () => {
    const fake = fakeCloudflare();
    const imported = await saveImport(fake);
    await env.DB.prepare(`INSERT INTO installs (id, app_slug, worker_name, catalog_version, artifact_url, status, installed_at, updated_at)
      VALUES ('other', 'other', 'other', '1', 'u', 'uninstalled', 1, 1)`).run();
    await env.DB.prepare(`INSERT INTO resources (id, install_id, kind, binding, name, cf_id, created_at, retained_at)
      VALUES ('other:d1:DB', 'other', 'd1', 'DB', 'existing-blog-data', 'original-db', 1, 1)`).run();
    await expect(
      previewAdoptionCore({ db: env.DB, api: fake.api }, { ...source, appId: imported.id }),
    ).rejects.toThrow("already recorded for another app");
    expect(await getImportedAppCore(env.DB, imported.id)).toEqual(imported);
  });

  it("does not adopt without a usable D1 recovery bookmark", async () => {
    const fake = fakeCloudflare();
    const imported = await saveImport(fake);
    const deps = { db: env.DB, api: fake.api };
    const input = { ...source, appId: imported.id };
    const preview = await previewAdoptionCore(deps, input);
    fake.setBookmark("");
    await expect(
      adoptImportedAppCore(deps, { ...input, fingerprint: preview.fingerprint }),
    ).rejects.toThrow("recovery bookmark");
    expect(await getImportedAppCore(env.DB, imported.id)).toEqual(imported);
    expect((await env.DB.prepare("SELECT * FROM installs").all()).results).toEqual([]);
  });

  it("accepts the first reviewed custom build and reuses every adopted data resource", async () => {
    const fake = fakeCloudflare();
    const imported = await saveImport(fake);
    const deps = { db: env.DB, api: fake.api };
    const input = { ...source, appId: imported.id };
    const preview = await previewAdoptionCore(deps, input);
    await adoptImportedAppCore(deps, { ...input, fingerprint: preview.fingerprint });
    const commit = "0123456789abcdef0123456789abcdef01234567";
    const fixture = await buildArtifactFixture({
      keyId: "unsigned",
      tweak: (manifest) => {
        manifest.app = "custom-blog";
      },
      catalog: {
        slug: "custom-blog",
        repo: "quariongg/custom-blog",
        name: "Custom blog",
        source: { ref: "main", sha: commit },
        secrets: [{ name: "KEY", label: "Encryption key" }],
        vars: [],
        install: { tier: "sandbox", packageManager: "pnpm", wranglerConfig: "wrangler.jsonc" },
      },
      bindings: [
        { type: "d1", name: "DB" },
        { type: "r2_bucket", name: "MEDIA" },
        { type: "kv_namespace", name: "SESSION" },
      ],
    });
    const keys = buildKeys(imported.id, fixture.manifest.version, fixture.manifest.app);
    await createDb(env.DB)
      .insert(source_builds)
      .values({
        id: "first-custom-build",
        install_id: imported.id,
        purpose: "update",
        origin: "repository",
        repo: "quariongg/custom-blog",
        requested_ref: "main",
        status: "built",
        commit_sha: commit,
        ref: "main",
        version: fixture.manifest.version,
        digest: fixture.digest,
        manifest_key: keys.manifest,
        artifact_key: keys.artifact,
        image: "custom-builder",
        manifest_json: JSON.stringify(fixture.manifest),
        built_at: new Date(),
        created_at: new Date(),
        updated_at: new Date(),
      });
    const recorded = await createDb(env.DB).select().from(resources);
    const diff = diffBindings(
      "site",
      fixture.manifest.worker.bindings,
      recorded.map((row) => ({
        id: row.id,
        kind: row.kind,
        binding: row.binding,
        name: row.name,
        cfId: row.cf_id,
      })),
    );
    expect(diff.problems).toEqual([]);
    expect(diff.toCreate).toEqual([]);
    expect(diff.existing).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ binding: "DB", cfId: "original-db", name: "existing-blog-data" }),
        expect.objectContaining({ binding: "MEDIA", cfId: "original-media" }),
        expect.objectContaining({ binding: "SESSION", cfId: "original-session" }),
      ]),
    );
    const started = await updateFromSourceBuildCore(
      {
        db: env.DB,
        newId: () => "first-custom-update",
        createJob: async (id, params) => {
          expect(params.prebuilt).toMatchObject({
            origin: "repository",
            repo: "quariongg/custom-blog",
            app: "custom-blog",
          });
          expect(params.installId).toBe(imported.id);
          return { id };
        },
      },
      { buildId: "first-custom-build" },
    );
    expect(started).toEqual({ jobId: "first-custom-update" });
    expect((await createDb(env.DB).select().from(installs))[0]).toMatchObject({
      app_slug: repositoryAppSlug("quariongg/custom-blog"),
      worker_name: "site",
      status: "updating",
    });
    expect((await createDb(env.DB).select().from(resources)).map((row) => row.cf_id)).toEqual(
      recorded.map((row) => row.cf_id),
    );
  });

  it("allows only one concurrent adoption and leaves a single complete managed app", async () => {
    const fake = fakeCloudflare();
    const imported = await saveImport(fake);
    const deps = { db: env.DB, api: fake.api };
    const input = { ...source, appId: imported.id };
    const preview = await previewAdoptionCore(deps, input);
    const results = await Promise.allSettled([
      adoptImportedAppCore(deps, { ...input, fingerprint: preview.fingerprint }),
      adoptImportedAppCore(deps, { ...input, fingerprint: preview.fingerprint }),
    ]);
    expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    expect(results.filter((result) => result.status === "rejected")).toHaveLength(1);
    expect((await env.DB.prepare("SELECT * FROM installs").all()).results).toHaveLength(1);
    expect((await env.DB.prepare("SELECT * FROM install_adoptions").all()).results).toHaveLength(1);
    expect((await env.DB.prepare("SELECT * FROM jobs").all()).results).toHaveLength(1);
    expect((await env.DB.prepare("SELECT * FROM snapshots").all()).results).toHaveLength(1);
    expect((await env.DB.prepare("SELECT * FROM imported_app_workers").all()).results).toHaveLength(
      0,
    );
  });
});
