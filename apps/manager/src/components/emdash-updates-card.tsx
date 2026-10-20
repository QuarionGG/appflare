import { Banner, Button, LayerDialog, Link, LinkButton, Text } from "@cloudflare/kumo";
import { ArrowCircleUpIcon, MagnifyingGlassIcon } from "@phosphor-icons/react";
import { type FormEvent, useEffect, useId, useState } from "react";
import type { EmDashUpgradePlan, EmDashUpgradeView } from "../installs/emdash-upgrades";
import {
  checkEmdashUpgrade,
  getLatestEmdashUpgrade,
  mergeAndBuildEmdashUpgrade,
  prepareEmdashUpgrade,
} from "../installs/emdash-upgrades.functions";
import type { InstallDetail } from "../installs/installs.functions";
import { BusyButton, BusyMark, busyActionProps } from "./busy-button";
import { DescriptionItem, DescriptionList } from "./description-list";
import { useJobStarted } from "./job-started";
import { BANNER_ICON, ErrorMessageBanner } from "./message-text";
import { Section, SectionBody, SectionFormActions } from "./section";
import { SourceBuildCostConfirmation } from "./source-build-fields";

const mono = "font-mono text-[0.9em]";

/** The reviewed PR build cannot deploy even after that PR has been merged. */
export function canDeployEmDashUpgradeBuild(
  buildId: string,
  upgrade: EmDashUpgradeView | null,
): boolean {
  return upgrade === null || upgrade.mergedBuildId === buildId;
}

