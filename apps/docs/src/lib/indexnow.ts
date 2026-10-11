/**
 * The site's IndexNow key (https://www.indexnow.org/documentation). The search
 * engines check it against `public/<key>.txt`, which holds the key and nothing
 * else, before they take a submission.
 */
export const INDEXNOW_KEY = "352e356927234335b6fd98fe348a99f4";

/** Shares submissions with every search engine that takes part (Bing, Yandex, Seznam, Naver, ...). */
export const INDEXNOW_ENDPOINT = "https://api.indexnow.org/indexnow";

/** Each page of a sitemap, by absolute URL, with its `<lastmod>` day or null. */
export function readSitemap(xml: string): Map<string, string | null> {
  const pages = new Map<string, string | null>();
  for (const [, url] of xml.matchAll(/<url>([\s\S]*?)<\/url>/g)) {
    const loc = /<loc>([^<]*)<\/loc>/.exec(url ?? "")?.[1];
    if (!loc) continue;
    const lastmod = /<lastmod>([^<]*)<\/lastmod>/.exec(url ?? "")?.[1] ?? null;
    pages.set(unescapeXml(loc), lastmod);
  }
  return pages;
}

function unescapeXml(text: string): string {
  return text
    .replaceAll("&lt;", "<")
    .replaceAll("&gt;", ">")
    .replaceAll("&quot;", '"')
    .replaceAll("&apos;", "'")
    .replaceAll("&amp;", "&");
}

/**
 * The pages of the new sitemap to tell the search engines about: those the
 * previous sitemap did not have, those whose day changed, and, when
 * `undated` is set, every page without a day (the docs pages, which change
 * only with a commit). Without a previous sitemap, every page.
 */
export function changedPages(
  next: Map<string, string | null>,
  previous: Map<string, string | null> | null,
  { undated = false }: { undated?: boolean } = {},
): string[] {
  return [...next]
    .filter(([url, lastmod]) => {
      if (previous === null || !previous.has(url)) return true;
      if (lastmod === null) return undated;
      return previous.get(url) !== lastmod;
    })
    .map(([url]) => url);
}

/**
 * The body of an IndexNow submission of the given pages, all on the site at
 * `origin` (`https://appflare.dev`), which serves the key file.
 */
export function indexNowBody(origin: string, urls: readonly string[]) {
  return {
    host: new URL(origin).host,
    key: INDEXNOW_KEY,
    keyLocation: `${origin}/${INDEXNOW_KEY}.txt`,
    urlList: urls,
  };
}
