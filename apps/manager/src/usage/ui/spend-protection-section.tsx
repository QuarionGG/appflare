import { Banner, InputGroup, Link, Select, Switch, Text } from "@cloudflare/kumo";
import { useRouter } from "@tanstack/react-router";
import { Fragment, type ReactNode, useEffect, useId, useRef, useState } from "react";
import { reconnectDialogHref } from "../../cloudflare/reconnect-outcome";
import { DocsLink } from "../../components/docs-link";
import { BANNER_ICON, bannerRole } from "../../components/message-text";
import { Section, SectionRow, SectionRows } from "../../components/section";
import { settingsSection } from "../../components/settings-links";
import { PAID_PLAN_MONTHLY_USD } from "../math";
import { budgetExemptApps, followingApps, ownTriggerApps, type SpendApp } from "../overview";
import { checkBudgetAmount, dollarsText, type SetSpendDefaultsInput } from "../spend-defaults";
import type { SpendProtectionData } from "../spend-defaults.functions";
import { setSpendDefaults } from "../spend-defaults.functions";
import type { SpendDefaults } from "../store/spend-settings";
import { appSpendHref, usd } from "./format";
import { ProgressBar } from "./progress-bar";
import { AmountError, CapAcrossApps, LoopAcrossApps, TriggerRows } from "./triggers";
import { UNUSUAL_FACTOR_ITEMS, unusualFactorOf } from "./unusual-factors";

/**
 * Settings → Your account → Spend protection: what every app follows unless
 * its Usage tab sets its own, like "Automatically update apps" for updates.
 * Auto-pause and its triggers, a budget for the month's bill (Paid), and how
 * far above normal an hour must be to alert. Each control saves on its own;
 * members see it all, unchangeable. Live numbers show which apps the
 * settings would act on right now.
 */

export const SPEND_PROTECTION_COPY = {
  description:
    "What every app in this account follows. An app's Usage tab can change it for that app.",
  autoPauseOn:
    "On: Appflare pauses an app when one of the triggers below trips, then tells you. You resume it.",
  autoPauseOff:
    "Off: Appflare alerts you and apps keep running. Each app can still turn it on for itself.",
  triggers: "Used by every app with auto-pause on, unless the app sets its own.",
  budget:
    "A last line of defence for the whole bill. When this month's bill is on pace to pass it, Appflare pauses the apps spending the most until it isn't, even apps with auto-pause off.",
  budgetFree:
    "Workers Free can't bill you for Workers, so there's no budget or dollar cap. R2 still bills past its free amount.",
  unusual:
    "Alert when an app's hour reaches this much more than its usual hour. Each app can change it.",
  readFailed: "Spend protection could not be read just now. Reload the page to try again.",
  noUsage:
    "Appflare can't read usage until Cloudflare is reconnected, so these settings have nothing to act on yet.",
  membersOnly: "Only admins can change these.",
  saveFailed: "Could not save the setting.",
} as const;

/** "A, B and C" as links to each app's spend protection settings. */
function AppLinks({ apps }: { apps: readonly SpendApp[] }) {
  return (
    <>
      {apps.map((app, i) => (
        <Fragment key={app.installId}>
          {i > 0 && ", "}
          <Link href={appSpendHref(app.installId)}>{app.label}</Link>
        </Fragment>
      ))}
    </>
  );
}

type DefaultKey = keyof SpendDefaults;

/**
 * Saves the defaults one change at a time, in the order they were made (a
 * save waits for the one before it), showing each change at once. When a
 * save fails, its settings go back to what the server last confirmed,
 * unless a later change of the same setting is waiting: that one decides.
 */
function useSpendDefaults(initial: SpendDefaults) {
  const router = useRouter();
  const [defaults, setDefaults] = useState(initial);
  const [error, setError] = useState<string | null>(null);
  /** What the server last said the defaults are. */
  const confirmed = useRef(initial);
  const queue = useRef<Promise<void>>(Promise.resolve());
  /** The newest change of each setting, by its number. */
  const newest = useRef<Partial<Record<DefaultKey, number>>>({});
  const changes = useRef(0);
  const waiting = useRef(0);
  useEffect(() => {
    confirmed.current = initial;
    if (waiting.current === 0) setDefaults(initial);
  }, [initial]);

  /** `shown` with the settings this change is still the newest of taken from `source`. */
  function settle(shown: SpendDefaults, source: SpendDefaults, keys: DefaultKey[], id: number) {
    const out = { ...shown };
    for (const key of keys) {
      if (newest.current[key] === id) Object.assign(out, { [key]: source[key] });
    }
    return out;
  }

  function save(patch: SetSpendDefaultsInput): Promise<void> {
    const id = ++changes.current;
    const keys = Object.keys(patch) as DefaultKey[];
    for (const key of keys) newest.current[key] = id;
    waiting.current++;
    setDefaults((d) => ({ ...d, ...patch }));
    setError(null);
    const run = async () => {
      try {
        const saved = await setSpendDefaults({ data: patch });
        confirmed.current = saved;
        setDefaults((d) => settle(d, saved, keys, id));
      } catch (err) {
        setDefaults((d) => settle(d, confirmed.current, keys, id));
        setError(err instanceof Error ? err.message : SPEND_PROTECTION_COPY.saveFailed);
      }
      waiting.current--;
      // Reloading the page's data while another change waits would show it undone.
      if (waiting.current === 0) await router.invalidate();
    };
    const next = queue.current.then(run);
    queue.current = next;
    return next;
  }

  return { defaults, error, save };
}

