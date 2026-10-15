import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ImportPage, type ImportPageActions } from "./import-page";
import { ImportedAppDetail } from "./imported-app-detail";
import { ImportedApps } from "./imported-apps";
import {
  type ImportedApp,
  type ImportedWorker,
  type ImportPreview,
  MAX_IMPORTED_WORKERS,
} from "./types";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const TIME = "2026-10-15T12:00:00.000Z";
const privateBinding = {
  name: "SESSION_KEY",
  type: "secret_text",
  resourceId: null,
  resourceName: null,
  scriptName: null,
  className: null,
  text: "secret-that-must-stay-hidden",
};

function worker(name: string): ImportedWorker {
  return {
    name,
    createdAt: TIME,
    modifiedAt: TIME,
    handlers: ["fetch"],
    bindings: [
      privateBinding,
      {
        name: "DB",
        type: "d1",
        resourceId: "d1-existing",
        resourceName: "calendar-data",
        scriptName: null,
        className: null,
      },
    ],
    domains: [{ id: `domain-${name}`, hostname: "cal.example.com", zoneName: "example.com" }],
    routes: [{ id: `route-${name}`, pattern: "example.com/api/*" }],
    schedules: [{ cron: "0 * * * *" }],
    deployments: [
      {
        id: "deployment-existing",
        createdAt: TIME,
        source: "wrangler",
        versions: [{ versionId: "version-existing", percentage: 100 }],
      },
    ],
    workersDevEnabled: false,
    warnings: [],
    missing: false,
  };
}

const APP: ImportedApp = {
  id: "import-1",
  displayName: "Calendar",
  workerNames: ["calendar", "calendar-api"],
  primaryWorker: "calendar",
  workers: [worker("calendar"), worker("calendar-api")],
  importedAt: TIME,
  refreshedAt: TIME,
  warnings: [],
  address: "https://cal.example.com",
};
const PREVIEW: ImportPreview = {
  workerNames: APP.workerNames,
  primaryWorker: APP.primaryWorker,
  displayName: APP.displayName,
  workers: APP.workers,
  warnings: [],
  address: APP.address,
  fingerprint: "a".repeat(64),
};

let container: HTMLDivElement;
let root: Root;
let actions: ImportPageActions;

beforeEach(() => {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  actions = {
    discover: vi.fn().mockResolvedValue({
      workers: APP.workers.map((item) => ({
        name: item.name,
        modifiedAt: TIME,
        handlers: item.handlers,
        routes: item.routes,
      })),
      warnings: [],
    }),
    preview: vi.fn().mockResolvedValue(PREVIEW),
    commit: vi.fn().mockResolvedValue(undefined),
  };
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
  document.body.innerHTML = "";
});

function button(name: string, within: HTMLElement = container): HTMLButtonElement {
  const found = [...within.querySelectorAll("button")].find(
    (item) => item.textContent?.trim() === name,
  );
  if (found === undefined) throw new Error(`No button ${name}`);
  return found;
}

async function click(item: HTMLElement) {
  await act(async () => item.click());
}

function box(name: string): HTMLElement {
  const found = [...container.querySelectorAll<HTMLElement>('[role="checkbox"]')].find(
    (item) => item.closest("label")?.textContent?.trim() === name,
  );
  if (found === undefined) throw new Error(`No checkbox ${name}`);
  const native = found.closest("label")?.querySelector<HTMLInputElement>('input[type="checkbox"]');
  if (native === null || native === undefined) throw new Error(`No native checkbox ${name}`);
  return native;
}

