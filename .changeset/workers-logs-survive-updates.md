---
"@appflare/manager": patch
"@appflare/schema": patch
"@appflare/pack": patch
---

Workers Logs now stay as you set them when Appflare deploys an app again. Updates, settings changes, sandbox Worker updates and Appflare's own updates read each Worker's Workers Logs setting from Cloudflare just before they upload it and send it back unchanged; before, a full upload (an update with Durable Object migrations, for example) turned Workers Logs off. A new app still starts with the setting its catalog entry asks for. When Cloudflare does not say whether Workers Logs are on, the deploy stops before it uploads anything and says why. For an app that deploys itself with its own installer, Appflare puts the whole setting back (sampling included) if the installer changed it, also when the update fails after the installer ran. Admins can turn Workers Logs on or off for every Worker of an app in one go, while no job runs on it, and the change shows in the app's activity. One upload now reads at most 41 ranges of a release, one fewer than before, to leave room for that read.