export function SpendProtectionSection({
  data,
  isAdmin,
}: {
  /** Null when it could not be read. */
  data: SpendProtectionData | null;
  isAdmin: boolean;
}) {
  if (data === null) {
    return (
      <Section
        {...settingsSection("account", "spend-protection")}
        titleAction={<DocsLink topic="spendProtectionAccount" />}
        description={SPEND_PROTECTION_COPY.description}
        error={SPEND_PROTECTION_COPY.readFailed}
      />
    );
  }
  return <SpendProtectionSettings data={data} isAdmin={isAdmin} />;
}

function SpendProtectionSettings({
  data,
  isAdmin,
}: {
  data: SpendProtectionData;
  isAdmin: boolean;
}) {
  const { overview } = data;
  const { defaults, error, save } = useSpendDefaults(data.defaults);
  const paid = overview.plan === "paid";
  // Without the usage permissions every number is empty; the settings still apply later.
  const live = overview.missingScopes.length === 0;
  const following = followingApps(overview.apps);
  const own = ownTriggerApps(overview.apps);
  const change = isAdmin ? (patch: SetSpendDefaultsInput) => void save(patch) : undefined;

  return (
    <Section
      {...settingsSection("account", "spend-protection")}
      titleAction={<DocsLink topic="spendProtectionAccount" />}
      description={SPEND_PROTECTION_COPY.description}
      error={error}
    >
      {!live && (
        <div className="px-5 pt-4">
          <Banner
            variant="alert"
            icon={BANNER_ICON.alert}
            role={bannerRole("alert")}
            description={
              <>
                {SPEND_PROTECTION_COPY.noUsage}{" "}
                {isAdmin && <Link href={reconnectDialogHref()}>Reconnect Cloudflare</Link>}
              </>
            }
          />
        </div>
      )}
      <SectionRows>
        <SectionRow
          title="Pause apps automatically"
          description={
            defaults.autoPause
              ? SPEND_PROTECTION_COPY.autoPauseOn
              : SPEND_PROTECTION_COPY.autoPauseOff
          }
          action={
            <Switch
              aria-label="Pause apps automatically"
              checked={defaults.autoPause}
              disabled={!isAdmin}
              onCheckedChange={(on: boolean) => change?.({ autoPause: on })}
            />
          }
        />
        <SectionRow title="What pauses an app" description={SPEND_PROTECTION_COPY.triggers}>
          <div className="rounded-lg px-4 py-3 ring-1 ring-kumo-hairline">
            <TriggerRows
              plan={overview.plan}
              loop={defaults.loop}
              cap={defaults.cap}
              onLoop={change && ((loop) => change({ loop }))}
              onCap={
                change &&
                ((cap) => {
                  // The account's cap always has an amount; the rows keep it until one is typed.
                  if (cap.amount !== null) change({ cap: { ...cap, amount: cap.amount } });
                })
              }
              loopStatus={
                live ? (level) => <LoopAcrossApps apps={following} level={level} /> : undefined
              }
              capStatus={
                live
                  ? (amount, period) => (
                      <CapAcrossApps
                        apps={following}
                        amount={amount}
                        period={period}
                        now={overview.now}
                      />
                    )
                  : undefined
              }
            />
          </div>
          {own.length > 0 && (
            <Text variant="secondary">
              Set their own: <AppLinks apps={own} />.
            </Text>
          )}
        </SectionRow>
        {paid ? (
          <BudgetRow
            data={data}
            budget={defaults.budget}
            live={live}
            onChange={change && ((budget) => change({ budget }))}
          />
        ) : (
          <SectionRow title="Monthly budget" description={SPEND_PROTECTION_COPY.budgetFree}>
            {live && overview.bill.projected > 0 && (
              <Text variant="secondary">
                R2 this month: {usd(overview.bill.now)} so far, on pace for{" "}
                {usd(overview.bill.projected)}.
              </Text>
            )}
          </SectionRow>
        )}
        <SectionRow
          title="Unusual usage alerts"
          description={SPEND_PROTECTION_COPY.unusual}
          action={
            <Select
              aria-label="Default unusual usage sensitivity"
              className="w-48"
              disabled={!isAdmin}
              value={String(defaults.unusualFactor)}
              onValueChange={(value) => {
                const factor = unusualFactorOf(value);
                if (factor !== null) change?.({ unusualFactor: factor });
              }}
              items={UNUSUAL_FACTOR_ITEMS}
            />
          }
        />
        {!isAdmin && (
          <div className="px-5 py-4">
            <Text variant="secondary">{SPEND_PROTECTION_COPY.membersOnly}</Text>
          </div>
        )}
      </SectionRows>
    </Section>
  );
}

