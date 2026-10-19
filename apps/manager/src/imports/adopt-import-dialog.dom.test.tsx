import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, type Mock, vi } from "vitest";
import { AdoptImportDialog, type AdoptionActions } from "./adopt-import-dialog";
import type { AdoptionPreview } from "./adoption-types";
import { ImportedAppDetail } from "./imported-app-detail";
import type { ImportedApp } from "./types";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const APP: ImportedApp = {
  id: "import-existing",
  displayName: "EmDash",
  workerNames: ["existing-blog"],
  primaryWorker: "existing-blog",
  workers: [],
  importedAt: "2026-10-15T12:00:00.000Z",
  refreshedAt: "2026-10-15T12:00:00.000Z",
  warnings: [],
  address: "https://blog.example.com",
};

const PREVIEW: AdoptionPreview = {
  appId: APP.id,
  displayName: "QuarionGG blog",
  appName: "EmDash",
  repository: "https://github.com/QuarionGG/custom-blog",
  ref: "main",
  fingerprint: "a".repeat(64),
  workerName: APP.primaryWorker,
  currentVersionId: "deployed-version",
  address: APP.address,
  resources: [
    {
      kind: "worker",
      binding: null,
      name: APP.primaryWorker,
      cfId: APP.primaryWorker,
      managedBy: "appflare",
    },
    { kind: "d1", binding: "DB", name: "existing-data", cfId: "db-1", managedBy: "appflare" },
  ],
  resourceCount: 2,
  warnings: ["Existing resources become available to Appflare's lifecycle controls."],
};

let container: HTMLDivElement;
let root: Root;
let actions: AdoptionActions;
let onAdopted: Mock<(installId: string) => Promise<void>>;

beforeEach(() => {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  actions = {
    preview: vi.fn().mockResolvedValue(PREVIEW),
    commit: vi.fn().mockResolvedValue({ installId: "managed-existing" }),
  };
  onAdopted = vi.fn().mockResolvedValue(undefined);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
  document.body.innerHTML = "";
});

function button(name: string): HTMLButtonElement {
  const found = [...document.body.querySelectorAll("button")].find(
    (item) => item.textContent?.trim() === name,
  );
  if (found === undefined) throw new Error(`No button ${name}`);
  return found;
}

function input(label: string): HTMLInputElement {
  const found = [...document.body.querySelectorAll("label")].find((item) =>
    item.textContent?.startsWith(label),
  );
  const field = found?.htmlFor ? document.getElementById(found.htmlFor) : null;
  if (!(field instanceof HTMLInputElement)) throw new Error(`No input ${label}`);
  return field;
}

function type(field: HTMLInputElement, value: string) {
  const set = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set;
  act(() => {
    set?.call(field, value);
    field.dispatchEvent(new Event("input", { bubbles: true }));
  });
}

async function click(item: HTMLElement) {
  await act(async () => item.click());
}

async function openDialog(app = APP) {
  act(() => root.render(<AdoptImportDialog app={app} actions={actions} onAdopted={onAdopted} />));
  await click(button("Manage in Appflare"));
}

async function reviewAdoption() {
  await openDialog();
  type(input("Name in Appflare"), "QuarionGG blog");
  type(input("Repository"), "QuarionGG/custom-blog");
  await click(button("Preview adoption"));
}

describe("adopting an existing app", () => {
  it("reviews the current deployment and custom source before committing adoption", async () => {
    await openDialog();
    expect(input("Name in Appflare").value).toBe("EmDash");
    expect(input("App name").value).toBe("EmDash");
    expect(input("Branch, tag or commit").value).toBe("main");
    expect(button("Preview adoption").disabled).toBe(true);
    expect(actions.preview).not.toHaveBeenCalled();
    type(input("Name in Appflare"), "QuarionGG blog");
    type(input("Repository"), "QuarionGG/custom-blog");
    await click(button("Preview adoption"));
    expect(actions.preview).toHaveBeenCalledWith({
      appId: APP.id,
      displayName: "QuarionGG blog",
      appName: "EmDash",
      repository: "QuarionGG/custom-blog",
      ref: "main",
    });
    expect(actions.commit).not.toHaveBeenCalled();
    const review = document.body.querySelector("[data-adoption-review]");
    expect(review?.textContent).toContain("deployed-version");
    expect(review?.textContent).toContain("existing-data");
    expect(review?.textContent).toContain("https://github.com/QuarionGG/custom-blog");
    expect(document.body.textContent).toContain("Adoption changes Appflare records only");
    await click(button("Adopt app"));
    expect(actions.commit).toHaveBeenCalledWith({
      appId: PREVIEW.appId,
      displayName: PREVIEW.displayName,
      appName: PREVIEW.appName,
      repository: PREVIEW.repository,
      ref: PREVIEW.ref,
      fingerprint: PREVIEW.fingerprint,
    });
    expect(onAdopted).toHaveBeenCalledWith("managed-existing");
  });

  it("requires a new preview after changing the name or source", async () => {
    await reviewAdoption();
    type(input("Name in Appflare"), "Another blog");
    expect(document.body.querySelector("[data-adoption-review]")).toBeNull();
    expect(button("Preview adoption").disabled).toBe(false);
    await click(button("Preview adoption"));
    type(input("Branch, tag or commit"), "custom");
    expect(document.body.querySelector("[data-adoption-review]")).toBeNull();
    expect(actions.commit).not.toHaveBeenCalled();
  });

  it("shows a failed adoption and requires fresh review before retrying", async () => {
    vi.mocked(actions.commit).mockRejectedValue(new Error("The Worker changed. Preview it again."));
    await reviewAdoption();
    await click(button("Adopt app"));
    expect(document.body.querySelector('[role="alert"]')?.textContent).toContain(
      "The Worker changed",
    );
    expect(document.body.querySelector("[data-adoption-review]")).toBeNull();
    expect(button("Preview adoption").disabled).toBe(false);
    expect(onAdopted).not.toHaveBeenCalled();
  });

  it("keeps adoption unavailable for a group of Workers", async () => {
    await openDialog({ ...APP, workerNames: ["existing-blog", "existing-api"] });
    expect(button("Manage in Appflare").disabled).toBe(true);
    expect(document.body.querySelector('[role="dialog"]')).toBeNull();
    expect(actions.preview).not.toHaveBeenCalled();
  });

  it("only exposes adoption to admins", () => {
    act(() =>
      root.render(
        <ImportedAppDetail
          app={APP}
          accountId="account-1"
          isAdmin={false}
          onRefresh={vi.fn()}
          onForget={vi.fn()}
          adoption={{ actions, onAdopted }}
        />,
      ),
    );
    expect(container.textContent).not.toContain("Manage in Appflare");
    expect(actions.preview).not.toHaveBeenCalled();
  });
});
