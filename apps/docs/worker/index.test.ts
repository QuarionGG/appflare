import { describe, expect, it } from "vitest";
import worker, { type Env, type Fetcher } from "./index.ts";

function recorder(name: string, files: Record<string, string> = {}): Fetcher & { seen: Request[] } {
  const seen: Request[] = [];
  return {
    seen,
    async fetch(request) {
      seen.push(request);
      const { pathname } = new URL(request.url);
      const file = files[pathname];
      if (file !== undefined) {
        return new Response(file, { headers: { "Content-Type": "text/plain" } });
      }
      // A file the build did not write; a page (no extension) is always there.
      if (/\.\w+$/.test(pathname)) return new Response("not found", { status: 404 });
      return new Response(name, { headers: { "Content-Type": "text/html" } });
    },
  };
}

function env(
  files: Record<string, string> = {},
): Env & { ASSETS: { seen: Request[] }; INSTALLER: { seen: Request[] } } {
  return { ASSETS: recorder("assets", files), INSTALLER: recorder("installer") };
}

describe("the site's Worker", () => {
  it("hands /api/install/* to the installer, the request itself, unchanged", async () => {
    const bindings = env();
    const request = new Request("https://appflare.dev/api/install/accounts", {
      method: "POST",
      headers: { authorization: "Bearer access-token-value", "content-type": "application/json" },
      body: "{}",
    });
    const response = await worker.fetch(request, bindings);
    expect(await response.text()).toBe("installer");
    expect(bindings.INSTALLER.seen).toEqual([request]);
    expect(bindings.ASSETS.seen).toEqual([]);
  });

  it("serves everything else from the static files", async () => {
    for (const path of ["/", "/deploy/", "/api/search.json", "/api/install", "/api/installer/x"]) {
      const bindings = env({ "/api/search.json": "assets" });
      const response = await worker.fetch(new Request(`https://appflare.dev${path}`), bindings);
      expect(await response.text(), path).toBe("assets");
      expect(bindings.INSTALLER.seen, path).toEqual([]);
    }
  });

  it("answers a page asked for as Markdown with the page's Markdown", async () => {
    const files = { "/start/install.md": "# Install", "/llms.txt": "# Appflare" };
    for (const [path, body] of [
      ["/start/install/", "# Install"],
      ["/start/install", "# Install"],
      ["/", "# Appflare"],
    ] as const) {
      const response = await worker.fetch(
        new Request(`https://appflare.dev${path}`, { headers: { Accept: "text/markdown" } }),
        env(files),
      );
      expect(await response.text(), path).toBe(body);
      expect(response.headers.get("Content-Type"), path).toBe("text/markdown; charset=utf-8");
      expect(response.headers.get("Vary"), path).toBe("Accept");
    }
  });

  it("answers HTML to a browser, and to a page without Markdown", async () => {
    const files = { "/start/install.md": "# Install" };
    for (const [path, accept] of [
      ["/start/install/", "text/html,application/xhtml+xml,*/*;q=0.8"],
      ["/apps/counterscale/", "text/markdown"],
    ] as const) {
      const response = await worker.fetch(
        new Request(`https://appflare.dev${path}`, { headers: { Accept: accept } }),
        env(files),
      );
      expect(await response.text(), path).toBe("assets");
      expect(response.headers.get("Content-Type"), path).toBe("text/html");
      expect(response.headers.get("Vary"), path).toBe("Accept");
    }
  });

  it("answers a missing build file with a 404 browsers never keep", async () => {
    const bindings = env();
    const response = await worker.fetch(
      new Request("https://appflare.dev/assets/main-0ld.js"),
      bindings,
    );
    expect(response.status).toBe(404);
    expect(response.headers.get("Cache-Control")).toBe("no-store");
    expect(await response.text()).toBe("Not found\n");
    // Not the 404 page: a script asked for it.
    expect(bindings.ASSETS.seen.map((r) => new URL(r.url).pathname)).toEqual([
      "/assets/main-0ld.js",
    ]);
  });

  it("serves a build file the static files have, as they answer it", async () => {
    const response = await worker.fetch(
      new Request("https://appflare.dev/assets/main-n3w.js"),
      env({ "/assets/main-n3w.js": "code" }),
    );
    expect(response.status).toBe(200);
    expect(await response.text()).toBe("code");
  });

  it("answers any other path without a file with the 404 page, as a 404", async () => {
    for (const path of ["/no-such-page/", "/no-such-page", "/no-such-file.png"]) {
      const bindings = notFoundSite();
      const response = await worker.fetch(new Request(`https://appflare.dev${path}`), bindings);
      expect(response.status, path).toBe(404);
      expect(await response.text(), path).toBe("the 404 page");
      expect(response.headers.get("Content-Type"), path).toBe("text/html");
    }
    const head = await worker.fetch(
      new Request("https://appflare.dev/no-such-page/", { method: "HEAD" }),
      notFoundSite(),
    );
    expect(head.status).toBe(404);
  });
});

/** Static files with only the 404 page, at `/404`, as html_handling answers it. */
function notFoundSite(): Env & { ASSETS: { seen: Request[] } } {
  const seen: Request[] = [];
  return {
    ASSETS: {
      seen,
      async fetch(request) {
        seen.push(request);
        if (new URL(request.url).pathname !== "/404") return new Response(null, { status: 404 });
        return new Response(request.method === "HEAD" ? null : "the 404 page", {
          headers: { "Content-Type": "text/html" },
        });
      },
    },
    INSTALLER: recorder("installer"),
  };
}
