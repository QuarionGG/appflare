# Updating a custom EmDash site

The QuarionGG fork can prepare dependency updates for an EmDash site built from its own GitHub repository. It keeps the site's theme, plugin declarations, vendored plugin packages, configuration, data resources and domains. It updates only `emdash`, `@emdash-cms/cloudflare` and `pnpm-lock.yaml`.

The first version supports a root project with a pinned pnpm package manager and a tracked lockfile. A configuration-only `pnpm-workspace.yaml` is preserved; workspace packages and pnpm catalogs require a manual upgrade.

## GitHub access

Keep the existing read-only build token. Add a separate fine-grained token in **Settings → Building apps → GitHub access**, choosing **Repository updates** and exactly one `owner/repository`.

On GitHub, select only that repository and grant **Contents: Read and write** and **Pull requests: Read and write**. Metadata read access is automatic. Do not add workflow permissions. The update token is stored as a secret on the sandbox Worker. It is never sent to the build container or used for ordinary builds or release downloads.

Existing tokens remain read-only build/download tokens after upgrading Appflare. Their usage is never expanded automatically.

## Update from Appflare

1. Open the custom app and choose **Check EmDash updates**. Appflare compares its deployed/source version with the stable releases of both EmDash packages.
2. Choose **Prepare upgrade**. A credential-free container resolves the new lockfile, checks the plugins' declared EmDash ranges, compares migration identities and builds the project. It refuses unexpected tracked changes. Successful preparation creates a dependency-only commit and pull request, then builds that exact GitHub commit for review. This phase runs a preparation build and an artifact build, each billed as normal sandbox usage.
3. Follow **Review EmDash upgrade** from the job or app overview. Review the versions, preserved plugins, migration report, source diff and artifact build. GitHub's required checks and reviews still apply.
4. Choose **Merge and build**. Appflare verifies the PR's repository, base branch, base commit and reviewed head. It merges only a PR GitHub marks ready, verifies the merge parents and builds the actual merge commit. A concurrent source change stops the flow for review; it is never silently overwritten.
5. Review that final build and choose **Update**. This uses the existing update pipeline and existing Worker/data bindings. A PR-head artifact cannot be installed, even after its PR has been merged.

The dependency commit makes later rebuilds reproducible: rebuilding the configured branch keeps the upgrade. Appflare offers the existing review again when returning to the app, and can retry an unsuccessful build after merging.

## Compatibility and recovery

Plugin compatibility checks cover declared peer and plugin-manifest ranges. A successful build does not prove every plugin's runtime behavior. The flow preserves custom plugin versions; it does not replace plugins with catalog equivalents or rewrite the theme for a new API. Unsupported version ranges, incompatible plugins, removed/reordered migrations, or unexpected source changes stop preparation.

The build can regenerate `.emdash/migrations.json`. Preparation validates this generated metadata against the new migration identity and the original database configuration, then restores that derived file in the temporary checkout. The final pinned build regenerates the correct manifest before packaging. No site database is contacted during preparation.

Before an update gets traffic, Appflare takes the existing Worker snapshot and D1 recovery bookmark. EmDash may apply core migrations on its first request, including a preview request. Rolling back the Worker does **not** undo database migrations. Restoring D1 is a separate reviewed operation and can discard content written after the recovery point. Review the migration report and verify the public site, admin and custom plugin paths after deployment.

This feature requires the reviewed fork's manager and sandbox Worker. Deploying an official sandbox Worker removes its upgrade RPC capability; ordinary builds still work, while EmDash preparation reports the missing capability instead of attempting an upgrade.
