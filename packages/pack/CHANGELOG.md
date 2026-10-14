# @appflare/pack

## 0.4.1

### Fixed

- Deploys keep each Worker's Workers Logs setting.

## 0.4.0

### Changed

- The packer and `verify` refuse D1 SQL with `END;` inside a string or quoted name in a trigger body, naming the line and how to rewrite it.

## 0.3.0

### Added

- `{{emailDomain}}` and `{{emailZoneId}}` work in vars and service binding props of an entry with `install.emailRouting`.
- `props` on a service binding to a Worker of the entry are kept and their placeholders checked (`servicePropsPlaceholderProblems`).
- A config patch can set vars to text and add a Workers AI binding.
- A Workflow's `limits`, `concurrency`, `schedules` and `default_retention` are recorded as `worker.workflowSettings` (`collectWorkflowSettings`).

### Changed

- A wrangler config with `mtls_certificates` or a top-level key the packer does not know fails the pack, naming the config patch that drops it.
- A Workflow on a schedule needs `"plan": "paid"`, and Workflow settings on a binding to another Worker's Workflow fail (`WorkflowSettingsError`).
- `{{emailDomain}}` and `{{emailZoneId}}` are refused in an entry without `install.emailRouting`, and placeholders in a JSON var's keys are checked.
- A Worker in the service-worker format fails the pack with a message saying so.

### Fixed

- A wrangler config's own `build.command` runs in the config's directory instead of the repository root.
- Each module is recorded with the type `wrangler deploy` would upload it as, so module `rules` such as `Text` apply.
- A Workflow binding that names its own Worker is recorded without its `script_name` in an app of one Worker too.

## 0.2.0

### Added

- Apps of several Workers built by the Cloudflare Vite plugin now pack, including a Workflow binding to another Worker of the entry.
- A config patch applies to a config the build generated, as long as it leaves `main`, `assets.directory` and `build` alone.

## 0.1.0

### Added

- **First public release.** `appflare-pack` turns an app's repository into a signed release Appflare can install.
- It builds the app, checks its wrangler config against the catalog manifest, writes a zip listing every file's hash, and verifies a release before publishing.
- It shows which parts of a wrangler config Appflare supports.
