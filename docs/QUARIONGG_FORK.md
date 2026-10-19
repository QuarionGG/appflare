# QuarionGG Appflare fork

This fork adds **Import existing app** for deployments already running in the
connected Cloudflare account. Import records the deployment in Appflare without
reinstalling it or taking ownership of its resources.

## Import an existing deployment

1. Open **Catalog > Add > Import existing app**, or use **Import existing app** on Home.
2. Discover Workers in the connected account. Select every Worker belonging to the
   app, choose its primary Worker, and give the app a name.
3. Review its bindings, custom domains, routes, schedules and deployed versions.
   Some optional metadata may be unavailable with the current Cloudflare permissions;
   the preview lists those gaps.
4. Import the reviewed deployment. Appflare checks the selection again before saving.

The imported app appears on Home and in **Your apps**. Its page shows the latest
saved inventory and links to the application and its Workers in Cloudflare.
**Refresh inventory** reads Cloudflare again. **Forget record** removes only the
Appflare import records; it leaves the Workers and all their data running.

## What import preserves

Discovery, preview, import and refresh use Cloudflare read APIs only. They do not
upload Worker code, copy databases or objects, change bindings, rotate secrets,
move domains, modify email routing, alter schedules, or run migrations on an app's
database. The only writes are to the Appflare manager's own D1 import tables.

Variable values, JSON values and secret values are never returned or stored in
inventory. Binding names, types and allowlisted resource references are recorded.
Workers and attached resources stay in the same Cloudflare account with the same
identifiers, domains and deployment pipeline. Import does not promise that every
external integration or email-routing rule has been discovered; incomplete reads
are shown explicitly.

Import is separate from catalog installation. Imported Workers do not participate
in catalog updates, automatic app updates, pause/resume, reconfiguration, rollback
or uninstall. Keep using the app's existing repository, CI or Cloudflare dashboard
for those operations. Full lifecycle management would require an explicit source
and release mapping plus separate permission to change the deployment.

Only admins can discover, preview, import, refresh or forget apps. Signed-in members
may view saved inventory. Internal Appflare Workers, catalog-managed Workers and
Workers already imported elsewhere are excluded, with final server-side checks.

## Maintaining this fork

The fork includes upstream `manager@0.5.1`. Comparing that tag with
`manager@0.5.0` confirms no changes to the manager's database schema, migration
files or migrator. This upgrade retains the fork's existing 14 migrations,
including `0013_imported_apps`; it requires no additional database migration.

Label reviewed fork builds with semver build metadata:

```sh
APPFLARE_VERSION='0.5.1+quariongg.1' pnpm --filter @appflare/manager build
```

Vite bakes this value into both the code and the generated Worker variable.
The `+quariongg.1` suffix identifies our build while keeping its release precedence
equal to upstream `0.5.1`. A prerelease suffix such as `-quariongg.1` sorts below
the same upstream release and causes a misleading update notice. With build
metadata, `0.5.1` is current and a future `0.5.2` still appears as available.
Keep `APPFLARE_TELEMETRY=off` on the production Worker: build metadata is not a
prerelease, so the version label alone no longer suppresses telemetry.

Official manager self-updates would replace this fork's code, hiding its import
feature. This fork blocks official manager self-update jobs and explains the
custom update channel in Updates settings. Catalog app updates continue normally.
Import data uses additive tables, so rolling the manager back to an official
release leaves those records stored, but that release does not show them.

Appflare records migration progress as an ordinal count, rather than a set of
migration identifiers. This fork adds `0013_imported_apps`, bringing that count to
14. If upstream later adds a different migration at ordinal 0013, do not deploy
that upstream build directly: it could treat the fork's count as proof that its
different SQL already ran. Reconcile both migration histories and test an upgrade
from this fork's database before releasing a rebased fork. The self-update guard
prevents the automatic path; it cannot prevent a manual Cloudflare deployment.

Do not deploy the checked-in `apps/manager/wrangler.jsonc`: it contains upstream's
development account and resource identifiers. Any production rollout must use the
current Appflare Worker's actual account, D1, KV, Workflow and self-service bindings,
retain its secrets and domains, and retain the previous Worker version for rollback.
The additive import migration affects only the manager's database at startup.

Building this branch or opening its pull request does not deploy it or import any
production Worker. Review and approve the switch to the fork before changing the
running manager's update channel.
