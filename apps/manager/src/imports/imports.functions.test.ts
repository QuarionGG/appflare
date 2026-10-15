import { beforeEach, describe, expect, it, vi } from "vitest";

const { requireRole, requireSession, getCfClient, core } = vi.hoisted(() => ({
  requireRole: vi.fn(),
  requireSession: vi.fn(),
  getCfClient: vi.fn(),
  core: {
    discoverImportWorkersCore: vi.fn(),
    previewImportCore: vi.fn(),
    importExistingAppCore: vi.fn(),
    refreshImportedAppCore: vi.fn(),
    forgetImportedAppCore: vi.fn(),
    getImportedAppCore: vi.fn(),
    listImportedAppsCore: vi.fn(),
  },
}));

// Return the actual server handlers, following the manager's other function tests.
vi.mock("@tanstack/react-start", () => {
  const chain = {
    validator: () => chain,
    inputValidator: () => chain,
    handler: (handler: unknown) => handler,
  };
  return { createServerFn: () => chain };
});
vi.mock("../server/auth.server", () => ({ requireRole, requireSession }));
vi.mock("../cloudflare/client.server", () => ({ getCfClient }));
vi.mock("./imports.server", () => core);

const functions = await import("./imports.functions");
const call = (name: keyof typeof functions, data?: unknown) =>
  (functions[name] as unknown as (args: { data: unknown }) => Promise<unknown>)({ data });

beforeEach(() => {
  vi.resetAllMocks();
  getCfClient.mockResolvedValue({ accountId: "account" });
});

describe("import server function authorization", () => {
  it.each([
    ["discoverImportWorkers", "discoverImportWorkersCore"],
    ["previewImport", "previewImportCore"],
    ["importExistingApp", "importExistingAppCore"],
    ["refreshImportedApp", "refreshImportedAppCore"],
    ["forgetImportedApp", "forgetImportedAppCore"],
  ] as const)(
    "requires a fresh administrator check before %s does anything",
    async (name, implementation) => {
      requireRole.mockRejectedValue(new Error("Only administrators can do this."));
      await expect(call(name, { appId: "app" })).rejects.toThrow("Only administrators");
      expect(requireRole).toHaveBeenCalledWith("admin");
      expect(getCfClient).not.toHaveBeenCalled();
      expect(core[implementation]).not.toHaveBeenCalled();
    },
  );

  it.each([
    ["listImportedApps", "listImportedAppsCore"],
    ["getImportedApp", "getImportedAppCore"],
  ] as const)(
    "allows a signed-in member to use %s without Cloudflare access",
    async (name, implementation) => {
      requireSession.mockResolvedValue({ user: { role: "member" } });
      core[implementation].mockResolvedValue([]);
      await expect(call(name, { appId: "app" })).resolves.toEqual([]);
      expect(requireSession).toHaveBeenCalled();
      expect(requireRole).not.toHaveBeenCalled();
      expect(getCfClient).not.toHaveBeenCalled();
      expect(core[implementation]).toHaveBeenCalled();
    },
  );

  it.each(["listImportedApps", "getImportedApp"] as const)(
    "requires a session for %s",
    async (name) => {
      requireSession.mockRejectedValue(new Error("Sign in first."));
      await expect(call(name, { appId: "app" })).rejects.toThrow("Sign in first");
      expect(core.listImportedAppsCore).not.toHaveBeenCalled();
      expect(core.getImportedAppCore).not.toHaveBeenCalled();
    },
  );

  it("forgets for an admin without constructing a Cloudflare client", async () => {
    requireRole.mockResolvedValue({ user: { role: "admin" } });
    core.forgetImportedAppCore.mockResolvedValue({ id: "app" });
    await expect(call("forgetImportedApp", { appId: "app" })).resolves.toEqual({ id: "app" });
    expect(getCfClient).not.toHaveBeenCalled();
    expect(core.forgetImportedAppCore).toHaveBeenCalledWith(expect.anything(), "app");
  });
});
