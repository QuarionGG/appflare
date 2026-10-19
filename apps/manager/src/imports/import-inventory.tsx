import { Badge, Banner, Link, LinkButton, Table, Text } from "@cloudflare/kumo";
import { ArrowSquareOutIcon } from "@phosphor-icons/react";
import type { ReactNode } from "react";
import { dashboardUrl } from "../cloudflare/dashboard-links";
import { DescriptionItem, DescriptionList } from "../components/description-list";
import { BANNER_ICON } from "../components/message-text";
import { Section, SectionBody } from "../components/section";
import { Timestamp } from "../components/timestamp";
import { safeImportAddress } from "./imported-apps";
import type { ImportedBinding, ImportedWorker } from "./types";

const mono = "break-all font-mono text-[0.9em]";

/** The same safe inventory is reviewed before import and shown on the saved app. */
export function ImportInventory({
  workers,
  warnings,
  accountId,
}: {
  workers: readonly ImportedWorker[];
  warnings: readonly string[];
  accountId: string | null;
}) {
  return (
    <>
      <InventoryWarnings warnings={warnings} />
      {workers.map((worker) => (
        <Section
          key={worker.name}
          title={worker.name}
          badge={worker.missing ? <Badge variant="warning">Worker not found</Badge> : undefined}
          action={
            <LinkButton
              href={dashboardUrl(
                accountId,
                `workers/services/view/${encodeURIComponent(worker.name)}/production`,
              )}
              external
              variant="secondary"
              icon={<ArrowSquareOutIcon />}
              aria-label={`View ${worker.name} in Cloudflare`}
            >
              Cloudflare dashboard
            </LinkButton>
          }
        >
          <SectionBody>
            <InventoryWarnings warnings={worker.warnings} />
            <DescriptionList>
              <DescriptionItem label="Last modified">
                <Timestamp iso={worker.modifiedAt} fallback="Not available" />
              </DescriptionItem>
              <DescriptionItem label="Created">
                <Timestamp iso={worker.createdAt} fallback="Not available" />
              </DescriptionItem>
              <DescriptionItem label="Handlers">
                {worker.handlers.length === 0 ? "None reported" : worker.handlers.join(", ")}
              </DescriptionItem>
              <DescriptionItem label="workers.dev address">
                {worker.workersDevEnabled === null
                  ? "Not available"
                  : worker.workersDevEnabled
                    ? "Enabled"
                    : "Disabled"}
              </DescriptionItem>
            </DescriptionList>
            <InventoryPart title="Domains">
              {worker.domains.length === 0 ? (
                <NoItems>None reported</NoItems>
              ) : (
                <ul className="grid gap-1">
                  {worker.domains.map((domain) => {
                    const address = domainLink(domain.hostname);
                    return (
                      <li key={domain.id} className="flex flex-wrap items-baseline gap-x-2">
                        {address === null ? (
                          <span className={mono}>{domain.hostname}</span>
                        ) : (
                          <Link href={address} target="_blank" rel="noopener noreferrer">
                            {domain.hostname}
                            <Link.ExternalIcon />
                          </Link>
                        )}
                        <Text as="span" size="sm" variant="secondary">
                          {domain.zoneName}
                        </Text>
                      </li>
                    );
                  })}
                </ul>
              )}
            </InventoryPart>
            <InventoryPart title="Routes">
              {worker.routes.length === 0 ? (
                <NoItems>None reported</NoItems>
              ) : (
                <ul className="grid gap-1">
                  {worker.routes.map((route) => (
                    <li key={route.id} className={mono}>
                      {route.pattern}
                    </li>
                  ))}
                </ul>
              )}
            </InventoryPart>
            <InventoryPart title="Bindings">
              <Text as="p" size="sm" variant="secondary">
                Names, types and resource references only. Variable and secret values are never read
                into this inventory.
              </Text>
              {worker.bindings.length === 0 ? (
                <NoItems>None reported</NoItems>
              ) : (
                <div className="min-w-0 overflow-x-auto">
                  <Table>
                    <Table.Header>
                      <Table.Row>
                        <Table.Head>Binding</Table.Head>
                        <Table.Head>Type</Table.Head>
                        <Table.Head>Resource reference</Table.Head>
                      </Table.Row>
                    </Table.Header>
                    <Table.Body>
                      {worker.bindings.map((binding) => (
                        <Table.Row key={`${binding.name}:${binding.type}`}>
                          <Table.Cell>
                            <span className={mono}>{binding.name}</span>
                          </Table.Cell>
                          <Table.Cell>{binding.type}</Table.Cell>
                          <Table.Cell>
                            <BindingReference binding={binding} />
                          </Table.Cell>
                        </Table.Row>
                      ))}
                    </Table.Body>
                  </Table>
                </div>
              )}
            </InventoryPart>
            <InventoryPart title="Schedules">
              {worker.schedules.length === 0 ? (
                <NoItems>None reported</NoItems>
              ) : (
                <ul className="grid gap-1">
                  {worker.schedules.map((schedule) => (
                    <li key={schedule.cron} className={mono}>
                      {schedule.cron}
                    </li>
                  ))}
                </ul>
              )}
            </InventoryPart>
            <InventoryPart title="Deployments">
              {worker.deployments.length === 0 ? (
                <NoItems>None reported</NoItems>
              ) : (
                <ul className="grid gap-3">
                  {worker.deployments.map((deployment) => (
                    <li key={deployment.id} className="grid min-w-0 gap-1">
                      <span className={mono}>{deployment.id}</span>
                      <Text as="span" size="sm" variant="secondary">
                        <Timestamp iso={deployment.createdAt} fallback="Date not available" />
                        {deployment.source !== null && <> · {deployment.source}</>}
                      </Text>
                      {deployment.versions.map((version) => (
                        <Text key={version.versionId} as="span" size="sm">
                          <span className={mono}>{version.versionId}</span> · {version.percentage}%
                        </Text>
                      ))}
                    </li>
                  ))}
                </ul>
              )}
            </InventoryPart>
          </SectionBody>
        </Section>
      ))}
    </>
  );
}

