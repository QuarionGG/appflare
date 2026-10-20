import { TooltipProvider } from "@cloudflare/kumo";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { EmDashUpgradePlan, EmDashUpgradeView } from "../installs/emdash-upgrades";
import type { InstallDetail } from "../installs/installs.functions";

const calls = vi.hoisted(() => ({
  checkEmdashUpgrade: vi.fn(),
  getLatestEmdashUpgrade: vi.fn(),
  prepareEmdashUpgrade: vi.fn(),
  mergeAndBuildEmdashUpgrade: vi.fn(),
  jobStarted: vi.fn(async () => {}),
}));
vi.mock("../installs/emdash-upgrades.functions", () => calls);
vi.mock("./job-started", () => ({ useJobStarted: () => calls.jobStarted }));

const { EmDashUpdatesCard, EmDashUpgradeReview, canDeployEmDashUpgradeBuild } = await import(
  "./emdash-updates-card"
);
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const INSTALL = {
  id: "blog1",
  origin: "repository",
  source: { url: "https://github.com/acme/blog", ref: "main" },
  label: "Custom blog",
  status: "installed",
  activeJobId: null,
} as InstallDetail;
const PLAN: EmDashUpgradePlan = {
  supported: true,
  reason: null,
  installedVersion: "1.1.0",
  sourceVersion: "1.1.0",
  targetVersion: "1.3.0",
  baseSha: "a".repeat(40),
  repo: "acme/blog",
  upToDate: false,
  writeTokenAvailable: true,
  plugins: [{ name: "@acme/custom-plugin", version: "file:vendor/custom-plugin.tgz" }],
};
const UPGRADE = {
  id: "upgrade1",
  targetVersion: "1.3.0",
  buildId: "prbuild1",
  mergedBuildId: null,
  status: "ready",
  prUrl: "https://github.com/acme/blog/pull/2",
  mergeSha: null,
  report: null,
} as EmDashUpgradeView;

let container: HTMLDivElement;
let root: Root;
beforeEach(() => {
  vi.clearAllMocks();
  calls.getLatestEmdashUpgrade.mockResolvedValue(null);
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
});
afterEach(() => {
  act(() => root.unmount());
  container.remove();
  document.body.innerHTML = "";
});

function button(label: string): HTMLButtonElement {
  const found = [...document.body.querySelectorAll("button")].find(
    (b) => b.textContent?.trim() === label,
  );
  if (found === undefined) throw new Error(`No button: ${label}`);
  return found;
}
function show(install = INSTALL, isAdmin = true) {
  act(() =>
    root.render(
      <TooltipProvider>
        <EmDashUpdatesCard install={install} isAdmin={isAdmin} />
      </TooltipProvider>,
    ),
  );
}
async function check(plan = PLAN) {
  calls.checkEmdashUpgrade.mockResolvedValueOnce(plan);
  await act(async () => button("Check EmDash updates").click());
}

