/**
 * A tab opened before Appflare was updated still runs the old build. When it
 * opens a page whose code it has not loaded yet, it asks for a file named
 * after the old build's content, which the new version no longer has (or,
 * while an update spreads, a file the version answering does not have yet).
 * The import fails. Reloading loads the current build and the page works.
 *
 * Vite reports such a failure as a `vite:preloadError` event on the window
 * (its helper around every dynamic import that preloads anything); the page
 * reloads once. A failure that persists, such as an outage, must not reload
 * the page again and again: after a reload, failures within
 * {@link STALE_BUILD_RELOAD_WINDOW_MS} are left to the page's error view,
 * which offers a reload of its own. TanStack Router reloads a route
 * component's failed import once by itself (`lazyRouteComponent`), once per
 * failing file in a tab, and keeps the page waiting meanwhile. Both may
 * answer one failure; the browser then makes one reload (the second call
 * cancels the first one's request), and the route shows no error before it.
 */

/** The tab's `sessionStorage` key holding when the last such reload happened. */
export const STALE_BUILD_RELOAD_KEY = "appflare:stale-build-reload";
/** After a reload, how long further failures leave the page as it is. */
export const STALE_BUILD_RELOAD_WINDOW_MS = 60_000;

/** The Vite event for a dynamic import, or a file it preloads, that failed. */
export const PRELOAD_ERROR_EVENT = "vite:preloadError";

export interface StaleBuildReloadDeps {
  /** The tab's session storage, or null where it cannot be used. */
  storage: () => Pick<Storage, "getItem" | "setItem"> | null;
  reload: () => void;
  now: () => number;
}

/**
 * Reloads the page unless a reload for this already happened within the
 * window. True when it reloads. Without a usable session storage it never
 * reloads: nothing could stop a loop.
 */
export function reloadForNewBuild(deps: StaleBuildReloadDeps): boolean {
  const now = deps.now();
  try {
    const storage = deps.storage();
    if (storage === null) return false;
    const last = Number(storage.getItem(STALE_BUILD_RELOAD_KEY));
    if (last > 0 && now - last < STALE_BUILD_RELOAD_WINDOW_MS) return false;
    storage.setItem(STALE_BUILD_RELOAD_KEY, String(now));
  } catch {
    return false;
  }
  deps.reload();
  return true;
}

const installed = new WeakSet<object>();

/**
 * Listens for Vite's `vite:preloadError` on `target` (the window) and reloads
 * once ({@link reloadForNewBuild}). The error itself is not swallowed: it
 * still reaches the import's caller, so a route waits for the reload (TanStack
 * Router suspends on it) or, when no reload happens, shows its error view.
 * Installing twice on one target adds nothing.
 */
export function installStaleBuildReload(
  target: Pick<EventTarget, "addEventListener">,
  deps: StaleBuildReloadDeps,
): void {
  if (installed.has(target)) return;
  installed.add(target);
  target.addEventListener(PRELOAD_ERROR_EVENT, () => {
    if (reloadForNewBuild(deps)) console.warn("a file of this page failed to load; reloading");
  });
}

/** The browser's own dependencies for {@link installStaleBuildReload}. */
export function browserStaleBuildReloadDeps(): StaleBuildReloadDeps {
  return {
    storage: () => window.sessionStorage,
    reload: () => window.location.reload(),
    now: () => Date.now(),
  };
}

/**
 * Whether an error is a file of the page that failed to load: the messages
 * Chrome, Firefox and Safari give a failed dynamic import, and Vite's for a
 * stylesheet it preloads.
 */
export function isStaleBuildError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : undefined;
  if (message === undefined) return false;
  return [
    "Failed to fetch dynamically imported module",
    "error loading dynamically imported module",
    "Importing a module script failed",
    "Unable to preload CSS for",
  ].some((prefix) => message.startsWith(prefix));
}