export function InventoryWarnings({ warnings }: { warnings: readonly string[] }) {
  if (warnings.length === 0) return null;
  return (
    <Banner
      variant="alert"
      icon={BANNER_ICON.alert}
      title="Some inventory could not be read"
      description={
        <ul className="grid list-disc gap-1 pl-5">
          {[...new Set(warnings)].map((warning) => (
            <li key={warning}>{warning}</li>
          ))}
        </ul>
      }
    />
  );
}

function InventoryPart({ title, children }: { title: string; children: ReactNode }) {
  return (
    <div className="grid min-w-0 gap-2 border-t border-kumo-hairline pt-4">
      <Text as="h3" bold>
        {title}
      </Text>
      {children}
    </div>
  );
}

function NoItems({ children }: { children: ReactNode }) {
  return (
    <Text as="p" variant="secondary" size="sm">
      {children}
    </Text>
  );
}

function BindingReference({ binding }: { binding: ImportedBinding }) {
  const references = [
    binding.resourceName,
    binding.resourceId,
    binding.scriptName,
    binding.className,
  ].filter((value): value is string => value !== null);
  return references.length === 0 ? (
    <Text as="span" variant="secondary">
      —
    </Text>
  ) : (
    <span className="grid gap-1">
      {[...new Set(references)].map((reference) => (
        <span key={reference} className={mono}>
          {reference}
        </span>
      ))}
    </span>
  );
}

function domainLink(hostname: string): string | null {
  return /^[a-z0-9](?:[a-z0-9.-]*[a-z0-9])?$/i.test(hostname)
    ? safeImportAddress(`https://${hostname}`)
    : null;
}
