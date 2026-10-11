import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { changedPages, INDEXNOW_KEY, indexNowBody, readSitemap } from "./indexnow.ts";
import { SITE_URL } from "./shared.ts";
import { renderSitemap } from "./sitemap.ts";

describe("IndexNow", () => {
  it("publishes the key file the search engines check", () => {
    const file = new URL(`../../public/${INDEXNOW_KEY}.txt`, import.meta.url);
    expect(readFileSync(file, "utf8").trim()).toBe(INDEXNOW_KEY);
  });

  it("reads back the sitemap the site renders", () => {
    const xml = renderSitemap(["/", "/a&b/", { path: "/apps/a/", lastmod: "2026-10-08" }]);
    expect([...readSitemap(xml)]).toEqual([
      [`${SITE_URL}/`, null],
      [`${SITE_URL}/a&b/`, null],
      [`${SITE_URL}/apps/a/`, "2026-10-08"],
    ]);
  });

  const previous = new Map<string, string | null>([
    ["https://x/docs/", null],
    ["https://x/apps/same/", "2026-10-01"],
    ["https://x/apps/tested/", "2026-10-01"],
    ["https://x/apps/gone/", "2026-10-01"],
  ]);
  const next = new Map<string, string | null>([
    ["https://x/docs/", null],
    ["https://x/apps/same/", "2026-10-01"],
    ["https://x/apps/tested/", "2026-10-02"],
    ["https://x/apps/new/", "2026-10-02"],
  ]);

  it("submits new pages and pages whose day changed", () => {
    expect(changedPages(next, previous)).toEqual(["https://x/apps/tested/", "https://x/apps/new/"]);
  });

  it("adds the undated pages when asked", () => {
    expect(changedPages(next, previous, { undated: true })).toEqual([
      "https://x/docs/",
      "https://x/apps/tested/",
      "https://x/apps/new/",
    ]);
  });

  it("submits every page without a previous sitemap", () => {
    expect(changedPages(next, null)).toEqual([...next.keys()]);
  });

  it("names the site's host and key file", () => {
    expect(indexNowBody(SITE_URL, [`${SITE_URL}/`])).toEqual({
      host: new URL(SITE_URL).host,
      key: INDEXNOW_KEY,
      keyLocation: `${SITE_URL}/${INDEXNOW_KEY}.txt`,
      urlList: [`${SITE_URL}/`],
    });
  });
});
