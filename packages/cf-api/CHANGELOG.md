# @appflare/cf-api

## 0.4.0

### Minor Changes

- bbbe11d: `client.usage` reads each product's usage hour by hour from Cloudflare's GraphQL Analytics API, for a list of resource ids and a time range, and returns one row per metric, resource and UTC hour (`{ dataset, metric, resourceId, hour, value }`, `hour` in Unix seconds). It covers Workers by script name (requests, subrequests, errors, CPU time), Durable Objects by namespace id (invocations, active time, GB-seconds of duration, SQLite rows read and written, WebSocket messages, key-value storage units, SQLite storage), the busiest single Durable Object's alarms per namespace and hour, D1 (rows read and written, database size), KV (reads, writes, deletes, lists, stored bytes), R2 by bucket (one metric per operation, so class A and class B can be told apart, and stored bytes), Queues (billable operations), Workflows (instance starts, steps, CPU time), Workers AI by model (neurons, requests), Vectorize (queries, queried and stored dimensions), Analytics Engine (data points per dataset), Browser Rendering by script (sessions and browser time) and Containers by application (allocated memory and disk in byte-seconds, CPU seconds, bytes sent). Every request carries the current time in its filter, because Cloudflare otherwise answers the same query from a cache for 20 minutes or more. Ids are sent in batches, ranges in windows of at most 30 days, and a full answer is split again until it fits. GraphQL errors, which Cloudflare sends with HTTP 200, throw `CloudflareGraphQLError` with Cloudflare's messages and codes. `client.usage.batched()` gives the same reads, sending those started together as one GraphQL request (one aliased field per dataset) instead of one request each; when Cloudflare refuses any field, it answers such a request with no data at all, so each read is then sent again on its own and fails only where it would have failed alone.
  
  New calls to pause and resume an app's parts: `workers.getScriptSettings` and `workers.setObservability` (`/workers/scripts/{name}/script-settings`: turns Workers Logs on or off without a new version, and changes no other setting), `containers.setMaxInstances`, `queues.getQueue` and `queues.setDeliveryPaused`, and `workflows.listInstances` (every page, optionally by status), `workflows.pauseInstance` and `workflows.resumeInstance`.
  
  Every manager sign-in now also asks for `account-analytics.read`. `missingSpendProtectionScopes` says whether a grant lacks it, the one scope usage reads with, so a manager connected before can ask for a reconnect.

### Patch Changes

- f35cc23: `client.usage.accountTotals({ from, to })` reads the whole account's use over a range of what the Workers Free plan limits per day: Worker requests, Durable Objects requests, duration and rows, D1 rows read and written, KV operations, Queues operations, Workflow steps, Workers AI neurons, Analytics Engine data points and Browser Rendering time, every resource counted. `datasets` reads only the ones given. Each dataset answers one summed row (KV one per operation type), and with `batched()` the totals go out in the same request as the other reads. A combined request now holds up to 32 fields, up from 20.
- 1049a15: Appflare no longer asks for Workers Tail access. Nothing in Appflare reads a Worker's live logs, so Cloudflare sign-in stops requesting `workers-tail.read` and the API token form Appflare opens no longer selects Workers Tail: Read. Managers connected with it are not asked to reconnect. Their sign-in keeps the permission until it is made again, and the connection card's permission list says Appflare does not use it. A token that has it keeps working, and you can remove Workers Tail from it in the Cloudflare dashboard.

## 0.3.0

### Minor Changes

