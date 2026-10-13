import { createRouter } from "@tanstack/react-router";
import { NotFound } from "./components/not-found";
import { PagePending } from "./components/page-pending";
import { RouteError } from "./components/route-error";
import { NOT_FOUND_MODE } from "./router-not-found";
import { PENDING_MIN_MS, PENDING_MS } from "./router-timing";
import { routeTree } from "./routeTree.gen";
import { browserStaleBuildReloadDeps, installStaleBuildReload } from "./stale-build-reload";

export function getRouter() {
  // A tab still on an older build reloads once when a file of a page fails
  // to load (stale-build-reload.ts). Browser only: the build renders the
  // shell through this function too.
  if (typeof window !== "undefined") {
    installStaleBuildReload(window, browserStaleBuildReloadDeps());
  }
  return createRouter({
    routeTree,
    scrollRestoration: true,
    defaultPreload: "intent",
    defaultPendingMs: PENDING_MS,
    defaultPendingMinMs: PENDING_MIN_MS,
    // Inside the signed-in shell it takes the page's place only; elsewhere,
    // and as the SPA shell's body (SPA mode renders the pending component in
    // place of the matched routes), it fills the window.
    defaultPendingComponent: PagePending,
    defaultErrorComponent: RouteError,
    notFoundMode: NOT_FOUND_MODE,
    defaultNotFoundComponent: NotFound,
  });
}

declare module "@tanstack/react-router" {
  interface Register {
    router: ReturnType<typeof getRouter>;
  }
}
