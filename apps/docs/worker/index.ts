/**
 * The site's Worker. It runs before the static files for the site's pages
 * (wrangler.jsonc's `run_worker_first`) and does two things:
 *
 * - It hands `/api/install/*`, unchanged, to the hosted installer through a
 *   service binding. The deploy page and the installer's API so share one
 *   origin, and the browser never makes a cross-origin request to the
 *   installer. Nothing here reads or logs that request: it carries the
 *   visitor's Cloudflare access token in its Authorization header.
 * - It answers a request for a page that asks for Markdown
 *   (`Accept: text/markdown`) with the page's Markdown, which the build wrote
 *   next to it (`/start/install/` is `/start/install.md`), and the front page
 *   with `llms.txt`. A page without Markdown, such as an app's page, is
 *   answered with its HTML.
 *
 * Every other request is the static files' own answer, untouched, except a
 * path that matches no file (wrangler.jsonc's `not_found_handling: "none"`
 * sends those here). A missing build file under /assets/ gets a plain 404
 * that browsers never keep: `_headers` lets them keep /assets/* for a year,
 * and a page from one version can ask for a file another version has not
 * got (while a deploy spreads, or from a tab opened before it). Any other
 * path gets the site's 404 page.
 */

import { markdownPath, prefersMarkdown } from "./markdown.ts";

/** A binding that answers requests: the static files, or another Worker. */
export interface Fetcher {
  fetch(request: Request): Promise<Response>;
}

export interface Env {
  /** The site's static files. */
  ASSETS: Fetcher;
  /** The hosted installer, `appflare-installer`, its default entrypoint. */
  INSTALLER: Fetcher;
}

// Not exported: the runtime reads every value the main module exports as an
// entrypoint, and refuses one that is not a handler.
const INSTALLER_PREFIX = "/api/install/";
/** Where the build puts its content-named files. */
const BUILD_FILES_PREFIX = "/assets/";
/** The site's 404 page, `404.html`, at the address the static files answer it. */
const NOT_FOUND_PAGE = "/404";

/**
 * The answer for a path that matches no file: never the static files' own
 * 404 under /assets/, which carries the one-year rule from `_headers`.
 */
async function notFound(request: Request, env: Env): Promise<Response> {
  if (new URL(request.url).pathname.startsWith(BUILD_FILES_PREFIX)) {
    return new Response("Not found\n", {
      status: 404,
      headers: { "Content-Type": "text/plain; charset=utf-8", "Cache-Control": "no-store" },
    });
  }
  const page = await env.ASSETS.fetch(
    new Request(new URL(NOT_FOUND_PAGE, request.url), { method: request.method }),
  );
  return new Response(page.body, { status: 404, headers: page.headers });
}

/** The static files' answer, or {@link notFound} when they have none. */
async function staticFile(request: Request, env: Env): Promise<Response> {
  const response = await env.ASSETS.fetch(request);
  if (response.status !== 404) return response;
  await response.body?.cancel();
  return notFound(request, env);
}

async function markdownResponse(
  request: Request,
  env: Env,
  path: string,
): Promise<Response | null> {
  const response = await env.ASSETS.fetch(
    new Request(new URL(path, request.url), { method: request.method }),
  );
  if (!response.ok) return null;
  const headers = new Headers(response.headers);
  headers.set("Content-Type", "text/markdown; charset=utf-8");
  headers.append("Vary", "Accept");
  return new Response(response.body, { status: response.status, headers });
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const { pathname } = new URL(request.url);
    if (pathname.startsWith(INSTALLER_PREFIX)) return env.INSTALLER.fetch(request);
    const path = markdownPath(pathname);
    if (path === null || (request.method !== "GET" && request.method !== "HEAD")) {
      return staticFile(request, env);
    }
    if (prefersMarkdown(request.headers.get("Accept"))) {
      const markdown = await markdownResponse(request, env, path);
      if (markdown) return markdown;
    }
    // A page's address now answers HTML or Markdown by the Accept header.
    const response = await staticFile(request, env);
    const headers = new Headers(response.headers);
    headers.append("Vary", "Accept");
    return new Response(response.body, {
      status: response.status,
      statusText: response.statusText,
      headers,
    });
  },
};
