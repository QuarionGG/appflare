import { reset } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { beforeEach, describe, expect, it } from "vitest";
import { createMigrator } from "../db/migrate";
import { migrations } from "../db/migrations/index";
import { adoptionAddress, readInstallAdoption } from "./adoption.server";
import { installRowsOf } from "./install-rows.server";
import { readInstall } from "./versions.server";

beforeEach(async () => {
  await reset();
  await createMigrator(migrations).ensure(env.DB);
  await env.DB.prepare(`INSERT INTO installs
    (id, app_slug, worker_name, display_name, catalog_version, artifact_url,
     status, build_kind, origin, source_url, source_ref, installed_at, updated_at)
    VALUES ('blog', 'site', 'site', 'QuarionGG blog', 'Existing deployment', '',
    'installed', 'adopted', 'repository', 'https://github.com/team/blog', 'main', 1, 1)`).run();
});

describe("adopted install views", () => {
  it("keeps the original route address in the normal app list", async () => {
    const row = await readInstall(env.DB, "blog");
    const [view] = installRowsOf([row], new Map(), [], {
      sub: "account",
      domains: new Map(),
      openPaths: new Map(),
      adoptedAddresses: new Map([["blog", "https://example.com/"]]),
      adoptedNames: new Map([["blog", "EmDash"]]),
    });
    expect(view).toMatchObject({
      name: "EmDash",
      label: "QuarionGG blog",
      address: "https://example.com/",
      updateAvailable: false,
      origin: "repository",
    });
  });

  it("reads preserved routing without turning it into a removable custom domain", async () => {
    await env.DB.prepare(`INSERT INTO install_adoptions
      (install_id, imported_app_id, app_name, primary_url, inventory_json, adopted_at)
      VALUES ('blog', 'old-import', 'EmDash', 'https://example.com/', ?1, 1)`)
      .bind(JSON.stringify({ workers: [{ name: "site", routes: [{ pattern: "example.com/*" }] }] }))
      .run();
    expect(await readInstallAdoption(env.DB, "blog")).toMatchObject({
      appName: "EmDash",
      address: "https://example.com/",
      routes: [{ workerName: "site", pattern: "example.com/*" }],
    });
    expect(await readInstallAdoption(env.DB, "unknown")).toBeNull();
  });

  it.each(["javascript:alert(1)", "http://example.com", "https://user:pass@example.com"])(
    "does not expose %s as the adoption address",
    (address) => {
      expect(adoptionAddress(address)).toBeNull();
    },
  );
});
