import { TooltipProvider } from "@cloudflare/kumo";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { InstallDetail } from "../installs/installs.functions";

const calls = vi.hoisted(() => ({ checkSourceChanges: vi.fn(), startSourceBuild: vi.fn() }));
vi.mock("../installs/source-builds.functions", () => calls);
vi.mock("./job-started", () => ({ useJobStarted: () => async () => {} }));

const { SourceChangesCard } = await import("./source-changes-card");

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

function install(kind: "adopted" | "sandbox"): InstallDetail {
  return {
    id: "existing-blog",
    name: "EmDash",
    label: "QuarionGG blog",
    origin: "repository",
    status: "installed",
    activeJobId: null,
    build: { kind, image: null, builtAt: null, installer: null, stage: null },
    source: { url: "https://github.com/QuarionGG/custom-blog", ref: "main" },
    pinSha: kind === "adopted" ? null : "a".repeat(40),
  } as Partial<InstallDetail> as InstallDetail;
}

let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
  vi.clearAllMocks();
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
  document.body.innerHTML = "";
});

function show(detail: InstallDetail, isAdmin = false) {
  act(() =>
    root.render(
      <TooltipProvider>
        <SourceChangesCard install={detail} isAdmin={isAdmin} />
      </TooltipProvider>,
    ),
  );
}

describe("source provenance", () => {
  it("describes an adopted repository as future update source without claiming it produced the Worker", () => {
    show(install("adopted"));
    expect(container.textContent).toContain("Updates follow");
    expect(container.textContent).toContain("its original commit is not recorded");
    expect(container.textContent).not.toContain("Built from");
    expect(
      container.querySelector('a[href="https://github.com/QuarionGG/custom-blog"]'),
    ).not.toBeNull();
    expect(calls.checkSourceChanges).not.toHaveBeenCalled();
  });

  it("preserves recorded build provenance for ordinary repository installations", () => {
    show(install("sandbox"));
    expect(container.textContent).toContain("Built from");
    expect(container.textContent).toContain("a".repeat(12));
    expect(container.textContent).not.toContain("its original commit is not recorded");
  });

  it.each([false, true])(
    "does not claim an adopted deployment's commit is known when checking a pinned=%s source",
    async (pinned) => {
      calls.checkSourceChanges.mockResolvedValue({
        repo: "QuarionGG/custom-blog",
        ref: pinned ? "b".repeat(40) : "main",
        pinned,
        installed: null,
        latest: "b".repeat(40),
        changed: true,
      });
      show(install("adopted"), true);
      const check = [...container.querySelectorAll("button")].find(
        (item) => item.textContent?.trim() === "Check for changes",
      );
      if (check === undefined) throw new Error("No source check action");
      await act(async () => check.click());
      expect(calls.checkSourceChanges).toHaveBeenCalledWith({
        data: { installId: "existing-blog" },
      });
      expect(container.textContent).not.toContain("has moved");
      expect(container.textContent).not.toContain("It was built from a commit");
      expect(container.textContent).toContain("b".repeat(12));
    },
  );
});
