import { Badge, Grid, LinkButton, Text } from "@cloudflare/kumo";
import { CloudArrowDownIcon } from "@phosphor-icons/react";
import { OpenAppButton } from "../components/open-app-button";
import { Section } from "../components/section";
import type { ImportedApp } from "./types";

/** Imported apps have their own cards, outside managed installs and update actions. */
export function ImportedApps({ apps }: { apps: readonly ImportedApp[] }) {
  if (apps.length === 0) return null;
  return (
    <Section
      id="imported-apps"
      title="Imported apps"
      description="Apps already running in your account. Their existing deployment process keeps managing them."
    >
      <Grid variant="3up" gap="none" className="-mr-px -mb-px">
        {[...apps]
          .sort((a, b) =>
            a.displayName.localeCompare(b.displayName, undefined, { sensitivity: "base" }),
          )
          .map((app) => {
            const address = safeImportAddress(app.address);
            return (
              <div
                key={app.id}
                data-imported-app-card={app.id}
                className="flex h-full min-w-0 flex-col gap-4 border-r border-b border-kumo-hairline px-5 py-4"
              >
                <div className="flex min-w-0 items-center gap-3">
                  <CloudArrowDownIcon size={32} className="shrink-0 text-kumo-subtle" />
                  <div className="grid min-w-0 gap-1">
                    <Text as="span" bold truncate>
                      {app.displayName}
                    </Text>
                    <Text as="span" size="sm" variant="secondary">
                      {app.workerNames.length} {app.workerNames.length === 1 ? "Worker" : "Workers"}
                    </Text>
                  </div>
                  <Badge variant="outline">Imported</Badge>
                </div>
                <div className="mt-auto flex flex-col gap-2 *:w-full *:justify-center sm:flex-row sm:justify-end sm:*:w-auto">
                  {address !== null && (
                    <OpenAppButton
                      href={address}
                      label={app.displayName}
                      size="sm"
                      variant="primary"
                    />
                  )}
                  <LinkButton
                    href={`/imports/${app.id}`}
                    size="sm"
                    variant="secondary"
                    aria-label={`View inventory of ${app.displayName}`}
                  >
                    View inventory
                  </LinkButton>
                </div>
              </div>
            );
          })}
      </Grid>
    </Section>
  );
}

/** Imported URLs are metadata: only ordinary HTTPS addresses become navigation links. */
export function safeImportAddress(address: string | null): string | null {
  if (address === null) return null;
  try {
    const url = new URL(address);
    return url.protocol === "https:" && url.username === "" && url.password === ""
      ? url.href
      : null;
  } catch {
    return null;
  }
}
