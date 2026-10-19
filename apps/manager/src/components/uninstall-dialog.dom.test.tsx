import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { InstallDetail } from "../installs/installs.functions";

const calls = vi.hoisted(() => ({
  getResourceUsage: vi.fn(async () => []),
  startUninstall: vi.fn(async () => ({ jobId: "uninstall-job" })),
  retryUninstall: vi.fn(async () => ({ jobId: "retry-job" })),
  jobStarted: vi.fn(async () => {}),
}));
vi.mock("../installs/uninstall.functions", () => ({
  getResourceUsage: calls.getResourceUsage,
  startUninstall: calls.startUninstall,
  retryUninstall: calls.retryUninstall,
}));
vi.mock("./job-started", () => ({ useJobStarted: () => calls.jobStarted }));

const { UninstallDialog } = await import("./uninstall-dialog");

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

function install(
  adopted: boolean,
  kind: InstallDetail["build"]["kind"] = "adopted",
): InstallDetail {
  return {
    id: "existing-install",
    label: "QuarionGG blog",
    workerName: "existing-blog",
    build: { kind, image: null, builtAt: null, installer: null, stage: null },
    adoption: adopted
      ? {
          appName: "EmDash",
          address: "https://blog.example.com",
          adoptedAt: "2026-10-19T12:00:00.000Z",
          routes: [],
        }
      : null,
    resources: [
      { id: "worker", kind: "worker", name: "existing-blog" },
      { id: "database", kind: "d1", name: "existing-data" },
      { id: "namespace", kind: "kv", name: "existing-cache" },
      { id: "bucket", kind: "r2", name: "existing-media" },
    ].map((resource) => ({
      ...resource,
      binding: null,
      cfId: resource.id,
      managedByApp: false,
      missing: false,
    })),
    domains: [],
    externalDomains: [],
    secretNames: [],
    emailRoutes: [],
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

function button(name: string, within: HTMLElement = document.body): HTMLButtonElement {
  const found = [...within.querySelectorAll("button")].find(
    (item) => item.textContent?.trim() === name,
  );
  if (found === undefined) throw new Error(`No button ${name}`);
  return found;
}

async function click(item: HTMLElement) {
  await act(async () => item.click());
}

async function open(detail: InstallDetail): Promise<HTMLElement> {
  act(() => root.render(<UninstallDialog install={detail} mode="start" />));
  await click(button("Uninstall", container));
  const dialog = document.body.querySelector<HTMLElement>('[role="alertdialog"]');
  if (dialog === null) throw new Error("No uninstall confirmation");
  return dialog;
}

function dataChoices(dialog: HTMLElement): HTMLInputElement[] {
  return [...dialog.querySelectorAll<HTMLInputElement>('input[type="checkbox"]')];
}

async function confirm(dialog: HTMLElement) {
  const field = dialog.querySelector<HTMLInputElement>('input:not([type="checkbox"])');
  if (field === null) throw new Error("No Worker name confirmation");
  const set = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set;
  act(() => {
    set?.call(field, "existing-blog");
    field.dispatchEvent(new Event("input", { bubbles: true }));
  });
  await click(button("Uninstall", dialog));
}

describe("uninstall data choices", () => {
  it.each(["adopted", "sandbox"] as const)(
    "keeps adopted data by default with the %s deployment kind",
    async (kind) => {
      const dialog = await open(install(true, kind));
      expect(dataChoices(dialog).map((choice) => choice.checked)).toEqual([false, false, false]);
      expect(calls.startUninstall).not.toHaveBeenCalled();
      await confirm(dialog);
      expect(calls.startUninstall).toHaveBeenCalledWith({
        data: { installId: "existing-install", deleteResources: [] },
      });
      expect(calls.jobStarted).toHaveBeenCalledWith("uninstall-job", "Uninstall started");
    },
  );

  it("requires an explicit data selection to delete an adopted database", async () => {
    const dialog = await open(install(true));
    const database = dataChoices(dialog)[0];
    if (database === undefined) throw new Error("No database choice");
    await click(database);
    await confirm(dialog);
    expect(calls.startUninstall).toHaveBeenCalledWith({
      data: { installId: "existing-install", deleteResources: ["database"] },
    });
  });

  it("preserves the existing deletion defaults for ordinary installations", async () => {
    const dialog = await open(install(false, "artifact"));
    expect(dataChoices(dialog).map((choice) => choice.checked)).toEqual([true, true, true]);
    await confirm(dialog);
    expect(calls.startUninstall).toHaveBeenCalledWith({
      data: {
        installId: "existing-install",
        deleteResources: ["database", "namespace", "bucket"],
      },
    });
  });
});