function input(label: string): HTMLInputElement {
  const found = [...container.querySelectorAll("label")].find((item) =>
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

function showImport(isAdmin = true) {
  act(() =>
    root.render(<ImportPage apps={[]} isAdmin={isAdmin} accountId="account-1" actions={actions} />),
  );
}

async function selectAndReview() {
  await click(button("Discover Workers"));
  await click(box("calendar"));
  await click(box("calendar-api"));
  type(input("App name"), "Calendar");
  await click(button("Preview inventory"));
}

describe("importing existing Workers", () => {
  it("discovers on request and previews a group without importing until the final action", async () => {
    showImport();
    expect(actions.discover).not.toHaveBeenCalled();
    await selectAndReview();
    expect(actions.preview).toHaveBeenCalledWith({
      workerNames: ["calendar", "calendar-api"],
      primaryWorker: "calendar",
      displayName: "Calendar",
    });
    expect(actions.commit).not.toHaveBeenCalled();
    expect(container.textContent).toContain("calendar-data");
    expect(container.textContent).toContain("version-existing");
    expect(container.textContent).not.toContain(privateBinding.text);
    await click(button("Import app"));
    expect(actions.commit).toHaveBeenCalledWith(PREVIEW);
  });

  it("requires a fresh preview after the selection or name changes", async () => {
    showImport();
    await selectAndReview();
    expect(container.querySelector("#import-review")).not.toBeNull();
    type(input("App name"), "Team calendar");
    expect(container.querySelector("#import-review")).toBeNull();
    expect(actions.commit).not.toHaveBeenCalled();
    await click(button("Preview inventory"));
    await click(box("calendar"));
    expect(container.querySelector("#import-review")).toBeNull();
    await click(button("Preview inventory"));
    expect(actions.preview).toHaveBeenLastCalledWith({
      workerNames: ["calendar-api"],
      primaryWorker: "calendar-api",
      displayName: "Team calendar",
    });
  });

  it("keeps the preview available and shows a failed import", async () => {
    vi.mocked(actions.commit).mockRejectedValue(
      new Error("The inventory changed. Preview the app again."),
    );
    showImport();
    await selectAndReview();
    await click(button("Import app"));
    expect(container.querySelector('[role="alert"]')?.textContent).toContain(
      "The inventory changed",
    );
    expect(button("Preview inventory").disabled).toBe(false);
  });

  it("gives members saved imports without discovery or import actions", () => {
    showImport(false);
    expect(container.querySelectorAll("button")).toHaveLength(0);
    expect(actions.discover).not.toHaveBeenCalled();
    expect(container.textContent).toContain("An admin can import apps");
  });

  it("keeps the group within the supported Worker limit", async () => {
    vi.mocked(actions.discover).mockResolvedValue({
      workers: Array.from({ length: MAX_IMPORTED_WORKERS + 1 }, (_, index) => ({
        name: `worker-${index}`,
        modifiedAt: TIME,
        handlers: ["fetch"],
        routes: [],
      })),
      warnings: [],
    });
    showImport();
    await click(button("Discover Workers"));
    for (let index = 0; index < MAX_IMPORTED_WORKERS; index++) await click(box(`worker-${index}`));
    expect((box(`worker-${MAX_IMPORTED_WORKERS}`) as HTMLInputElement).disabled).toBe(true);
    await click(button("Preview inventory"));
    expect(vi.mocked(actions.preview).mock.calls[0]?.[0].workerNames).toHaveLength(
      MAX_IMPORTED_WORKERS,
    );
  });
});

describe("an imported app's inventory", () => {
  it("shows metadata and resource references without deployment mutation controls", () => {
    act(() =>
      root.render(
        <ImportedAppDetail
          app={APP}
          isAdmin={false}
          accountId="account-1"
          onRefresh={vi.fn()}
          onForget={vi.fn()}
        />,
      ),
    );
    expect(container.textContent).toContain("SESSION_KEY");
    expect(container.textContent).toContain("secret_text");
    expect(container.textContent).toContain("d1-existing");
    expect(container.textContent).toContain("example.com/api/*");
    expect(container.textContent).toContain("0 * * * *");
    expect(container.textContent).not.toContain(privateBinding.text);
    expect(container.querySelector('a[href="https://cal.example.com/"]')).not.toBeNull();
    expect(container.querySelectorAll("button")).toHaveLength(0);
    expect(container.textContent).toContain("Keep deploying updates as you do today");
  });

  it("refreshes only on request and preserves the displayed inventory when refresh fails", async () => {
    const refresh = vi.fn().mockRejectedValue(new Error("Cloudflare is unavailable."));
    act(() =>
      root.render(
        <ImportedAppDetail
          app={APP}
          isAdmin
          accountId="account-1"
          onRefresh={refresh}
          onForget={vi.fn()}
        />,
      ),
    );
    expect(refresh).not.toHaveBeenCalled();
    await click(button("Refresh inventory"));
    expect(refresh).toHaveBeenCalledOnce();
    expect(container.querySelector('[role="alert"]')?.textContent).toContain(
      "Cloudflare is unavailable",
    );
    expect(container.textContent).toContain("d1-existing");
  });

  it("forgets only after confirming the Cloudflare resources are kept", async () => {
    const forget = vi.fn().mockResolvedValue(undefined);
    act(() =>
      root.render(
        <ImportedAppDetail
          app={APP}
          isAdmin
          accountId="account-1"
          onRefresh={vi.fn()}
          onForget={forget}
        />,
      ),
    );
    await click(button("Forget app"));
    const dialog = document.body.querySelector<HTMLElement>('[role="alertdialog"]');
    if (dialog === null) throw new Error("No confirmation dialog");
    expect(dialog.textContent).toContain("Removes only this app's imported record");
    expect(dialog.textContent).toContain("keep running");
    expect(dialog.textContent).toContain("calendar-api");
    expect(forget).not.toHaveBeenCalled();
    await click(button("Forget app", dialog));
    expect(forget).toHaveBeenCalledOnce();
  });

  it("renders cards without update actions and rejects unsafe Open addresses", () => {
    act(() => root.render(<ImportedApps apps={[{ ...APP, address: "javascript:alert(1)" }]} />));
    expect(container.querySelector('[data-imported-app-card="import-1"]')).not.toBeNull();
    expect(container.querySelector('a[href="/imports/import-1"]')).not.toBeNull();
    expect([...container.querySelectorAll("a")].map((item) => item.textContent)).toEqual([
      "View inventory",
    ]);
    expect(container.querySelectorAll("button")).toHaveLength(0);
  });
});