- 0987d9a: A client can take a function that returns the credential instead of a fixed token. It is called before each request, so a client that lives through a long job always sends a current credential; when it fails, nothing is sent. Asset-upload requests keep using their own upload token.
- 0987d9a: `accounts.list()` lists every account a credential can reach (`GET /accounts`, every page up to a limit), whatever account the client is bound to.
- 0987d9a: Helpers for Cloudflare's OAuth protocol, for a public client. A new `@appflare/cf-api/oauth` entry (also exported from the package root) uses only `fetch` and WebCrypto, so it runs in a browser, a Worker and Node 22. It has the authorize, token and revoke endpoints and Appflare's callback address, PKCE (S256), the authorization URL, and requests that exchange a code, refresh a grant and revoke a token. A refresh returns the rotated refresh token, or the one it sent when Cloudflare returns none. A failed request throws `CloudflareOAuthError`, which says whether the grant is gone and has to be authorized again (`invalid_grant`), or whether the failure was temporary and can be retried (no complete response, HTTP 5xx or 429). Codes, verifiers and tokens never appear in its message or its `code`, in any encoding. The `state` helpers encode and check which kind of authorization a callback belongs to. A reconnect may pass its code only to an `https:` origin, or over `http:` to `localhost` or `127.0.0.1`.
  
  The entry also lists the OAuth scopes Appflare's manager asks for: one per permission group of its API token, plus `offline_access` so that Cloudflare issues a refresh token. Billing is the one group with no OAuth scope, so an OAuth grant cannot list the account's subscriptions to read its Workers plan. `missingManagerScopes` lists the scopes a grant lacks.
- bfb0d36: `hyperdrive.patchConfig` changes a configuration's query caching alone (`PATCH /hyperdrive/configs/{id}`), and `emailRouting.updateRule` replaces a routing rule in place (`PUT /zones/{zone_id}/email/routing/rules/{rule_id}`).

### Patch Changes

- 8197a5c: `pipelines.getStream` and `pipelines.getSink` now type the stream's `schema` and where a sink writes (`config.bucket`, `namespace`, `table_name`), as Cloudflare returns them. A sink's credential stays untyped and unread.
- b890dd0: `queues.listQueues` reads every page of the account's queues instead of only the first.
- f71f0b9: `WorkflowInfo` now types the `schedules` that `getWorkflow` answers with (each `cron` and its `next_instance`), absent when the Workflow has none, and `WorkflowPutBody` notes that an empty `schedules` list, which Workers Free accepts too, says the Workflow has none.

## 0.2.1

### Patch Changes

- 482eb0b: Add `workflows.putWorkflow` (`PUT /workflows/{name}`), which creates or updates a Workflow for a script and class, with `isWorkflowNotFound` and `isWorkflowCronPaidOnly` for the codes Cloudflare answers with.

## 0.2.0

### Minor Changes

- b2e7bfd: Access applications can now protect several addresses at once. `createApp` and `updateApp` take `destinations`, each a `public` hostname (optionally with a path, such as `host/open/*`) or a `worker` destination that covers a Worker's workers.dev URL, every preview URL and its custom domains; `domain` still works, and an application needs one or the other. An application's `policies` can reference reusable policies as `{ id, precedence }` or be written inline, and policy rules are typed for `service_token` and `any_valid_service_token` as well as `email` and `everyone`. `AccessApp` now carries `destinations` and `self_hosted_domains`, and its `domain` may be `null`.
  
  New calls: `listReusablePolicies`, `getReusablePolicy`, `createReusablePolicy`, `updateReusablePolicy` and `deleteReusablePolicy` for account-level reusable policies, and `listServiceTokens`, `createServiceToken` (the only answer with the secret), `deleteServiceToken`, `refreshServiceToken` and `rotateServiceToken` for service tokens. Deleting a service token that a policy still uses is refused with code 12139, exported as `ACCESS_SERVICE_TOKEN_IN_USE`; `isServiceTokenInUse(error)` recognises it. `accessAppCoverage(app)` lists every hostname and path an application protects, from `domain`, `self_hosted_domains` and its `public` destinations, with its `worker` destinations apart. A script upload's answer now types its `tag`, which is what a `worker` destination names.
- b2e7bfd: `probeAccessServiceTokens` reports whether the token can read Access service tokens ("Access: Service Tokens"): `readable` when the list answers (which proves Read, not Edit), `no-permission` when it is refused. `probeAccountSetup` now runs it with the workers.dev, Zero Trust and Analytics Engine probes and answers `accessServiceTokens` next to them.

### Patch Changes

- b2e7bfd: `WorkerScript` (the items of `listScripts`) now types the script's `tag`, the id an Access `worker` destination names a Worker by.

## 0.1.0

### Minor Changes

- 346d608: The first public release of Appflare's typed client for the Cloudflare REST API endpoints it uses, among them Workers, D1, KV, R2, Queues, Containers, custom domains and Access. It runs in Workers and in Node, and can check what an account and its plan allow before an install starts. It can also update an Access application in place, for example to move it to another hostname.
