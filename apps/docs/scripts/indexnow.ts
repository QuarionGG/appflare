// Tells the search engines that take part in IndexNow (Bing, Yandex, ...)
// which pages of appflare.dev changed in a deploy, by comparing the deployed
// sitemap with the one that was live before it. Run by .github/workflows/docs.yml
// after appflare.dev deploys:
//
//   node apps/docs/scripts/indexnow.ts <new sitemap.xml> [<previous sitemap.xml>] [--undated]
//
// Without a previous sitemap every page is submitted. `--undated` adds the pages
// with no <lastmod> (the docs pages), for deploys of a commit. The site is the
// one the sitemap names, so this needs nothing built.
import { existsSync, readFileSync } from "node:fs";
import { changedPages, INDEXNOW_ENDPOINT, indexNowBody, readSitemap } from "../src/lib/indexnow.ts";

const args = process.argv.slice(2);
const undated = args.includes("--undated");
const [nextPath, previousPath] = args.filter((arg) => arg !== "--undated");
if (!nextPath) {
  throw new Error("Usage: indexnow.ts <new sitemap.xml> [<previous sitemap.xml>] [--undated]");
}

const next = readSitemap(readFileSync(nextPath, "utf8"));
const [first] = next.keys();
if (!first) throw new Error(`${nextPath} lists no pages`);
const origin = new URL(first).origin;
const previous =
  previousPath && existsSync(previousPath) ? readSitemap(readFileSync(previousPath, "utf8")) : null;
// An empty previous sitemap (the fetch failed) says nothing about what changed.
const urls = changedPages(next, previous?.size ? previous : null, { undated });

if (urls.length === 0) {
  console.log("No page changed; nothing to submit to IndexNow.");
  process.exit(0);
}

// One request takes up to 10,000 URLs; the site has a few hundred.
const response = await fetch(INDEXNOW_ENDPOINT, {
  method: "POST",
  headers: { "content-type": "application/json; charset=utf-8" },
  body: JSON.stringify(indexNowBody(origin, urls)),
});
// 200: taken. 202: taken, the key is still being checked.
if (response.status !== 200 && response.status !== 202) {
  throw new Error(`IndexNow answered ${response.status}: ${await response.text()}`);
}
console.log(`Submitted ${urls.length} pages of ${origin} to IndexNow (${response.status}):`);
for (const url of urls) console.log(`  ${url}`);
