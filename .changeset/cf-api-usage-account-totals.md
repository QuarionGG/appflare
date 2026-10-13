---
"@appflare/cf-api": patch
---

`client.usage.accountTotals({ from, to })` reads the whole account's use over a range of what the Workers Free plan limits per day: Worker requests, Durable Objects requests, duration and rows, D1 rows read and written, KV operations, Queues operations, Workflow steps, Workers AI neurons, Analytics Engine data points and Browser Rendering time, every resource counted. `datasets` reads only the ones given. Each dataset answers one summed row (KV one per operation type), and with `batched()` the totals go out in the same request as the other reads. A combined request now holds up to 32 fields, up from 20.
