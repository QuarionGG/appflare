/**
 * A tab opened before Appflare was updated still runs the old build. When it
 * opens a page whose code it has not loaded yet, it asks for a file named
 * after the old build's content, which the new version no longer has (or,
 * while an update spreads, a file the version answering does not have yet).
 * The server answers 404 and nobody keeps it (server/static-files.ts), so a
 * reload loads the current build and the page works.
 *
 * The reload is TanStack Router's own (`lazyRouteComponent`, which wraps
 * every route component the build splits off): a failed import is only
 * remembered when the route is preloaded, as on hovering a link
 * (`defaultPreload: "intent"`), and reloads the page when the route renders,
 * that is when a navigation needs it. It reloads once per failing file in a
 * tab (a `sessionStorage` mark), so an outage cannot make it reload again and
 * again; the next failure shows the route's error view, which recognises the
 * error ({@link isStaleBuildError}) and offers a reload. Vite's
 * `vite:preloadError` is not used: it fires for a hover's preload too, and a
 * reload there would throw away a page that works, with whatever was typed
 * in it. stale-build.dom.test.tsx pins this behaviour of the router.
 */

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
