/**
 * What the Worker answers for requests the static files did not.
 *
 * Routing (wrangler.jsonc `assets`): `/` reaches the Worker first; any other
 * path is served from the static files when one matches it, without running
 * the Worker, and reaches the Worker otherwise (`not_found_handling: "none"`).
 * So the Worker sees every page (no page is a file, except the shell at `/`,
 * which it serves itself), server routes and functions, and requests for
 * files that do not exist.
 *
 * A missing build file is the case that matters. Each update names its files
 * under /assets/ after their content, and `_headers` lets browsers keep
 * them for a year without asking again. While an update spreads, a page from
 * the new version can ask the old one for a file it never had; a tab opened
 * before the update can ask for a file the new version no longer has. That
 * request must fail plainly and must not be kept: a 404 with `no-store`. An
 * answer kept for a year (the shell, or a 404 carrying the `/assets/*`
 * header) broke the page until the browser's cache was emptied.
 */

/** Where the build puts its content-named files. */
export const BUILD_FILES_PREFIX = "/assets/";

/** Paths TanStack Start answers first: server routes and server functions. */
export function isServerPath(pathname: string): boolean {
  return pathname.startsWith("/api/") || pathname.startsWith("/_serverFn/");
}

/**
 * The answer to a request for a build file that does not exist, or null for
 * any other path. Existing build files are served before the Worker runs, so
 * a request under /assets/ that reaches it has no file. Never asks the static
 * files: their answer would carry `_headers`' one-year rule for /assets/*.
 */
export function missingBuildFile(request: Pick<Request, "url">): Response | null {
  if (!new URL(request.url).pathname.startsWith(BUILD_FILES_PREFIX)) return null;
  return new Response("Not found\n", {
    status: 404,
    headers: {
      "content-type": "text/plain; charset=utf-8",
      "cache-control": "no-store",
    },
  });
}

/**
 * Serves a request that is neither a missing build file nor refused by the
 * checks before it. A GET or HEAD outside the server paths is a page: the
 * static file at that path when there is one (the shell at `/`, or a public
 * file in development, where every request reaches the Worker), otherwise the
 * SPA shell, which the static files answer at `/`. The shell keeps the
 * static files' own headers: revalidated on every load. Everything else goes
 * to `app`, TanStack Start: server routes and functions, and a page while
 * the shell does not exist yet (the build renders it through the Worker, and
 * development serves it from Vite).
 */
export async function serveRequest(
  request: Request,
  assets: Pick<Fetcher, "fetch">,
  app: (request: Request) => Response | Promise<Response>,
): Promise<Response> {
  const url = new URL(request.url);
  const readOnly = request.method === "GET" || request.method === "HEAD";
  if (!readOnly || isServerPath(url.pathname)) return app(request);
  const file = await assets.fetch(request);
  if (file.status !== 404) return file;
  await file.body?.cancel();
  if (url.pathname === "/") return app(request);
  // The shell, asked for as `/`: `/index.html` itself answers a redirect to
  // `/` (html_handling). Same method and headers, so a HEAD stays a HEAD and
  // a browser holding the shell gets its 304.
  const shell = await assets.fetch(new Request(new URL("/", url), request));
  if (shell.status !== 404) return shell;
  await shell.body?.cancel();
  return app(request);
}
