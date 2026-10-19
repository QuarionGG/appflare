import { reset } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { createClient, type FetchLike, type WorkerScript } from "@appflare/cf-api";
import { beforeEach, describe, expect, it } from "vitest";
import { createDb } from "../db/client";
import { createMigrator } from "../db/migrate";
import { migrations } from "../db/migrations/index";
import { SETTING, writeSettings } from "../db/settings";
import { ACC, SUBDOMAIN } from "../test/fake-account";
import {
  discoverImportWorkersCore,
  forgetImportedAppCore,
  getImportedAppCore,
  importExistingAppCore,
  listImportedAppsCore,
  previewImportCore,
  refreshImportedAppCore,
} from "./imports.server";
import { importSelectionInput } from "./input";
import { type ImportSelection, MAX_IMPORTED_WORKERS } from "./types";

const selection: ImportSelection = {
  workerNames: ["site", "site-mail"],
  primaryWorker: "site",
  displayName: "Our existing website",
};

function fakeCloudflare() {
  const calls: string[] = [];
  const scripts: WorkerScript[] = [
    {
      id: "site",
      modified_on: "2026-10-01T00:00:00Z",
      handlers: ["fetch"],
      routes: [{ id: "route", pattern: "quariongg.com/*" }],
    },
    { id: "site-mail", handlers: ["email", "scheduled"] },
    { id: "manager-custom-name" },
    { id: "appflare-sandbox" },
    { id: "appflare-gateway" },
    { id: "managed" },
    { id: "managed-api" },
  ];
  const fail = new Set<string>();
  const bindings = [
    { type: "plain_text", name: "TOKEN_VARIABLE", text: "private-var", id: "private-id" },
    {
      type: "json",
      name: "CONFIG",
      json: { password: "private-json" },
      service: "private-service",
    },
    { type: "secret_text", name: "PASSWORD", text: "private-secret" },
    {
      type: "unknown_future_binding",
      name: "FUTURE",
      id: "private-unknown-id",
      text: "private-unknown",
    },
    { type: "d1", name: "DB", id: "existing-db", database_name: "site-data" },
    { type: "r2_bucket", name: "UPLOADS", bucket_name: "existing-files" },
    {
      type: "durable_object_namespace",
      name: "ROOMS",
      namespace_id: "existing-rooms",
      class_name: "Room",
      script_name: "site",
    },
    { type: "service", name: "MAIL", service: "site-mail" },
  ];
  const fetch: FetchLike = async (input, init) => {
    const url = new URL(input);
    const path = url.pathname.replace(`/client/v4/accounts/${ACC}`, "");
    const method = init?.method ?? "GET";
    calls.push(`${method} ${path}`);
    if (method !== "GET") throw new Error("Import attempted a Cloudflare mutation");
    if (fail.has(path)) {
      return Response.json(
        { success: false, errors: [{ code: 10000, message: "private-error-body" }] },
        { status: 403 },
      );
    }
    let result: unknown;
    if (path === "/workers/scripts") result = scripts;
    else if (path.endsWith("/bindings")) result = bindings;
    else if (path.endsWith("/schedules"))
      result = { schedules: [{ cron: "0 * * * *", private: "private-schedule" }] };
    else if (path.endsWith("/subdomain")) result = { enabled: false };
    else if (path.endsWith("/deployments"))
      result = {
        deployments: [
          {
            id: "deployment-original",
            created_on: "2026-10-01T00:00:00Z",
            source: "wrangler",
            annotations: { note: "private-annotation" },
            versions: [{ version_id: "original-version", percentage: 100 }],
          },
        ],
      };
    else if (path === "/workers/domains")
      result =
        url.searchParams.get("service") === "site"
          ? [
              {
                id: "original-domain",
                hostname: "quariongg.com",
                zone_name: "quariongg.com",
                service: "site",
                zone_id: "zone-original",
                private: "private-domain",
              },
            ]
          : [];
    else throw new Error(`Unexpected read: ${path}`);
    return Response.json({ success: true, result });
  };
  const api = createClient({ accountId: ACC, token: "private-api-token", fetch });
  return { api, calls, scripts, bindings, fail };
}

async function seedManaged() {
  await env.DB.prepare(`INSERT INTO installs (id, app_slug, worker_name, catalog_version,
    artifact_url, status, installed_at, updated_at) VALUES ('managed', 'managed', 'managed', '1', 'u', 'installed', 1, 1)`).run();
  await env.DB.prepare(
    "INSERT INTO resources (id, install_id, kind, name, created_at) VALUES ('managed-api', 'managed', 'worker', 'managed-api', 1)",
  ).run();
}

beforeEach(async () => {
  await reset();
  await createMigrator(migrations).ensure(env.DB);
  await writeSettings(createDb(env.DB), {
    [SETTING.accountId]: ACC,
    [SETTING.workerName]: "manager-custom-name",
    [SETTING.accountSubdomain]: SUBDOMAIN,
  });
  await seedManaged();
});