/** The monthly budget (Paid): the switch, the amount, and where this month's bill stands. */
function BudgetRow({
  data,
  budget,
  live,
  onChange,
}: {
  data: SpendProtectionData;
  budget: SpendDefaults["budget"];
  live: boolean;
  onChange?: (next: SpendDefaults["budget"]) => void;
}) {
  const { overview } = data;
  const [draft, setDraft] = useState(dollarsText(budget.amount));
  const [draftError, setDraftError] = useState<string | null>(null);
  const errorId = useId();
  useEffect(() => {
    setDraft(dollarsText(budget.amount));
    setDraftError(null);
  }, [budget.amount]);
  const typed = checkBudgetAmount(draft);
  const amount = "amount" in typed ? typed.amount : budget.amount;
  const exempt = budgetExemptApps(overview.apps);
  const pick = overview.apps.find((a) => a.installId === overview.budgetPick) ?? null;
  const { bill } = overview;
  const overBudget = bill.projected >= amount;

  function commit() {
    if (onChange === undefined) return;
    const checked = checkBudgetAmount(draft);
    if ("error" in checked) {
      setDraftError(checked.error);
      return;
    }
    setDraftError(null);
    if (checked.amount !== budget.amount) onChange({ ...budget, amount: checked.amount });
  }

  let verdict: ReactNode = "Under the budget.";
  if (overBudget) {
    verdict =
      pick === null
        ? "Over the budget, but no app Appflare may pause adds to it."
        : `Over the budget, so Appflare would pause ${pick.label} first.`;
  }

  return (
    <SectionRow
      title="Monthly budget"
      description={SPEND_PROTECTION_COPY.budget}
      action={
        <Switch
          aria-label="Monthly budget"
          checked={budget.on}
          disabled={onChange === undefined}
          onCheckedChange={(on: boolean) => onChange?.({ ...budget, on })}
        />
      }
    >
      {budget.on && (
        <div className="grid gap-3">
          <span className="flex flex-wrap items-center gap-2">
            <Text>Keep this month's bill under</Text>
            <InputGroup
              className="w-28"
              disabled={onChange === undefined}
              error={draftError === null ? undefined : { message: draftError, match: true }}
            >
              <InputGroup.Addon>$</InputGroup.Addon>
              <InputGroup.Input
                aria-label="Monthly budget in dollars"
                name="budget"
                inputMode="decimal"
                autoComplete="off"
                placeholder="50"
                aria-describedby={draftError === null ? undefined : errorId}
                value={draft}
                onChange={(e) => setDraft(e.currentTarget.value)}
                onBlur={commit}
                onKeyDown={(e) => {
                  if (e.key === "Enter") commit();
                }}
              />
            </InputGroup>
            <Text variant="secondary">including the ${PAID_PLAN_MONTHLY_USD} plan</Text>
          </span>
          {draftError !== null && <AmountError id={errorId}>{draftError}</AmountError>}
          {exempt.length > 0 && (
            <Text variant="secondary">
              Never paused for the budget: <AppLinks apps={exempt} />. Their spend still counts, so
              other apps are paused first.
            </Text>
          )}
          {live && (
            <>
              <ProgressBar
                now={bill.now}
                projected={bill.projected}
                target={amount}
                label={`Budget ${usd(amount)}`}
                fmt={usd}
              />
              <Text variant="secondary">
                <span className={overBudget ? "text-kumo-danger" : undefined}>
                  {usd(bill.now)} so far this month, on pace for {usd(bill.projected)}. {verdict}
                </span>
              </Text>
            </>
          )}
        </div>
      )}
    </SectionRow>
  );
}
