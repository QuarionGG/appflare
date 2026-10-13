---
"@appflare/cf-api": patch
"@appflare/manager": patch
---

Appflare no longer asks for Workers Tail access. Nothing in Appflare reads a Worker's live logs, so Cloudflare sign-in stops requesting `workers-tail.read` and the API token form Appflare opens no longer selects Workers Tail: Read. Managers connected with it are not asked to reconnect. Their sign-in keeps the permission until it is made again, and the connection card's permission list says Appflare does not use it. A token that has it keeps working, and you can remove Workers Tail from it in the Cloudflare dashboard.