/** Dependency updates are prepared on a branch, built and reviewed before the live app changes. */
export function EmDashUpdatesCard({
  install,
  isAdmin,
}: {
  install: InstallDetail;
  isAdmin: boolean;
}) {
  const [plan, setPlan] = useState<EmDashUpgradePlan | null>(null);
  const [checking, setChecking] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [latest, setLatest] = useState<EmDashUpgradeView | null>(null);
  const [loadingLatest, setLoadingLatest] = useState(true);
  const eligible = isAdmin && install.origin === "repository" && install.source !== null;
  useEffect(() => {
    if (!eligible) return;
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    async function load() {
      try {
        const upgrade = await getLatestEmdashUpgrade({ data: { installId: install.id } });
        if (cancelled) return;
        setLatest(upgrade);
        if (upgrade !== null && ["preparing", "pr_open", "building"].includes(upgrade.status)) {
          timer = setTimeout(() => void load(), 5_000);
        }
      } catch (err) {
        if (!cancelled)
          setError(
            err instanceof Error ? err.message : "Could not load the existing EmDash upgrade.",
          );
      } finally {
        if (!cancelled) setLoadingLatest(false);
      }
    }
    void load();
    return () => {
      cancelled = true;
      if (timer !== undefined) clearTimeout(timer);
    };
  }, [eligible, install.id]);
  if (!eligible) return null;
  const canAct = install.status === "installed" && install.activeJobId === null;
  const hasOpenUpgrade =
    latest !== null && ["preparing", "pr_open", "building", "ready"].includes(latest.status);
  const deployed =
    latest !== null && latest.mergeSha !== null && latest.mergeSha === install.pinSha;

  async function check() {
    if (checking) return;
    setChecking(true);
    setError(null);
    try {
      setPlan(await checkEmdashUpgrade({ data: { installId: install.id } }));
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not check EmDash updates.");
    } finally {
      setChecking(false);
    }
  }

  return (
    <Section id="emdash-updates" title="EmDash updates">
      <SectionBody>
        <Text>
          Update EmDash in your own repository, keeping its theme, plugin declarations and settings.
          Appflare prepares a dependency update on a separate branch and builds it for review.
        </Text>
        {latest !== null && !deployed && <UpgradeContinuation upgrade={latest} canBuild={canAct} />}
        {plan !== null &&
          (plan.supported ? (
            <>
              <DescriptionList>
                <DescriptionItem label="Installed EmDash">
                  <span className={mono}>{plan.installedVersion ?? "Unknown"}</span>
                </DescriptionItem>
                <DescriptionItem label="Repository EmDash">
                  <span className={mono}>{plan.sourceVersion ?? "Unknown"}</span>
                </DescriptionItem>
                <DescriptionItem label="Latest stable EmDash">
                  <span className={mono}>{plan.targetVersion ?? "Unknown"}</span>
                </DescriptionItem>
                {plan.baseSha !== null && (
                  <DescriptionItem label="Repository commit">
                    <span className={mono}>{plan.baseSha.slice(0, 12)}</span>
                  </DescriptionItem>
                )}
              </DescriptionList>
              <Banner
                variant="secondary"
                icon={BANNER_ICON.secondary}
                title={
                  plan.upToDate
                    ? "The repository is up to date"
                    : "Review compatibility before updating"
                }
                description={
                  plan.upToDate
                    ? "Its dependencies already use the latest stable EmDash release. Rebuild the repository to deploy changes that are not installed yet."
                    : "The upgrade changes EmDash and its Cloudflare adapter together. Custom plugin versions stay in place. A successful build does not verify every theme or plugin at runtime; review the release's migration notes and check the app before using it."
                }
              />
              {plan.plugins.length > 0 && (
                <div className="grid gap-2">
                  <Text bold>Plugin dependencies kept</Text>
                  <ul className="grid gap-1">
                    {plan.plugins.map((plugin) => (
                      <li key={plugin.name} className="break-words">
                        <span className={mono}>{plugin.name}</span>{" "}
                        <Text as="span" variant="secondary">
                          {plugin.version}
                        </Text>
                      </li>
                    ))}
                  </ul>
                </div>
              )}
              {!plan.writeTokenAvailable && !plan.upToDate && (
                <Banner
                  variant="alert"
                  icon={BANNER_ICON.alert}
                  title="Repository update access is needed"
                  description={
                    <span>
                      Add a dedicated token for this repository under{" "}
                      <Link href="/settings/building#github-access">GitHub access</Link>, with
                      Repository updates selected. Build-only tokens cannot change a repository.
                    </span>
                  }
                />
              )}
              {plan.reason !== null && <Text variant="secondary">{plan.reason}</Text>}
            </>
          ) : (
            <Banner
              variant="secondary"
              icon={BANNER_ICON.secondary}
              title="This repository cannot be upgraded here"
              description={plan.reason ?? "Appflare could not find a supported EmDash project."}
            />
          ))}
        {error !== null && <ErrorMessageBanner message={error} newTab />}
        <SectionFormActions>
          <BusyButton
            pending={checking}
            disabled={!canAct}
            variant="secondary"
            icon={<MagnifyingGlassIcon />}
            onClick={() => void check()}
          >
            Check EmDash updates
          </BusyButton>
          {plan?.supported &&
            !plan.upToDate &&
            plan.targetVersion !== null &&
            plan.baseSha !== null && (
              <UpgradeBuildDialog
                title={`Prepare EmDash ${plan.targetVersion}`}
                label="Prepare upgrade"
                submitLabel="Prepare and build upgrade"
                description="Creates an upgrade pull request containing dependency and lockfile changes, then builds that exact revision. Your theme and plugin source files stay in place. Nothing is deployed until you review the build and choose Update."
                disabled={
                  !canAct ||
                  checking ||
                  !plan.writeTokenAvailable ||
                  loadingLatest ||
                  hasOpenUpgrade
                }
                what={`${install.label}'s EmDash upgrade`}
                buildNote="Preparation verifies a build, then builds the pull request revision for review. These are two sandbox builds; the estimate below is for each build. Merging later needs another build."
                start={async (costConfirmed) =>
                  prepareEmdashUpgrade({
                    data: {
                      installId: install.id,
                      targetVersion: plan.targetVersion as string,
                      expectedBaseSha: plan.baseSha as string,
                      costConfirmed,
                    },
                  })
                }
              />
            )}
        </SectionFormActions>
      </SectionBody>
    </Section>
  );
}

