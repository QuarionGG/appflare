import { reset } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { createClient } from "@appflare/cf-api";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { createMigrator } from "../db/migrate";
import { migrations } from "../db/migrations/index";
import { ACC, fakeAccount, TOKEN } from "../test/fake-account";
import { INSTALL_ID, OLD_VERSION, seedInstall } from "../test/seed-install";

/**
 * The server functions behind an app's Workers Logs switch: only an admin
 * changes it (members read it), the change is recorded as the signed-in
 * user's, and an app of several Workers has every one changed. TanStack
 * Start's `createServerFn` is replaced by a chain that returns the
 * handler, so it can be called here; the rest runs for real against the
 * local D1 and a fake Cloudflare account.
 */

const { requireRole, requireSession, getCfClient } = vi.hoisted(() => ({
  requireRole: vi.fn(),
  requireSession: vi.fn(),
  getCfClient: vi.fn(),
}));

vi.mock("@tanstack/react-start", () => {
  const chain = {
    validator: () => chain,
    inputValidator: () => chain,
    handler: (fn: unknown) => fn,
  };
  return { createServerFn: () => chain };
});
vi.mock("../server/auth.server", () => ({ requireRole, requireSession }));
vi.mock("../cloudflare/client.server", () => ({
  getCfClient,
  CfTokenNotConfiguredError: class extends Error {},
}));

const { getObservabilityFn, setObservabilityFn } = await import("./observability.functions");
type Handler<I> = (args: { data: I }) => Promise<unknown>;
const set = setObservabilityFn as unknown as Handler<{ installId: string; enabled: boolean }>;
const get = getObservabilityFn as unknown as Handler<{ installId: string }>;

const ADMIN = { user: { id: "user-admin", role: "admin" }, session: { id: "s" } };

async function world() {
  const fake = fakeAccount(null, {
    deployments: [{ id: "dep-0", versions: [{ version_id: OLD_VERSION, percentage: 100 }] }],
    otherScripts: ["cut-jobs"],
  });
  await seedInstall({
    resources: [
      { kind: "worker", name: "cut", cfId: "cut" },
      { kind: "worker", name: "cut-jobs", cfId: "cut-jobs" },
    ],
  });
  getCfClient.mockResolvedValue(createClient({ accountId: ACC, token: TOKEN, fetch: fake.fetch }));
  return fake;
}

beforeEach(async () => {
  await reset();
  await createMigrator(migrations).ensure(env.DB);
  requireRole.mockReset();
  requireSession.mockReset();
  getCfClient.mockReset();
});

describe("setObservabilityFn", () => {
  it("refuses a member before calling Cloudflare", async () => {
    const fake = await world();
    requireRole.mockRejectedValue(new Error("You do not have permission to do that."));
    await expect(set({ data: { installId: INSTALL_ID, enabled: true } })).rejects.toThrow(
      "You do not have permission to do that.",
    );
    expect(requireRole).toHaveBeenCalledWith("admin");
    expect(fake.state.calls).toEqual([]);
    const rows = await env.DB.prepare("SELECT count(*) AS n FROM usage_activity").first<{
      n: number;
    }>();
    expect(rows?.n).toBe(0);
  });

  it("turns Workers Logs on for every Worker of the app and records the admin's change", async () => {
    const fake = await world();
    requireRole.mockResolvedValue(ADMIN);
    const result = await set({ data: { installId: INSTALL_ID, enabled: true } });
    expect(result).toMatchObject({
      state: "on",
      workers: [
        { workerName: "cut", on: true },
        { workerName: "cut-jobs", on: true },
      ],
    });
    expect(fake.state.calls).toEqual([
      "PATCH /workers/scripts/cut/script-settings",
      "PATCH /workers/scripts/cut-jobs/script-settings",
    ]);
    const row = await env.DB.prepare(
      "SELECT install_id, kind, by, facts_json FROM usage_activity",
    ).first<Record<string, string>>();
    expect(row).toEqual({
      install_id: INSTALL_ID,
      kind: "observability_changed",
      by: "user-admin",
      facts_json: JSON.stringify({ enabled: true, workers: ["cut", "cut-jobs"] }),
    });
  });

  it("refuses while a job runs on the app", async () => {
    const fake = await world();
    requireRole.mockResolvedValue(ADMIN);
    await env.DB.prepare(
      "INSERT INTO jobs (id, install_id, kind, status) VALUES ('j1', ?1, 'update', 'running')",
    )
      .bind(INSTALL_ID)
      .run();
    await expect(set({ data: { installId: INSTALL_ID, enabled: true } })).rejects.toThrow(
      "Wait for the running job to finish, then try again.",
    );
    expect(fake.state.calls).toEqual([]);
  });

  it("passes on the words for an error the admin can act on", async () => {
    const fake = await world();
    requireRole.mockResolvedValue(ADMIN);
    fake.state.failOnce.set("PATCH /workers/scripts/cut/script-settings", 403);
    const error = (await set({ data: { installId: INSTALL_ID, enabled: true } }).catch(
      (e: unknown) => e,
    )) as Error;
    expect(error).toBeInstanceOf(Error);
    expect(error.name).toBe("Error");
    expect(error.message).toContain("the token needs Workers Scripts: Edit");
  });
});

describe("getObservabilityFn", () => {
  it("lets any signed-in user read the app's Workers Logs", async () => {
    const fake = await world();
    fake.state.observability["cut-jobs"] = { enabled: true };
    requireSession.mockResolvedValue({ user: { id: "user-member", role: "member" } });
    const result = await get({ data: { installId: INSTALL_ID } });
    expect(requireSession).toHaveBeenCalled();
    expect(requireRole).not.toHaveBeenCalled();
    expect(result).toMatchObject({
      state: "mixed",
      workers: [
        { workerName: "cut", on: false },
        { workerName: "cut-jobs", on: true },
      ],
    });
  });

  it("refuses a visitor who is not signed in", async () => {
    const fake = await world();
    requireSession.mockRejectedValue(new Error("Sign in to continue."));
    await expect(get({ data: { installId: INSTALL_ID } })).rejects.toThrow("Sign in to continue.");
    expect(fake.state.calls).toEqual([]);
  });
});
