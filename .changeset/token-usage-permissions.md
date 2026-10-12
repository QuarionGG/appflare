---
"@appflare/manager": patch
---

The API token form now lists the permissions usage and spend protection read with, under their own heading: Account Analytics: Read and Workers Observability: Read, both selected by the token link. A Cloudflare sign-in asks for the same two, and for Notifications as well, so that a later version can add Cloudflare's own billing alerts without asking you to sign in again; the token leaves Notifications out until something uses it.
