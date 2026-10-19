import { Empty, LinkButton } from "@cloudflare/kumo";
import { DownloadSimpleIcon, PackageIcon, StorefrontIcon } from "@phosphor-icons/react";
import { useMemo } from "react";
import { PageHeader } from "../components/page-header";
import type { StartUpdateHandle } from "../components/update-banner";
import { ImportedApps } from "../imports/imported-apps";
import type { ImportedApp } from "../imports/types";
import { installLabel } from "../installs/display-name";
import type { UpdateAllOutcome } from "../installs/update-all";
import type { UsageAttention } from "../usage/attention";
import { type HomeUsageData, type HomeUsageView, homeUsageView } from "../usage/home";
import { AppCardUsage, AppCardUsageAction } from "./app-card-usage";
import { sortedApps, YourApps } from "./app-cards";
import { type AccountAttentionRow, type AttentionItem, appSignals } from "./attention";
import type { HomeApp } from "./layout-data";
import { NeedsAttention } from "./needs-attention";
import { HomeUsageSection } from "./usage-section";

/**
 * Home: "Needs attention" (only when something does), "Usage" (the
 * account's usage by app), then "Your apps" as cards, each with its own
 * usage. With no app installed, an empty state that offers the catalog;
 * Home shows it only after a click on Home, since arriving at `/` goes on to
 * the catalog then (`home-landing.ts`).
 */
export function HomeView({
  apps,
  items,
  isAdmin,
  update,
  onDismissAccountRow,
  onUpdateAllOutcome,
  now,
  usage,
  importedApps = [],
}: {
  apps: readonly HomeApp[];
  items: readonly AttentionItem[];
  isAdmin: boolean;
  update: StartUpdateHandle;
  onDismissAccountRow(row: AccountAttentionRow): void;
  onUpdateAllOutcome(outcome: UpdateAllOutcome): void;
  now: Date;
  /** Home's usage; null when it could not be read; left out, Home shows no usage. */
  usage?: HomeUsageData | null;
  importedApps?: readonly ImportedApp[];
}) {
  const usageRows = useMemo(
    () => items.flatMap((item): UsageAttention[] => (item.kind === "usage" ? [item.usage] : [])),
    [items],
  );
  const view = useMemo<HomeUsageView | null>(
    () =>
      usage === undefined || usage === null
        ? null
        : homeUsageView({
            data: usage,
            apps: sortedApps(apps).map((app) => ({ id: app.id, label: installLabel(app) })),
            attention: usageRows,
          }),
    [usage, apps, usageRows],
  );
  // Without the usage permissions there are no numbers: the cards show none either.
  const needsAccess = usage?.needsAccess ?? null;
  const cards = view !== null && needsAccess === null ? view.cards : null;
  return (
    <>
      <PageHeader
        title="Home"
        description="What needs your attention, and the apps in this Cloudflare account."
        actions={
          <>
            {isAdmin && (
              <LinkButton href="/imports" variant="secondary" icon={<DownloadSimpleIcon />}>
                Import existing app
              </LinkButton>
            )}
            {(apps.length > 0 || importedApps.length > 0) && (
              <LinkButton href="/catalog" variant="secondary" icon={<StorefrontIcon />}>
                Catalog
              </LinkButton>
            )}
          </>
        }
      />
      <NeedsAttention
        items={items}
        isAdmin={isAdmin}
        update={update}
        onDismissAccountRow={onDismissAccountRow}
        onUpdateAllOutcome={onUpdateAllOutcome}
      />
      {update.dialog}
      {apps.length > 0 && usage !== undefined && (
        <HomeUsageSection view={view} needsAccess={needsAccess} isAdmin={isAdmin} />
      )}
      {apps.length > 0 ? (
        <YourApps
          apps={apps}
          signals={appSignals(items)}
          now={now}
          below={(app) => {
            const card = cards?.get(app.id);
            return card === undefined ? null : (
              <AppCardUsage card={card} name={installLabel(app)} />
            );
          }}
          action={(app) => {
            const card = cards?.get(app.id);
            if (!isAdmin || card === undefined) return null;
            const paused = usageRows.find(
              (row): row is Extract<UsageAttention, { kind: "paused" }> =>
                row.kind === "paused" && row.installId === app.id,
            );
            return (
              <AppCardUsageAction
                card={card}
                installId={app.id}
                label={installLabel(app)}
                stillPastCap={paused?.stillPastCap ?? null}
              />
            );
          }}
        />
      ) : importedApps.length === 0 ? (
        <Empty
          icon={<PackageIcon size={48} className="text-kumo-inactive" />}
          title="No apps installed yet"
          description="Install an app from the catalog. It runs in this Cloudflare account, and Appflare keeps it updated."
          contents={
            <LinkButton href="/catalog" variant="primary" icon={<StorefrontIcon />}>
              Browse the catalog
            </LinkButton>
          }
        />
      ) : null}
      <ImportedApps apps={importedApps} />
    </>
  );
}
