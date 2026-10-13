---
"@appflare/manager": patch
---

Uninstalling an app now leaves nothing running or billing. Before it deletes the app's Workers, it removes every queue consumer that still delivers to them, including ones the install did not set up (Cloudflare refuses to delete a Worker or a queue while one is left), and on Workers Paid it deletes the container applications behind the app's Durable Objects, which Cloudflare keeps running after the Worker is gone. For an app its own installer deploys, Appflare notes these before the installer's destroy command runs and deletes any the command leaves behind. When the uninstall finishes, the app's spend protection settings, usage alerts and any pause in place are forgotten; its usage history stays for this month's bill.