describe("existing Worker imports", () => {
  it("discovers only unmanaged Workers and rechecks exclusions against crafted requests", async () => {
    const fake = fakeCloudflare();
    const deps = { db: env.DB, api: fake.api };
    expect((await discoverImportWorkersCore(deps)).workers.map((worker) => worker.name)).toEqual([
      "site",
      "site-mail",
    ]);
    for (const name of [
      "manager-custom-name",
      "appflare-sandbox",
      "appflare-gateway",
      "managed",
      "managed-api",
    ]) {
      await expect(
        previewImportCore(deps, { ...selection, workerNames: [name], primaryWorker: name }),
      ).rejects.toThrow("managed by Appflare, internal, or already imported");
    }
    expect(fake.calls.every((call) => call.startsWith("GET "))).toBe(true);
    expect(await listImportedAppsCore(env.DB)).toEqual([]);
  });

  it("imports a multi-Worker app atomically using only GET requests and allowlisted metadata", async () => {
    const fake = fakeCloudflare();
    const deps = { db: env.DB, api: fake.api, now: () => 1234 };
    const preview = await previewImportCore(deps, selection);
    expect(await listImportedAppsCore(env.DB)).toEqual([]);
    const imported = await importExistingAppCore(deps, {
      ...selection,
      fingerprint: preview.fingerprint,
    });
    expect(imported).toMatchObject({
      displayName: selection.displayName,
      primaryWorker: "site",
      workerNames: ["site", "site-mail"],
      address: "https://quariongg.com",
      importedAt: new Date(1234).toISOString(),
      refreshedAt: new Date(1234).toISOString(),
      warnings: [],
    });
    expect(imported.workers[0]?.bindings).toContainEqual({
      name: "DB",
      type: "d1",
      resourceId: "existing-db",
      resourceName: null,
      scriptName: null,
      className: null,
    });
    expect(imported.workers[0]?.domains).toEqual([
      { id: "original-domain", hostname: "quariongg.com", zoneName: "quariongg.com" },
    ]);
    expect(imported.workers[0]?.deployments[0]?.versions).toEqual([
      { versionId: "original-version", percentage: 100 },
    ]);
    expect(await getImportedAppCore(env.DB, imported.id)).toEqual(imported);
    const persisted = await env.DB.prepare("SELECT inventory_json FROM imported_apps").first<{
      inventory_json: string;
    }>();
    expect(persisted?.inventory_json).not.toContain("private-");
    expect(JSON.stringify(preview)).not.toContain("private-");
    expect(fake.calls.every((call) => call.startsWith("GET "))).toBe(true);
    expect(fake.calls.filter((call) => call === "GET /workers/scripts")).toHaveLength(2);
    expect(
      (
        await env.DB.prepare(
          "SELECT worker_name FROM imported_app_workers ORDER BY worker_name",
        ).all()
      ).results,
    ).toEqual([{ worker_name: "site" }, { worker_name: "site-mail" }]);
    expect((await discoverImportWorkersCore(deps)).workers).toEqual([]);
  });

  it("refuses changed or missing deployments and never trusts a stale preview", async () => {
    const fake = fakeCloudflare();
    const deps = { db: env.DB, api: fake.api };
    const preview = await previewImportCore(deps, selection);
    const script = fake.scripts.find((worker) => worker.id === "site");
    if (script) script.modified_on = "2026-10-02T00:00:00Z";
    await expect(
      importExistingAppCore(deps, { ...selection, fingerprint: preview.fingerprint }),
    ).rejects.toThrow("changed since the preview");
    fake.scripts.splice(
      fake.scripts.findIndex((worker) => worker.id === "site"),
      1,
    );
    await expect(
      importExistingAppCore(deps, { ...selection, fingerprint: preview.fingerprint }),
    ).rejects.toThrow("no longer exists");
    expect(await listImportedAppsCore(env.DB)).toEqual([]);
  });

  it("prevents concurrent duplicate groups without leaving orphan import rows", async () => {
    const fake = fakeCloudflare();
    const deps = { db: env.DB, api: fake.api };
    const preview = await previewImportCore(deps, selection);
    const results = await Promise.allSettled([
      importExistingAppCore(deps, { ...selection, fingerprint: preview.fingerprint }),
      importExistingAppCore(deps, { ...selection, fingerprint: preview.fingerprint }),
    ]);
    expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    expect(results.filter((result) => result.status === "rejected")).toHaveLength(1);
    expect(await listImportedAppsCore(env.DB)).toHaveLength(1);
    expect((await env.DB.prepare("SELECT * FROM imported_app_workers").all()).results).toHaveLength(
      2,
    );
  });

  it("reports incomplete permissions without exposing API response bodies", async () => {
    const fake = fakeCloudflare();
    fake.fail.add("/workers/scripts/site/schedules");
    const preview = await previewImportCore({ db: env.DB, api: fake.api }, selection);
    expect(preview.warnings).toEqual([
      'Could not read cron schedules for "site". This section is incomplete.',
    ]);
    expect(preview.workers[0]?.schedules).toEqual([]);
    expect(JSON.stringify(preview)).not.toContain("private-error");
  });

  it("preserves the stored inventory when refreshing fails, and prior sections on partial reads", async () => {
    const fake = fakeCloudflare();
    let now = 1;
    const deps = { db: env.DB, api: fake.api, now: () => now };
    const preview = await previewImportCore(deps, selection);
    const original = await importExistingAppCore(deps, {
      ...selection,
      fingerprint: preview.fingerprint,
    });
    fake.fail.add("/workers/scripts");
    now = 2;
    await expect(refreshImportedAppCore(deps, original.id)).rejects.toThrow();
    expect(await getImportedAppCore(env.DB, original.id)).toEqual(original);
    fake.fail.clear();
    fake.fail.add("/workers/scripts/site/bindings");
    const refreshed = await refreshImportedAppCore(deps, original.id);
    expect(refreshed.workers[0]?.bindings).toEqual(original.workers[0]?.bindings);
    expect(refreshed.warnings).toEqual([
      'Could not read bindings for "site". The last inventory for this section is preserved.',
    ]);
    expect(refreshed.refreshedAt).toBe(new Date(2).toISOString());
  });

  it("marks externally removed Workers missing while keeping the previous metadata", async () => {
    const fake = fakeCloudflare();
    const deps = { db: env.DB, api: fake.api };
    const preview = await previewImportCore(deps, selection);
    const original = await importExistingAppCore(deps, {
      ...selection,
      fingerprint: preview.fingerprint,
    });
    fake.scripts.splice(
      fake.scripts.findIndex((worker) => worker.id === "site"),
      1,
    );
    const refreshed = await refreshImportedAppCore(deps, original.id);
    expect(refreshed.workers[0]).toMatchObject({
      missing: true,
      bindings: original.workers[0]?.bindings,
      domains: original.workers[0]?.domains,
    });
    expect(refreshed.address).toBeNull();
    expect(refreshed.warnings[0]).toContain("last inventory is preserved");
  });

  it("forgets only import records and releases membership for a later import", async () => {
    const fake = fakeCloudflare();
    const deps = { db: env.DB, api: fake.api };
    const preview = await previewImportCore(deps, selection);
    const imported = await importExistingAppCore(deps, {
      ...selection,
      fingerprint: preview.fingerprint,
    });
    const calls = [...fake.calls];
    expect(await forgetImportedAppCore(env.DB, imported.id)).toEqual({ id: imported.id });
    expect(fake.calls).toEqual(calls);
    expect(await listImportedAppsCore(env.DB)).toEqual([]);
    expect((await env.DB.prepare("SELECT * FROM imported_app_workers").all()).results).toEqual([]);
    expect((await env.DB.prepare("SELECT * FROM installs").all()).results).toHaveLength(1);
    expect((await env.DB.prepare("SELECT * FROM resources").all()).results).toHaveLength(1);
    expect((await discoverImportWorkersCore(deps)).workers).toHaveLength(2);
    expect(fake.scripts.map((worker) => worker.id)).toContain("site");
    expect(fake.bindings.find((binding) => binding.name === "DB")?.id).toBe("existing-db");
  });

  it("rejects malformed groups and account identity mismatches", async () => {
    for (const change of [
      { workerNames: [] },
      { workerNames: ["site", "site"] },
      { primaryWorker: "other" },
      { displayName: "\n" },
      { workerNames: ["../site"] },
    ]) {
      expect(importSelectionInput.safeParse({ ...selection, ...change }).success).toBe(false);
    }
    const fake = fakeCloudflare();
    await writeSettings(createDb(env.DB), { [SETTING.accountId]: "another-account" });
    await expect(previewImportCore({ db: env.DB, api: fake.api }, selection)).rejects.toThrow(
      "identity must be configured",
    );
  });

  it("caps grouped imports so a request fits the Workers Free subrequest budget", () => {
    const workerNames = Array.from(
      { length: MAX_IMPORTED_WORKERS },
      (_, index) => `worker-${index}`,
    );
    expect(
      importSelectionInput.safeParse({ ...selection, workerNames, primaryWorker: "worker-0" })
        .success,
    ).toBe(true);
    expect(
      importSelectionInput.safeParse({
        ...selection,
        workerNames: [...workerNames, "extra-worker"],
        primaryWorker: "worker-0",
      }).success,
    ).toBe(false);
  });
});
