# @appflare/schema

## 0.6.1

### Fixed

- Deploys keep each Worker's Workers Logs setting.

## 0.6.0

### Added

- `normalizeForD1Query` rewrites SQL so D1's query API ends each trigger where SQLite does; `d1QueryProblems` names what it cannot fix.
- `schemaFileProblems` and `baselineFileProblems` report those trigger problems too.

### Fixed

- `splitSqlStatements` finds a trigger's body as SQLite does, so a column or table named `end` or `begin` no longer splits the trigger.

## 0.5.0

### Added

- Catalog manifests take optional `features` (3 to 6 lines on what the app does) and `alternativeTo` (1 to 5 products it can replace).
- Both need no revision and are carried in index rows (`appFeaturesSchema`, `appAlternativesSchema`).

### Changed

- The `revision` description says editing `tagline`, `features`, `alternativeTo`, `licenseNote` or `authors` needs a higher revision too.

## 0.4.0

### Added

- `install.emailRouting.worker` names the Worker that receives an app's mail; `{{emailDomain}}` and `{{emailZoneId}}` name its email zone.
- `resources.hyperdrive[binding].caching` turns Hyperdrive query caching on or off.
- A catalog secret may have its own `key`, so each Worker of an entry can get its own value under one name.
- Config patches may set a var to text, add a Workers AI binding, give a service binding `props`, and drop `mtls_certificates` or an unknown key.
- `worker.workflowSettings` records each Workflow's limits, concurrency, schedules and retention (`workflowSettingsSchema`).
- `tokenPermissions` may ask for the account group `Images`.
- `requires` can name manager features, such as `secret-keys` or `email-worker`, so older managers leave such entries out.

### Changed

- A `"plan": "free"` entry may list up to 24 Workers; `indexRequires(manifest)` adds `manager:spread-jobs` for more than three.
- `MAX_FREE_PLAN_ENTRY_WORKERS` now equals `MAX_ENTRY_WORKERS` and is deprecated.
- A Workflow on a schedule needs `"plan": "paid"` (`scheduledWorkflowPlanProblem`).
- `{{emailDomain}}` and `{{emailZoneId}}` are refused in an entry without `install.emailRouting`.
- `SANDBOX_CONTAINERS` lists two container classes for self-deploying installers, and each entry says which runs it serves (`use`).

## 0.3.0

### Added

- Catalog secrets and vars take an optional `link`, `{ "label", "url" }`, shown beside the field (`catalogFieldLinkSchema`).
- A catalog manifest takes an optional `openPath`, such as `"/dashboard"`, where the Open buttons go (`openPathSchema`, `appOpenUrl`).

### Changed

- The descriptions of `bump` and `bump.autoMerge` follow the catalog's new rule; parsing is unchanged.
- `codemod-manifest-v1` keeps an explicit `"bump": { "autoMerge": false }`.

### Fixed

- The description of `definesWorkflow` no longer says that uploading a Worker creates its Workflows.

## 0.2.0

### Added

- An optional `access` block says how an app goes with Cloudflare Access: a `mode` and `bypass` paths that stay public (`accessOfferOf`, `accessBypassPaths`).
- Var placeholders `{{accessTeamDomain}}`, `{{accessTeamName}}`, `{{accessAud}}` and `{{accessCertsUrl}}`, empty while the app is not protected.
- `requires` takes `"access"`, and index rows take an optional `accessOffer` (`indexAccessOffer`).
- A revision may change the `access` block and add `"access"` to `requires` (`requirementsRevisionProblem`).
- A Workflow binding may name another Worker of the entry as `{{workerName:<name>}}`, with `definesWorkflow` and `upstreamWorkflowName`.

### Changed

- The `install.health.mode` description says Cloudflare Access's sign-in redirect never counts as the app serving.

## 0.1.0

### Added

- **First public release.** Zod schemas and a JSON Schema for version 1 of the catalog manifest (`appflare.jsonc`), the release artifact and the catalog index.
- The fixed list of catalog categories and the public keys that verify signed releases.
