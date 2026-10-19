import { beforeEach, describe, expect, it, vi } from "vitest";

const { requireRole, requireSession, getCfClient, previewAdoptionCore, adoptImportedAppCore } =
  vi.hoisted(() => ({
    requireRole: vi.fn(),
    requireSession: vi.fn(),
    getCfClient: vi.fn(),
    previewAdoptionCore: vi.fn(),
    adoptImportedAppCore: vi.fn(),
  }));

vi.mock("@tanstack/react-start", () => {
  const chain = { validator: () => chain, handler: (handler: unknown) => handler };
  return { createServerFn: () => chain };
});
vi.mock("../server/auth.server", () => ({ requireRole, requireSession }));
vi.mock("../cloudflare/client.server", () => ({ getCfClient }));
vi.mock("./adoptions.server", () => ({ previewAdoptionCore, adoptImportedAppCore }));

const functions = await import("./adoptions.functions");
const call = (name: keyof typeof functions) =>
  (functions[name] as unknown as (args: { data: unknown }) => Promise<unknown>)({
    data: { appId: "app" },
  });

beforeEach(() => vi.resetAllMocks());

describe("adoption server functions", () => {
  it.each(["previewAdoption", "adoptImportedApp"] as const)(
    "%s checks the administrator before reading the account or changing records",
    async (name) => {
      requireRole.mockRejectedValue(new Error("Only administrators can do this."));
      await expect(call(name)).rejects.toThrow("Only administrators");
      expect(requireRole).toHaveBeenCalledWith("admin");
      expect(getCfClient).not.toHaveBeenCalled();
      expect(previewAdoptionCore).not.toHaveBeenCalled();
      expect(adoptImportedAppCore).not.toHaveBeenCalled();
    },
  );
  it("requires a session before resolving an old bookmark", async () => {
    requireSession.mockRejectedValue(new Error("Sign in first."));
    await expect(call("getAdoptedInstall")).rejects.toThrow("Sign in first");
    expect(getCfClient).not.toHaveBeenCalled();
  });
});
