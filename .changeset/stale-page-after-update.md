---
"@appflare/manager": patch
---

A page could stop loading after Appflare updated until the browser's cache was emptied. While an update spreads, or in a tab opened before it, the page can ask for a file the version answering does not have. Appflare answered that with its page instead of an error, and the browser kept it as that file for a year, so reloading did not help. A missing file is now a plain "not found" that the browser never keeps, and the files Appflare does have are still kept for good. A tab still on the previous version reloads itself once when you open a page it can no longer load (never just because you pointed at a link), and if that does not help, the page says Appflare may have just been updated and offers a Reload button. This takes effect once you are on this version; a browser that already kept a broken file needs its cache emptied one last time. Rolling back to a version from before this one brings the old behaviour back for as long as it runs.
