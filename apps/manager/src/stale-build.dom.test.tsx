import {
  createMemoryHistory,
  createRootRoute,
  createRoute,
  createRouter,
  lazyRouteComponent,
  RouterProvider,
} from "@tanstack/react-router";
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, type MockInstance, vi } from "vitest";
import { RouteError, STALE_BUILD_MESSAGE } from "./components/route-error";

/**
 * How a tab on an older build recovers (stale-build.ts), with TanStack
 * Router's own behaviour pinned: a route whose code fails to load is not a
 * reason to reload while it is only preloaded (a hover, with
 * `defaultPreload: "intent"`), reloads once when a navigation needs it, and
 * shows the error view, with a reload, when it fails again after that.
 */

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const CHUNK = "https://appflare.example/assets/settings-0ld.js";

let container: HTMLDivElement;
let root: Root;
let reload: MockInstance<() => void>;

beforeEach(() => {
  sessionStorage.clear();
  reload = vi.spyOn(window.location, "reload").mockImplementation(() => {});
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
  reload.mockRestore();
});

/**
 * A page as the build splits it: `/settings`'s component is a separate file,
 * which this server no longer has. A fresh router stands for a fresh page load.
 */
async function openPage() {
  const rootRoute = createRootRoute();
  const home = createRoute({
    getParentRoute: () => rootRoute,
    path: "/",
    component: () => "Home",
  });
  const settings = createRoute({
    getParentRoute: () => rootRoute,
    path: "/settings",
    component: lazyRouteComponent(() =>
      Promise.reject(new TypeError(`Failed to fetch dynamically imported module: ${CHUNK}`)),
    ),
  });
  const router = createRouter({
    routeTree: rootRoute.addChildren([home, settings]),
    history: createMemoryHistory({ initialEntries: ["/"] }),
    defaultPreload: "intent",
    defaultErrorComponent: RouteError,
  });
  await act(async () => {
    await router.load();
    root.render(createElement(RouterProvider, { router }));
  });
  return router;
}

describe("a tab on an older build", () => {
  it("does not reload when a hover preloads a route whose code is gone", async () => {
    const router = await openPage();
    await act(async () => {
      await router.preloadRoute({ to: "/settings" });
    });
    expect(reload).not.toHaveBeenCalled();
    expect(container.textContent).toBe("Home");
    expect(sessionStorage.length).toBe(0);
  });

  it("reloads once when a navigation needs that code", async () => {
    const router = await openPage();
    await act(async () => {
      await router.preloadRoute({ to: "/settings" });
    });
    await act(async () => {
      await router.navigate({ to: "/settings" });
    });
    expect(reload).toHaveBeenCalledTimes(1);
  });

  it("shows the error view with a reload, and does not reload again, when it fails after the reload", async () => {
    const first = await openPage();
    await act(async () => {
      await first.navigate({ to: "/settings" });
    });
    expect(reload).toHaveBeenCalledTimes(1);
    act(() => root.unmount());
    root = createRoot(container);

    // The reloaded page (the tab's session storage is kept), and the file is still gone.
    const second = await openPage();
    await act(async () => {
      await second.navigate({ to: "/settings" });
    });
    expect(reload).toHaveBeenCalledTimes(1);
    expect(container.textContent).toContain(STALE_BUILD_MESSAGE);
    expect(container.querySelector("button")?.textContent).toContain("Reload");
  });
});