function UpgradeContinuation({
  upgrade,
  canBuild,
}: {
  upgrade: EmDashUpgradeView;
  canBuild: boolean;
}) {
  const reviewId = upgrade.mergedBuildId ?? upgrade.buildId;
  return (
    <>
      <Banner
        variant={upgrade.status === "failed" ? "alert" : "secondary"}
        icon={upgrade.status === "failed" ? BANNER_ICON.alert : BANNER_ICON.secondary}
        title={
          upgrade.status === "failed"
            ? "The last EmDash upgrade did not finish"
            : `EmDash ${upgrade.targetVersion} upgrade in progress`
        }
        description={
          upgrade.status === "failed"
            ? (upgrade.error ?? "Open the job for details.")
            : reviewId === null
              ? "Preparation is running. The live app is unchanged."
              : "Continue the existing upgrade to review its source changes and build before deployment."
        }
        action={
          <LinkButton
            href={
              reviewId === null
                ? `/jobs/${upgrade.preparationJobId}`
                : `/catalog/source/${reviewId}`
            }
            variant="secondary"
          >
            {reviewId === null ? "Follow preparation" : "Review upgrade"}
          </LinkButton>
        }
      />
      {upgrade.mergeSha !== null && (
        <SectionFormActions>
          <UpgradeBuildDialog
            title="Build the merged EmDash upgrade"
            label="Build merged upgrade again"
            submitLabel="Build merged upgrade"
            description="Builds the recorded merged commit when its previous build failed or was discarded. If that build is still available, opens it. Nothing is deployed until you review a successful build and choose Update."
            disabled={!canBuild}
            what="the merged EmDash upgrade"
            start={async (costConfirmed) =>
              mergeAndBuildEmdashUpgrade({ data: { upgradeId: upgrade.id, costConfirmed } })
            }
          />
        </SectionFormActions>
      )}
    </>
  );
}

function UpgradeBuildDialog({
  title,
  label,
  submitLabel,
  description,
  disabled,
  what,
  buildNote,
  start,
}: {
  title: string;
  label: string;
  submitLabel: string;
  description: string;
  disabled: boolean;
  what: string;
  buildNote?: string;
  start(costConfirmed: boolean): Promise<{ jobId: string }>;
}) {
  const jobStarted = useJobStarted();
  const formId = useId();
  const [open, setOpen] = useState(false);
  const [costConfirmed, setCostConfirmed] = useState(false);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function onSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!costConfirmed || pending || disabled) return;
    setPending(true);
    setError(null);
    try {
      const { jobId } = await start(costConfirmed);
      await jobStarted(jobId, "EmDash upgrade started");
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not start the EmDash upgrade.");
      setPending(false);
    }
  }

  return (
    <LayerDialog.Root
      open={open}
      onOpenChange={(next) => {
        setOpen(next);
        if (next) {
          setCostConfirmed(false);
          setError(null);
        }
      }}
      disablePointerDismissal
      dismissDisabled={pending}
    >
      <LayerDialog.Trigger
        render={(props) => (
          <Button {...props} variant="secondary" icon={<ArrowCircleUpIcon />} disabled={disabled}>
            {label}
          </Button>
        )}
      />
      <LayerDialog.Content size="lg">
        <LayerDialog.Title>{title}</LayerDialog.Title>
        <LayerDialog.Description>{description}</LayerDialog.Description>
        <LayerDialog.Body>
          <form id={formId} className="grid gap-5" onSubmit={onSubmit}>
            {buildNote !== undefined && <Text variant="secondary">{buildNote}</Text>}
            <SourceBuildCostConfirmation
              checked={costConfirmed}
              onChange={setCostConfirmed}
              disabled={pending}
              what={what}
            />
            {error !== null && <ErrorMessageBanner message={error} newTab />}
          </form>
        </LayerDialog.Body>
        <LayerDialog.Actions dismissLabel="Cancel">
          <LayerDialog.Actions.Primary
            type="submit"
            form={formId}
            {...busyActionProps(pending, !costConfirmed || disabled)}
          >
            <BusyMark pending={pending} />
            {submitLabel}
          </LayerDialog.Actions.Primary>
        </LayerDialog.Actions>
      </LayerDialog.Content>
    </LayerDialog.Root>
  );
}

