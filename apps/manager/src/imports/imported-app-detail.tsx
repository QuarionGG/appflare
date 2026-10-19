import { Badge, Banner, Button, Text } from "@cloudflare/kumo";
import { ArrowsClockwiseIcon, EyeSlashIcon } from "@phosphor-icons/react";
import { useState } from "react";
import { BusyButton } from "../components/busy-button";
import { ConfirmDialog } from "../components/confirm-dialog";
import { DescriptionItem, DescriptionList } from "../components/description-list";
import { BANNER_ICON, ErrorMessageBanner } from "../components/message-text";
import { OpenAppButton } from "../components/open-app-button";
import { PageHeader } from "../components/page-header";
import { Section, SectionBody } from "../components/section";
import { Timestamp } from "../components/timestamp";
import { AdoptImportDialog, type AdoptionActions } from "./adopt-import-dialog";
import { ImportInventory } from "./import-inventory";
import { safeImportAddress } from "./imported-apps";
import type { ImportedApp } from "./types";

/** An imported app stays inventory-only until an admin reviews and adopts it. */
export function ImportedAppDetail({
  app,
  accountId,
  isAdmin,
  onRefresh,
  onForget,
  adoption,
}: {
  app: ImportedApp;
  accountId: string | null;
  isAdmin: boolean;
  onRefresh(): Promise<void>;
  onForget(): Promise<void>;
  adoption?: { actions: AdoptionActions; onAdopted(installId: string): Promise<void> };
}) {
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const address = safeImportAddress(app.address);

  async function refresh() {
    setPending(true);
    setError(null);
    try {
      await onRefresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not refresh the inventory.");
    } finally {
      setPending(false);
    }
  }

  return (
    <>
      <PageHeader
        title={app.displayName}
        description={
          <span className="flex flex-wrap items-center gap-2">
            <Badge variant="outline">Imported</Badge>
            <span>Inventory of an existing app</span>
          </span>
        }
        parents={[
          { label: "Home", href: "/" },
          { label: "Imported apps", href: "/imports" },
        ]}
        actions={
          <>
            {address !== null && (
              <OpenAppButton href={address} label={app.displayName} variant="primary" />
            )}
            {isAdmin && (
              <>
                {adoption !== undefined && (
                  <AdoptImportDialog
                    app={app}
                    actions={adoption.actions}
                    onAdopted={adoption.onAdopted}
                    disabled={pending}
                  />
                )}
                <BusyButton
                  pending={pending}
                  variant="secondary"
                  icon={<ArrowsClockwiseIcon />}
                  onClick={() => void refresh()}
                >
                  Refresh inventory
                </BusyButton>
              </>
            )}
          </>
        }
      />
      {error !== null && <ErrorMessageBanner message={error} />}
      <Banner
        variant="secondary"
        icon={BANNER_ICON.secondary}
        title="Managed by your existing deployment process"
        description="Your Workers, code, data, domains and settings stay in place. Keep deploying updates as you do today. This import records inventory; an admin can review adoption to enable Appflare's app controls."
      />
      {isAdmin && adoption !== undefined && app.workerNames.length !== 1 && (
        <Text size="sm" variant="secondary">
          Adoption currently supports apps with one Worker. This app's inventory remains available.
        </Text>
      )}
      <Section title="Import details">
        <SectionBody>
          <DescriptionList>
            <DescriptionItem label="Primary Worker">
              <span className="break-all font-mono text-[0.9em]">{app.primaryWorker}</span>
            </DescriptionItem>
            <DescriptionItem label="Workers">{app.workerNames.length}</DescriptionItem>
            <DescriptionItem label="Imported">
              <Timestamp iso={app.importedAt} />
            </DescriptionItem>
            <DescriptionItem label="Inventory refreshed">
              <Timestamp iso={app.refreshedAt} />
            </DescriptionItem>
          </DescriptionList>
          <Text size="sm" variant="secondary">
            This is the last recorded inventory. Refresh it after changes made in Cloudflare or your
            deployment tools. A resource reference can be shared with other apps; importing does not
            claim ownership of it.
          </Text>
        </SectionBody>
      </Section>
      <ImportInventory workers={app.workers} warnings={app.warnings} accountId={accountId} />
      {isAdmin && (
        <Section
          title="Forget this import"
          description="Remove the app from Appflare while it keeps running in Cloudflare."
        >
          <SectionBody>
            <div className="flex flex-wrap items-center justify-between gap-4">
              <Text variant="secondary">
                Only Appflare's saved inventory is removed. You can import the same Workers again
                later.
              </Text>
              <ConfirmDialog
                trigger={(props) => (
                  <Button {...props} variant="secondary" icon={<EyeSlashIcon />} disabled={pending}>
                    Forget app
                  </Button>
                )}
                title={`Forget ${app.displayName}`}
                description="Removes only this app's imported record from Appflare. Its Workers, data, domains, settings and deployment history stay in your Cloudflare account and keep running."
                destructive={false}
                actionLabel="Forget app"
                onConfirm={onForget}
              >
                <div className="grid gap-2">
                  <Text bold>Workers kept in Cloudflare</Text>
                  <ul className="grid gap-1">
                    {app.workerNames.map((name) => (
                      <li key={name} className="break-all font-mono text-[0.9em]">
                        {name}
                      </li>
                    ))}
                  </ul>
                </div>
              </ConfirmDialog>
            </div>
          </SectionBody>
        </Section>
      )}
    </>
  );
}