describe("EmDash updates", () => {
  it("resumes an existing prepared upgrade from the install instead of preparing another one", async () => {
    calls.getLatestEmdashUpgrade.mockResolvedValue({ ...UPGRADE, preparationJobId: "prep1" });
    show();
    await check();
    expect(container.querySelector('a[href="/catalog/source/prbuild1"]')?.textContent).toContain(
      "Review upgrade",
    );
    expect(button("Prepare upgrade").disabled).toBe(true);
    expect(calls.prepareEmdashUpgrade).not.toHaveBeenCalled();
  });

  it("offers recovery of a failed merged build from the install", async () => {
    calls.getLatestEmdashUpgrade.mockResolvedValue({
      ...UPGRADE,
      status: "merged",
      mergeSha: "c".repeat(40),
      mergedBuildId: "failedmerged1",
    });
    show();
    await check();
    expect(container.querySelector('a[href="/catalog/source/failedmerged1"]')).not.toBeNull();
    expect(button("Build merged upgrade again").disabled).toBe(false);
  });

  it("checks only on request and does not start an upgrade while checking", async () => {
    show();
    expect(calls.checkEmdashUpgrade).not.toHaveBeenCalled();
    await check();
    expect(calls.checkEmdashUpgrade).toHaveBeenCalledWith({ data: { installId: "blog1" } });
    expect(container.textContent).toContain("1.1.0");
    expect(container.textContent).toContain("1.3.0");
    expect(container.textContent).toContain("@acme/custom-plugin");
    expect(container.textContent).toContain("file:vendor/custom-plugin.tgz");
    expect(calls.prepareEmdashUpgrade).not.toHaveBeenCalled();
  });

  it("requires repository write access without treating build access as write access", async () => {
    show();
    await check({ ...PLAN, writeTokenAvailable: false });
    expect(button("Prepare upgrade").disabled).toBe(true);
    expect(container.textContent).toContain("Build-only tokens cannot change a repository");
    expect(container.querySelector('a[href="/settings/building#github-access"]')).not.toBeNull();
  });

  it("does not offer a preparation for unsupported or up-to-date repositories", async () => {
    show();
    await check({ ...PLAN, supported: false, reason: "No root EmDash dependency." });
    expect(container.textContent).toContain("No root EmDash dependency.");
    expect(container.textContent).not.toContain("Prepare upgrade");
    await check({ ...PLAN, upToDate: true });
    expect(container.textContent).toContain("The repository is up to date");
    expect(container.textContent).not.toContain("Prepare upgrade");
  });

  it.each([
    [INSTALL, false],
    [{ ...INSTALL, origin: "catalog" }, true],
    [{ ...INSTALL, source: null }, true],
  ])("has no upgrade actions outside repository admins", (install, admin) => {
    show(install as InstallDetail, admin as boolean);
    expect(container.textContent).toBe("");
  });

  it("pins preparation to the checked base and requires the build cost confirmation", async () => {
    show();
    await check();
    await act(async () => button("Prepare upgrade").click());
    expect(button("Prepare and build upgrade").disabled).toBe(true);
    expect(calls.prepareEmdashUpgrade).not.toHaveBeenCalled();
    const checkbox = document.body.querySelector<HTMLInputElement>('label input[type="checkbox"]');
    if (checkbox === null) throw new Error("No build cost confirmation");
    await act(async () => checkbox.click());
    expect(button("Prepare and build upgrade").disabled).toBe(false);
    calls.prepareEmdashUpgrade.mockResolvedValueOnce({ jobId: "job1" });
    await act(async () => document.body.querySelector("form")?.requestSubmit());
    expect(calls.prepareEmdashUpgrade).toHaveBeenCalledWith({
      data: {
        installId: "blog1",
        targetVersion: "1.3.0",
        expectedBaseSha: "a".repeat(40),
        costConfirmed: true,
      },
    });
    expect(calls.jobStarted).toHaveBeenCalledWith("job1", "EmDash upgrade started");
  });
});

describe("an EmDash upgrade review", () => {
  it("deploys only the build of the merged commit, never the old PR build after merging", () => {
    const merged = { ...UPGRADE, mergeSha: "b".repeat(40), mergedBuildId: "mergedbuild1" };
    expect(canDeployEmDashUpgradeBuild("prbuild1", merged)).toBe(false);
    expect(canDeployEmDashUpgradeBuild("mergedbuild1", merged)).toBe(true);
    expect(canDeployEmDashUpgradeBuild("normalbuild", null)).toBe(true);
  });
  it("offers a merge and rebuild, explains recovery limits, and never offers a direct deploy", () => {
    act(() => root.render(<EmDashUpgradeReview upgrade={UPGRADE} buildId="prbuild1" canMerge />));
    expect(button("Merge and build").disabled).toBe(false);
    expect(container.textContent).toContain("does not undo database migrations");
    expect(container.textContent).toContain("can discard content written after that snapshot");
    expect(container.querySelector('a[href="https://github.com/acme/blog/pull/2"]')).not.toBeNull();
    expect([...container.querySelectorAll("button")].some((b) => b.textContent === "Update")).toBe(
      false,
    );
  });

  it("requires a successful, reviewable build before allowing a merge", () => {
    act(() =>
      root.render(<EmDashUpgradeReview upgrade={UPGRADE} buildId="prbuild1" canMerge={false} />),
    );
    expect(button("Merge and build").disabled).toBe(true);
  });

  it("shows migration evidence and refuses a plugin that declares incompatibility", () => {
    const report = {
      addedMigrations: ["007_add_search_index"],
      plugins: [
        { name: "@acme/custom-plugin", version: "0.4.0", range: "^1.1.0", compatible: false },
      ],
    } as NonNullable<EmDashUpgradeView["report"]>;
    act(() =>
      root.render(
        <EmDashUpgradeReview upgrade={{ ...UPGRADE, report }} buildId="prbuild1" canMerge />,
      ),
    );
    expect(container.textContent).toContain("007_add_search_index");
    expect(container.textContent).toContain("declared incompatible");
    expect(button("Merge and build").disabled).toBe(true);
  });

  it("does not merge an already merged upgrade again", () => {
    act(() =>
      root.render(
        <EmDashUpgradeReview
          upgrade={{ ...UPGRADE, mergeSha: "b".repeat(40), mergedBuildId: "mergedbuild1" }}
          buildId="prbuild1"
          canMerge
        />,
      ),
    );
    expect(container.textContent).not.toContain("Merge and build");
  });
});
