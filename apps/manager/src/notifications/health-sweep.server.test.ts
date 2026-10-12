import { reset } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { beforeEach, describe, expect, it } from "vitest";
import { createMigrator } from "../db/migrate";
import { migrations } from "../db/migrations/index";
import { accessChallenge } from "../test/access-sign-in";
import { INSTALL_ID, seedInstall } from "../test/seed-install";
import { checkInstallsHealth, installsToCheck } from "./health-sweep.server";

async function healthStatus(): Promise<string | null | undefined> {
  const row = await env.DB.prepare("SELECT health_status FROM installs WHERE id = ?1")
    .bind(INSTALL_ID)
    .first<{ health_status: string | null }>();
  return row?.health_status;
}

beforeEach(async () => {
  await reset();
  await createMigrator(migrations).ensure(env.DB);
  await seedInstall();
});

describe("checkInstallsHealth", () => {
  it("reports two server errors in a row as unhealthy", async () => {
    let probes = 0;
    const report = await checkInstallsHealth(env.DB, [INSTALL_ID], {
      fetch: async () => {
        probes++;
        return new Response("boom", { status: 500 });
      },
      sleep: async () => {},
    });
    expect(probes).toBe(2);
    expect(report).toEqual({ checked: 1, unhealthy: 1, unhealthyIds: [INSTALL_ID] });
    expect(await healthStatus()).toBe("unhealthy");
  });

  it("never reports Cloudflare Access's sign-in redirect as unhealthy, and does not probe again", async () => {
    let probes = 0;
    const report = await checkInstallsHealth(env.DB, [INSTALL_ID], {
      fetch: async (input) => {
        probes++;
        return accessChallenge(new URL(input).host);
      },
      sleep: async () => {},
    });
    expect(probes).toBe(1);
    expect(report).toEqual({ checked: 1, unhealthy: 0, unhealthyIds: [] });
    expect(await healthStatus()).toBe("unverified");
  });
});

describe("installsToCheck", () => {
  it("leaves out a paused app, so it takes no other app's place", async () => {
    await env.DB.prepare(
      `INSERT INTO installs (id, app_slug, worker_name, instance_name, catalog_version, artifact_url, status, installed_at, updated_at)
       VALUES ('i2', 'cut', 'cut-2', 'cut-2', '1.0.0', 'u', 'installed', 1, 1)`,
    ).run();
    expect(await installsToCheck(env.DB, 5)).toEqual([INSTALL_ID, "i2"]);
    await env.DB.prepare(
      "INSERT INTO app_pauses (id, install_id, paused_at, paused_by, reason) VALUES ('p1', ?1, 1, 'auto', 'loop')",
    )
      .bind(INSTALL_ID)
      .run();
    expect(await installsToCheck(env.DB, 1)).toEqual(["i2"]);
    // Resumed: checked again.
    await env.DB.prepare("UPDATE app_pauses SET resumed_at = 2 WHERE id = 'p1'").run();
    expect(await installsToCheck(env.DB, 5)).toEqual([INSTALL_ID, "i2"]);
  });
});
