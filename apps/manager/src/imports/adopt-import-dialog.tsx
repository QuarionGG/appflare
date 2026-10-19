import { parseRepositoryInput } from "@appflare/schema";
import { Banner, Button, Input, LayerDialog, Text } from "@cloudflare/kumo";
import { GearIcon } from "@phosphor-icons/react";
import { type FormEvent, useId, useState } from "react";
import { BusyMark, busyActionProps } from "../components/busy-button";
import { DescriptionItem, DescriptionList } from "../components/description-list";
import { BANNER_ICON, ErrorMessageBanner } from "../components/message-text";
import { DISPLAY_NAME_MAX_LENGTH, displayNameProblem } from "../installs/display-name";
import type { AdoptionPreview } from "./adoption-types";
import type { AdoptionInput } from "./adoptions-input";
import type { ImportedApp } from "./types";

export interface AdoptionActions {
  preview(selection: AdoptionInput): Promise<AdoptionPreview>;
  commit(selection: AdoptionInput & { fingerprint: string }): Promise<{ installId: string }>;
}

/** Adoption records the running Worker as a managed install, after a fresh review. */
export function AdoptImportDialog({
  app,
  actions,
  onAdopted,
  disabled = false,
}: {
  app: ImportedApp;
  actions: AdoptionActions;
  onAdopted(installId: string): Promise<void>;
  disabled?: boolean;
}) {
  const formId = useId();
  const [open, setOpen] = useState(false);
  const [selection, setSelection] = useState<AdoptionInput>(() => initialSelection(app));
  const [review, setReview] = useState<AdoptionPreview | null>(null);
  const [pending, setPending] = useState<"preview" | "adopt" | null>(null);
  const [error, setError] = useState<string | null>(null);
  const supported = app.workerNames.length === 1;
  const displayNameError = requiredNameProblem(selection.displayName);
  const appNameError = requiredNameProblem(selection.appName);
  const parsedRepository =
    selection.repository.trim() === "" ? null : parseRepositoryInput(selection.repository);
  const repositoryError =
    parsedRepository !== null && !parsedRepository.ok ? parsedRepository.error : null;
  const ready =
    supported &&
    displayNameError === null &&
    appNameError === null &&
    parsedRepository?.ok === true &&
    selection.ref.trim() !== "" &&
    pending === null;

  function onOpenChange(next: boolean) {
    if (pending !== null) return;
    setOpen(next);
    if (next) {
      setSelection(initialSelection(app));
      setReview(null);
      setError(null);
    }
  }

  function change(next: AdoptionInput) {
    setSelection(next);
    setReview(null);
    setError(null);
  }

  async function onSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!ready) return;
    setError(null);
    if (review === null) {
      setPending("preview");
      try {
        setReview(
          await actions.preview({
            ...selection,
            displayName: selection.displayName.trim(),
            appName: selection.appName.trim(),
            repository: selection.repository.trim(),
            ref: selection.ref.trim(),
          }),
        );
      } catch (err) {
        setError(err instanceof Error ? err.message : "Could not preview adoption.");
      } finally {
        setPending(null);
      }
      return;
    }
    setPending("adopt");
    try {
      const { installId } = await actions.commit({
        appId: review.appId,
        displayName: review.displayName,
        appName: review.appName,
        repository: review.repository,
        ref: review.ref,
        fingerprint: review.fingerprint,
      });
      await onAdopted(installId);
      setOpen(false);
    } catch (err) {
      setError(
        err instanceof Error ? err.message : "Could not adopt the app. Preview it again and retry.",
      );
      // A failed adoption can mean that the Worker changed after review.
      setReview(null);
    } finally {
      setPending(null);
    }
  }

  return (
    <LayerDialog.Root
      open={open}
      onOpenChange={onOpenChange}
      disablePointerDismissal
      dismissDisabled={pending !== null}
    >
      <LayerDialog.Trigger
        render={(props) => (
          <Button
            {...props}
            variant="secondary"
            icon={<GearIcon />}
            disabled={disabled || !supported}
            title={supported ? undefined : "Adoption currently supports apps with one Worker."}
          >
            Manage in Appflare
          </Button>
        )}
      />
      <LayerDialog.Content size="lg">
        <LayerDialog.Title>Manage {app.displayName} in Appflare</LayerDialog.Title>
        <LayerDialog.Description>
          Adopt the existing Worker as a managed app. Its deployed code, data, domains, routes and
          secrets stay in place. Adoption changes Appflare records only.
        </LayerDialog.Description>
        <LayerDialog.Body>
          <form id={formId} className="grid gap-5" onSubmit={onSubmit}>
            <div className="grid gap-4 sm:grid-cols-2">
              <Input
                label="Name in Appflare"
                value={selection.displayName}
                onChange={(event) =>
                  change({ ...selection, displayName: event.currentTarget.value })
                }
                maxLength={DISPLAY_NAME_MAX_LENGTH}
                required
                autoComplete="off"
                disabled={pending !== null}
                error={displayNameError ?? undefined}
                description="The name shown in your apps."
              />
              <Input
                label="App name"
                value={selection.appName}
                onChange={(event) => change({ ...selection, appName: event.currentTarget.value })}
                maxLength={DISPLAY_NAME_MAX_LENGTH}
                required
                autoComplete="off"
                disabled={pending !== null}
                error={appNameError ?? undefined}
                description="The software this app runs, for example EmDash."
              />
            </div>
            <Input
              label="Repository"
              value={selection.repository}
              onChange={(event) => change({ ...selection, repository: event.currentTarget.value })}
              placeholder="https://github.com/owner/repo"
              required
              autoComplete="off"
              spellCheck={false}
              disabled={pending !== null}
              error={repositoryError ?? undefined}
              description="Your source for future updates. Use the repository that produces this app."
            />
            <Input
              label="Branch, tag or commit"
              value={selection.ref}
              onChange={(event) => change({ ...selection, ref: event.currentTarget.value })}
              required
              autoComplete="off"
              spellCheck={false}
              disabled={pending !== null}
            />
            <Text size="sm" variant="secondary">
              After adoption, Appflare provides the normal app controls. Future updates are built
              from this repository and reviewed before deployment. Catalog code never replaces your
              current deployment automatically.
            </Text>
            {review !== null && (
              <div className="grid gap-4 border-t border-kumo-line pt-4" data-adoption-review>
                <Text as="h3" bold>
                  Review adoption
                </Text>
                <DescriptionList>
                  <DescriptionItem label="Name in Appflare">{review.displayName}</DescriptionItem>
                  <DescriptionItem label="App name">{review.appName}</DescriptionItem>
                  <DescriptionItem label="Worker">
                    <span className="break-all font-mono text-[0.9em]">{review.workerName}</span>
                  </DescriptionItem>
                  <DescriptionItem label="Current version">
                    <span className="break-all font-mono text-[0.9em]">
                      {review.currentVersionId}
                    </span>
                  </DescriptionItem>
                  <DescriptionItem label="Resources retained">
                    {review.resourceCount}
                  </DescriptionItem>
                  <DescriptionItem label="Repository">{review.repository}</DescriptionItem>
                  <DescriptionItem label="Branch, tag or commit">{review.ref}</DescriptionItem>
                  <DescriptionItem label="Address">
                    {review.address ?? "None reported"}
                  </DescriptionItem>
                </DescriptionList>
                <div className="grid gap-2">
                  <Text bold>Resources kept in place</Text>
                  <ul className="grid gap-2">
                    {review.resources.map((resource) => (
                      <li
                        key={`${resource.kind}:${resource.binding ?? ""}:${resource.name}`}
                        className="flex flex-wrap items-baseline gap-x-2"
                      >
                        <span className="break-all font-mono text-[0.9em]">{resource.name}</span>
                        <Text as="span" size="sm" variant="secondary">
                          {resource.kind}
                          {resource.binding === null ? "" : ` · ${resource.binding}`}
                        </Text>
                      </li>
                    ))}
                  </ul>
                </div>
                {review.warnings.length > 0 && (
                  <Banner
                    variant="alert"
                    icon={BANNER_ICON.alert}
                    title="Review before adopting"
                    description={
                      <ul className="grid list-disc gap-1 pl-5">
                        {review.warnings.map((warning) => (
                          <li key={warning}>{warning}</li>
                        ))}
                      </ul>
                    }
                  />
                )}
                <Text size="sm" variant="secondary">
                  Appflare checks the Worker again when you adopt. No build or deployment starts
                  during adoption. Later, uninstall removes the Worker and its custom domains and
                  lets you choose which databases, KV namespaces and buckets to keep.
                </Text>
                <div>
                  <Button
                    type="button"
                    variant="secondary"
                    disabled={pending !== null}
                    onClick={() => {
                      setReview(null);
                      setError(null);
                    }}
                  >
                    Preview again
                  </Button>
                </div>
              </div>
            )}
            {error !== null && <ErrorMessageBanner message={error} />}
          </form>
        </LayerDialog.Body>
        <LayerDialog.Actions dismissLabel="Cancel">
          <LayerDialog.Actions.Primary
            type="submit"
            form={formId}
            {...busyActionProps(pending !== null, !ready)}
          >
            <BusyMark pending={pending !== null} />
            {review === null ? "Preview adoption" : "Adopt app"}
          </LayerDialog.Actions.Primary>
        </LayerDialog.Actions>
      </LayerDialog.Content>
    </LayerDialog.Root>
  );
}

function initialSelection(app: ImportedApp): AdoptionInput {
  return {
    appId: app.id,
    displayName: app.displayName,
    appName: /^emdash$/i.test(app.displayName) ? "EmDash" : app.displayName,
    repository: "",
    ref: "main",
  };
}

function requiredNameProblem(value: string): string | null {
  return value.trim() === "" ? "The name cannot be empty." : displayNameProblem(value);
}