/** A pull-request build is reviewed here but must be merged and rebuilt before deployment. */
export function EmDashUpgradeReview({
  upgrade,
  canMerge,
  buildId,
}: {
  upgrade: EmDashUpgradeView;
  canMerge: boolean;
  buildId: string;
}) {
  const prBuild = upgrade.buildId === buildId;
  const report = upgrade.report;
  const incompatible = report?.plugins.some((plugin) => plugin.compatible === false) ?? false;
  return (
    <Section title="EmDash upgrade">
      <SectionBody>
        <DescriptionList>
          <DescriptionItem label="Target EmDash">
            <span className={mono}>{upgrade.targetVersion}</span>
          </DescriptionItem>
          <DescriptionItem label="Upgrade pull request">
            {upgrade.prUrl === null ? (
              "Not created yet"
            ) : (
              <Link href={upgrade.prUrl} target="_blank" rel="noopener noreferrer">
                Review changes on GitHub
                <Link.ExternalIcon />
              </Link>
            )}
          </DescriptionItem>
        </DescriptionList>
        <Text>
          Review the dependency and lockfile changes in the pull request, together with the build
          results. Your theme and custom plugin source files are not replaced by this upgrade.
        </Text>
        <DescriptionList>
          <DescriptionItem label="Files changed">
            <span className={mono}>package.json</span> and{" "}
            <span className={mono}>pnpm-lock.yaml</span>
          </DescriptionItem>
          {report !== null && (
            <DescriptionItem label="Added database migrations">
              {report.addedMigrations.length === 0
                ? "None detected"
                : report.addedMigrations.join(", ")}
            </DescriptionItem>
          )}
        </DescriptionList>
        {report !== null && report.plugins.length > 0 && (
          <div className="grid gap-2">
            <Text bold>Plugin compatibility declarations</Text>
            <ul className="grid gap-1">
              {report.plugins.map((plugin) => (
                <li key={plugin.name} className="break-words">
                  <span className={mono}>{plugin.name}</span> {plugin.version}:{" "}
                  {plugin.compatible === true
                    ? "declared compatible"
                    : plugin.compatible === false
                      ? "declared incompatible"
                      : "no compatibility declaration"}
                  {plugin.range === null ? "" : ` (${plugin.range})`}
                </li>
              ))}
            </ul>
          </div>
        )}
        <Banner
          variant="alert"
          icon={BANNER_ICON.alert}
          title="Check migrations and plugin compatibility"
          description="A successful build does not prove runtime compatibility. Review the release's migration notes. Rolling back the Worker code does not undo database migrations. Restoring a database snapshot can discard content written after that snapshot."
        />
        {prBuild && upgrade.mergeSha !== null && upgrade.mergedBuildId !== null && (
          <div className="flex justify-end">
            <LinkButton href={`/catalog/source/${upgrade.mergedBuildId}`} variant="primary">
              Review merged build
            </LinkButton>
          </div>
        )}
        {prBuild && (upgrade.mergeSha === null || upgrade.mergedBuildId === null) && (
          <>
            <Text variant="secondary">
              This build is from the upgrade pull request. The merged commit needs its own build
              before reviewing the production update. The existing Worker, data and domains stay in
              use.
            </Text>
            <SectionFormActions>
              <UpgradeBuildDialog
                title="Merge and build the EmDash upgrade"
                label={upgrade.mergeSha === null ? "Merge and build" : "Build merged commit"}
                submitLabel="Merge and build"
                description="Merges this reviewed upgrade pull request into its original branch and builds the merged commit for a final review. Nothing is deployed yet."
                disabled={!canMerge || upgrade.prUrl === null || incompatible}
                what="the merged EmDash upgrade"
                start={async (costConfirmed) =>
                  mergeAndBuildEmdashUpgrade({ data: { upgradeId: upgrade.id, costConfirmed } })
                }
              />
            </SectionFormActions>
          </>
        )}
      </SectionBody>
    </Section>
  );
}
