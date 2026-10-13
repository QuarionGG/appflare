import { describe, expect, it } from "vitest";
import { isServerPath, missingBuildFile, serveRequest } from "./static-files";

const DEV = "https://appflare.ada.workers.dev";

/**
 * The assets binding as the manager configures it (`not_found_handling:
 * "none"`, html_handling's default): a path answers its file, `/` answers
 * `/index.html`, anything else a 404. Records what was asked for.
 */
function assetsOf(files: Record<string, string>) {
  const asked: Request[] = [];
  const assets = {
    fetch: async (input: RequestInfo | URL, init?: RequestInit) => {
      const request = new Request(input, init);
      asked.push(request);
      const path = new URL(request.url).pathname;
      const body = files[path === "/" ? "/index.html" : path];
      if (body === undefined) return new Response(null, { status: 404 });
      if (request.headers.get("if-none-match") === `"${body}"`) {
        return new Response(null, { status: 304 });
      }
      return new Response(request.method === "HEAD" ? null : body, {
        headers: { etag: `"${body}"`, "cache-control": "public, max-age=0, must-revalidate" },
      });
    },
  };
  return { assets: assets as Pick<Fetcher, "fetch">, asked };
}

const app = async (request: Request) =>
  new Response(`app ${request.method} ${new URL(request.url).pathname}`);

async function serve(path: string, init: RequestInit = {}, files: Record<string, string> = BUILT) {
  const { assets, asked } = assetsOf(files);
  const response = await serveRequest(new Request(`${DEV}${path}`, init), assets, app);
  return { response, asked: asked.map((r) => new URL(r.url).pathname) };
}

const BUILT: Record<string, string> = { "/index.html": "shell", "/favicon.svg": "icon" };

describe("missingBuildFile", () => {
  it("answers a build file that reached the Worker with a 404 nobody keeps", async () => {
    const response = missingBuildFile(new Request(`${DEV}/assets/index-0ld.js`));
    expect(response?.status).toBe(404);
    expect(response?.headers.get("cache-control")).toBe("no-store");
    expect(response?.headers.get("content-type")).toMatch(/^text\/plain/);
    expect(await response?.text()).toBe("Not found\n");
  });

  it("leaves pages, server paths and other files alone", () => {
    for (const path of [
      "/",
      "/assets",
      "/apps/abc",
      "/api/health",
      "/favicon.svg",
      "/x/assets/a",
    ]) {
      expect(missingBuildFile(new Request(`${DEV}${path}`))).toBeNull();
    }
  });
});

describe("serveRequest", () => {
  it("answers the front page with its file, the shell", async () => {
    const { response, asked } = await serve("/");
    expect(await response.text()).toBe("shell");
    expect(asked).toEqual(["/"]);
  });

  it("answers deep links and unknown paths with the shell, asked for at /", async () => {
    for (const path of ["/apps/abc", "/settings/general", "/no/such/page?x=1", "/missing.json"]) {
      const { response, asked } = await serve(path);
      expect(response.status).toBe(200);
      expect(await response.text()).toBe("shell");
      expect(response.headers.get("cache-control")).toBe("public, max-age=0, must-revalidate");
      expect(asked).toEqual([new URL(`${DEV}${path}`).pathname, "/"]);
    }
  });

  it("keeps the method and the browser's validators when it asks for the shell", async () => {
    const head = await serve("/settings", { method: "HEAD" });
    expect(head.response.status).toBe(200);
    expect(await head.response.text()).toBe("");
    const cached = await serve("/settings", { headers: { "if-none-match": '"shell"' } });
    expect(cached.response.status).toBe(304);
  });

  it("answers a public file with the file (development, where it reaches the Worker)", async () => {
    expect(await (await serve("/favicon.svg")).response.text()).toBe("icon");
  });

  it("hands server paths and other methods to the app", async () => {
    expect(await (await serve("/api/health")).response.text()).toBe("app GET /api/health");
    expect(await (await serve("/_serverFn/abc", { method: "POST" })).response.text()).toBe(
      "app POST /_serverFn/abc",
    );
    const post = await serve("/login", { method: "POST" });
    expect(await post.response.text()).toBe("app POST /login");
    expect(post.asked).toEqual([]);
  });

  it("hands a page to the app while there is no shell yet (the build renders it)", async () => {
    expect(await (await serve("/", {}, {})).response.text()).toBe("app GET /");
    expect(await (await serve("/apps/abc", {}, {})).response.text()).toBe("app GET /apps/abc");
  });
});

describe("isServerPath", () => {
  it("is true for server routes and server functions only", () => {
    expect(isServerPath("/api/health")).toBe(true);
    expect(isServerPath("/_serverFn/abc")).toBe(true);
    expect(isServerPath("/apps/x")).toBe(false);
    expect(isServerPath("/favicon.svg")).toBe(false);
    expect(isServerPath("/api")).toBe(false);
  });
});
