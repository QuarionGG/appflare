import { Button, Checkbox, Input, Select, Text } from "@cloudflare/kumo";
import {
  ArrowsClockwiseIcon,
  CloudArrowDownIcon,
  MagnifyingGlassIcon,
} from "@phosphor-icons/react";
import { type FormEvent, useState } from "react";
import { BusyButton } from "../components/busy-button";
import { ErrorMessageBanner } from "../components/message-text";
import { PageHeader } from "../components/page-header";
import { Section, SectionBody, SectionEmpty, SectionFormActions } from "../components/section";
import { DISPLAY_NAME_MAX_LENGTH } from "../installs/display-name";
import { ImportInventory, InventoryWarnings } from "./import-inventory";
import { ImportedApps } from "./imported-apps";
import {
  type ImportDiscovery,
  type ImportedApp,
  type ImportPreview,
  type ImportSelection,
  MAX_IMPORTED_WORKERS,
} from "./types";

export interface ImportPageActions {
  discover(): Promise<ImportDiscovery>;
  preview(selection: ImportSelection): Promise<ImportPreview>;
  commit(preview: ImportPreview): Promise<void>;
}

/** Discovery and review are explicit: opening this page only reads saved imports. */
export function ImportPage({
  apps,
  isAdmin,
  accountId,
  actions,
}: {
  apps: readonly ImportedApp[];
  isAdmin: boolean;
  accountId: string | null;
  actions: ImportPageActions;
}) {
  const [discovery, setDiscovery] = useState<ImportDiscovery | null>(null);
  const [selection, setSelection] = useState<ImportSelection>({
    workerNames: [],
    primaryWorker: "",
    displayName: "",
  });
  const [query, setQuery] = useState("");
  const [review, setReview] = useState<ImportPreview | null>(null);
  const [pending, setPending] = useState<"discover" | "preview" | "import" | null>(null);
  const [error, setError] = useState<string | null>(null);

  function changeSelection(next: ImportSelection) {
    setSelection(next);
    setReview(null);
    setError(null);
  }

  function selectWorker(name: string, checked: boolean) {
    const workerNames = checked
      ? [...selection.workerNames, name]
      : selection.workerNames.filter((selected) => selected !== name);
    changeSelection({
      workerNames,
      primaryWorker: workerNames.includes(selection.primaryWorker)
        ? selection.primaryWorker
        : (workerNames[0] ?? ""),
      displayName:
        selection.displayName === "" && checked
          ? name.slice(0, DISPLAY_NAME_MAX_LENGTH)
          : selection.displayName,
    });
  }

  async function discover() {
    setPending("discover");
    setError(null);
    setReview(null);
    try {
      const found = await actions.discover();
      setDiscovery(found);
      setSelection({ workerNames: [], primaryWorker: "", displayName: "" });
      setQuery("");
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not discover Workers.");
    } finally {
      setPending(null);
    }
  }

  async function preview(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (pending !== null || selection.workerNames.length === 0) return;
    setPending("preview");
    setReview(null);
    setError(null);
    try {
      setReview(await actions.preview(selection));
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not preview the app.");
    } finally {
      setPending(null);
    }
  }

  async function commit() {
    if (review === null || pending !== null) return;
    setPending("import");
    setError(null);
    try {
      await actions.commit(review);
    } catch (err) {
      setError(
        err instanceof Error
          ? err.message
          : "Could not import the app. Preview it again and retry.",
      );
      setPending(null);
    }
  }

  const selected = new Set(selection.workerNames);
  const shown =
    discovery?.workers.filter((worker) =>
      worker.name.toLocaleLowerCase().includes(query.trim().toLocaleLowerCase()),
    ) ?? [];
  const disabled = pending !== null;

  return (
    <>
      <PageHeader
        title="Imported apps"
        description="Bring apps already running in this Cloudflare account into your dashboard."
        parents={[{ label: "Home", href: "/" }]}
      />
      <ImportedApps apps={apps} />
      {apps.length === 0 && (
        <Section
          title="Your imports"
          empty={
            <SectionEmpty
              icon={<CloudArrowDownIcon size={40} className="text-kumo-inactive" />}
              title="No imported apps yet"
              description={
                isAdmin
                  ? "Choose the Workers of an existing app below."
                  : "An admin can import apps that already run in this account."
              }
            />
          }
        />
      )}
      {isAdmin && (
        <Section
          id="import-existing-app"
          title="Import an existing app"
          description="Appflare records its Workers and resource references. Your code, data, domains, settings and update process stay as they are."
          action={
            <BusyButton
              pending={pending === "discover"}
              disabled={disabled && pending !== "discover"}
              variant="secondary"
              icon={discovery === null ? <MagnifyingGlassIcon /> : <ArrowsClockwiseIcon />}
              onClick={() => void discover()}
            >
              {discovery === null ? "Discover Workers" : "Discover again"}
            </BusyButton>
          }
        >
          <SectionBody>
            {error !== null && <ErrorMessageBanner message={error} />}
            {discovery === null ? (
              <Text variant="secondary">
                Discover Workers to choose one app. Select every Worker that belongs to it, then
                review its inventory before importing.
              </Text>
            ) : (
              <>
                <InventoryWarnings warnings={discovery.warnings} />
                {discovery.workers.length === 0 ? (
                  <Text variant="secondary">
                    No available Workers found. Workers already installed or imported here, and
                    Appflare itself, are left out.
                  </Text>
                ) : (
                  <form className="grid gap-5" onSubmit={(event) => void preview(event)}>
                    <div className="grid gap-3">
                      <Text as="h3" bold>
                        Choose Workers
                      </Text>
                      <Text variant="secondary" size="sm">
                        Group the frontend, API and other Workers of one app. You can choose up to
                        {MAX_IMPORTED_WORKERS}.
                      </Text>
                      {discovery.workers.length > 8 && (
                        <Input
                          label="Filter Workers"
                          value={query}
                          onChange={(event) => setQuery(event.currentTarget.value)}
                          disabled={disabled}
                        />
                      )}
                      <div className="grid max-h-80 gap-3 overflow-y-auto rounded-md border border-kumo-line p-4">
                        {shown.map((worker) => (
                          <div key={worker.name} className="grid gap-1">
                            <Checkbox
                              label={worker.name}
                              checked={selected.has(worker.name)}
                              disabled={
                                disabled ||
                                (!selected.has(worker.name) &&
                                  selected.size >= MAX_IMPORTED_WORKERS)
                              }
                              onCheckedChange={(checked: boolean) =>
                                selectWorker(worker.name, checked)
                              }
                            />
                            {worker.routes.length > 0 && (
                              <Text
                                as="span"
                                variant="secondary"
                                size="sm"
                                DANGEROUS_className="pl-6 break-all"
                              >
                                {worker.routes.map((route) => route.pattern).join(", ")}
                              </Text>
                            )}
                          </div>
                        ))}
                        {shown.length === 0 && (
                          <Text variant="secondary">No Workers match this filter.</Text>
                        )}
                      </div>
                      <Text as="span" variant="secondary" size="sm" role="status">
                        {selection.workerNames.length} selected
                      </Text>
                    </div>
                    {selection.workerNames.length > 0 && (
                      <div className="grid gap-4 sm:grid-cols-2">
                        <Input
                          label="App name"
                          value={selection.displayName}
                          maxLength={DISPLAY_NAME_MAX_LENGTH}
                          required
                          disabled={disabled}
                          onChange={(event) =>
                            changeSelection({
                              ...selection,
                              displayName: event.currentTarget.value,
                            })
                          }
                        />
                        <Select
                          label="Primary Worker"
                          description="Its address is used for Open."
                          value={selection.primaryWorker}
                          items={selection.workerNames.map((name) => ({
                            value: name,
                            label: name,
                          }))}
                          disabled={disabled}
                          onValueChange={(name) => {
                            if (typeof name === "string")
                              changeSelection({ ...selection, primaryWorker: name });
                          }}
                        />
                      </div>
                    )}
                    <SectionFormActions>
                      <BusyButton
                        type="submit"
                        pending={pending === "preview"}
                        disabled={
                          disabled ||
                          selection.workerNames.length === 0 ||
                          selection.displayName.trim() === ""
                        }
                        variant="secondary"
                        icon={<MagnifyingGlassIcon />}
                      >
                        Preview inventory
                      </BusyButton>
                    </SectionFormActions>
                  </form>
                )}
              </>
            )}
          </SectionBody>
        </Section>
      )}
      {isAdmin && review !== null && (
        <>
          <Section
            id="import-review"
            title={`Review ${review.displayName}`}
            description={`${review.workerNames.length} ${review.workerNames.length === 1 ? "Worker" : "Workers"} · Primary: ${review.primaryWorker}`}
          >
            <SectionBody>
              <Text>
                Import adds this inventory to Appflare. The existing Workers keep running with their
                code, data and domains. Keep using your current process to deploy updates.
              </Text>
              <Text size="sm" variant="secondary">
                Appflare checks the inventory again when you import. If it has changed, preview it
                again before continuing.
              </Text>
              <SectionFormActions>
                <Button variant="secondary" disabled={disabled} onClick={() => setReview(null)}>
                  Cancel review
                </Button>
                <BusyButton
                  pending={pending === "import"}
                  disabled={disabled && pending !== "import"}
                  variant="primary"
                  icon={<CloudArrowDownIcon />}
                  onClick={() => void commit()}
                >
                  Import app
                </BusyButton>
              </SectionFormActions>
            </SectionBody>
          </Section>
          <ImportInventory
            workers={review.workers}
            warnings={review.warnings}
            accountId={accountId}
          />
        </>
      )}
    </>
  );
}
