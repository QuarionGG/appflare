import { Badge, Button, Checkbox, Link, Select, Text } from "@cloudflare/kumo";
import { PlusIcon } from "@phosphor-icons/react";
import { useEffect, useState } from "react";
import { Section, SectionRow, SectionRows } from "../../components/section";
import { settingsLink } from "../../components/settings-links";
import type { AlertRuleFields } from "../alert-rules";
import type { AppSpendPatch } from "../app-spend";
import { listWords } from "../attention";
import { usd } from "../attention-format";
import { periodStart } from "../math";
import { type AlertRuleView, capPassedAt, type UsageTabData } from "../tab";
import { CapProgress } from "../ui/cap-progress";
import { type CapTrigger, LoopNow, type LoopTrigger, TriggerRows } from "../ui/triggers";
import { UNUSUAL_FACTOR_ITEMS, unusualFactorOf } from "../ui/unusual-factors";
import { editableRule, newRule, RuleEditor, RuleItem } from "./alert-rule-rows";

/**
 * The app's spend protection: the unusual-usage alert, its usage alerts,
 * whether and on what it pauses itself, and (with the account's monthly
 * budget on) whether the budget may pause it. Each control saves on its
 * own; members see it all, unchangeable.
 */

/** Where the account's defaults are: a section of Settings → Your account. */
export const SPEND_DEFAULTS_HREF = settingsLink("account", "spend-protection");

export const SPEND_COPY = {
  unusual:
    "Alert when an hour of usage is far above this app's usual hour over the past week. This is what catches a loop early.",
  alertsPaid:
    "Get told when this app passes an amount, or is on pace to pass it before the day, week or month ends.",
  alertsFree: "Get told when this app uses, or is on pace to use, a share of a free daily limit.",
  autoOn: "Appflare pauses the app when a trigger below trips, then tells you. You resume it.",
  autoOffPaid:
    "Off: Appflare only alerts you and the app keeps running. Turn it on to pause the app when it loops or passes a spending cap.",
  autoOffFree:
    "Off: Appflare only alerts you and the app keeps running. Turn it on to pause the app when it loops.",
  budgetExempt:
    "Its spend still counts toward the budget, so Appflare pauses other apps first, and alerts you if that isn't enough.",
  membersOnly: "Only admins can change these.",
} as const;

export interface SpendActions {
  /** Saves part of the app's settings; a failure shows in the section. */
  save: (patch: AppSpendPatch) => Promise<void>;
  /** Each resolves to an error to show, or null once done. */
  addRule: (rule: AlertRuleFields) => Promise<string | null>;
  changeRule: (id: string, rule: AlertRuleFields) => Promise<string | null>;
  removeRule: (id: string) => Promise<void>;
}

/** "Alerts go to Telegram and Slack, and to Home." */
function AlertsGoTo({ channels }: { channels: string[] | null }) {
  if (channels === null) {
    return <>Alerts go to the account's notification channels, and to Home.</>;
  }
  return (
    <>
      {channels.length > 0
        ? `Alerts go to ${listWords(channels)}, and to Home.`
        : "Alerts go to Home."}{" "}
      <Link href={settingsLink("notifications")}>Notification channels</Link>
    </>
  );
}

export function SpendProtectionSection({
  data,
  isAdmin,
  error,
  actions,
}: {
  data: UsageTabData;
  isAdmin: boolean;
  error: string | null;
  actions: SpendActions;
}) {
  const { spend, plan } = data;
  const { defaults } = spend;
  // A change shows at once; the page's data replaces it when the save answers.
  const [shown, setShown] = useState(spend.own);
  useEffect(() => setShown(spend.own), [spend.own]);
  const [editing, setEditing] = useState<string | "new" | null>(null);
  const change = isAdmin
    ? (patch: AppSpendPatch, show: Partial<typeof shown>) => {
        setShown((s) => ({ ...s, ...show }));
        void actions.save(patch);
      }
    : undefined;

  const factor = shown.unusualFactor ?? defaults.unusualFactor;
  const auto = shown.autoPause === "default" ? defaults.autoPause : shown.autoPause === "on";
  const sent = spend.alertsSent;

  return (
    <Section
      id="spend-protection"
      title="Spend protection"
      badge={
        <span className="flex gap-1.5">
          {sent > 0 && (
            <Badge variant="error">{sent === 1 ? "1 alert sent" : `${sent} alerts sent`}</Badge>
          )}
          <Badge variant={auto ? "success" : "outline"}>
            {auto ? "Auto-pause on" : "Auto-pause off"}
          </Badge>
        </span>
      }
      description={<AlertsGoTo channels={spend.channels} />}
      error={error}
    >
      <SectionRows>
        <SectionRow
          title="Unusual usage"
          description={SPEND_COPY.unusual}
          action={
            <Select
              aria-label="Unusual usage alert"
              className="w-60"
              disabled={!isAdmin}
              value={String(factor)}
              onValueChange={(value) => {
                const next = unusualFactorOf(value);
                if (next !== null) change?.({ unusualFactor: next }, { unusualFactor: next });
              }}
              items={UNUSUAL_FACTOR_ITEMS}
            />
          }
        />
        <SectionRow
          title="Usage alerts"
          description={plan === "paid" ? SPEND_COPY.alertsPaid : SPEND_COPY.alertsFree}
          action={
            isAdmin && editing === null ? (
              <Button variant="secondary" icon={<PlusIcon />} onClick={() => setEditing("new")}>
                Add alert
              </Button>
            ) : undefined
          }
        >
          {(data.rules.length > 0 || editing === "new") && (
            <ul className="grid divide-y divide-kumo-hairline overflow-hidden rounded-lg ring-1 ring-kumo-hairline">
              {data.rules.map((rule: AlertRuleView) => (
                <li key={rule.id}>
                  {editing === rule.id ? (
                    <RuleEditor
                      plan={plan}
                      initial={editableRule(plan, rule)}
                      onCancel={() => setEditing(null)}
                      onSave={async (next) => {
                        const problem = await actions.changeRule(rule.id, next);
                        if (problem === null) setEditing(null);
                        return problem;
                      }}
                    />
                  ) : (
                    <RuleItem
                      plan={plan}
                      rule={rule}
                      onEdit={isAdmin && editing === null ? () => setEditing(rule.id) : undefined}
                      onRemove={isAdmin ? () => void actions.removeRule(rule.id) : undefined}
                    />
                  )}
                </li>
              ))}
              {editing === "new" && (
                <li>
                  <RuleEditor
                    plan={plan}
                    initial={newRule(plan)}
                    onCancel={() => setEditing(null)}
                    onSave={async (next) => {
                      const problem = await actions.addRule(next);
                      if (problem === null) setEditing(null);
                      return problem;
                    }}
                  />
                </li>
              )}
            </ul>
          )}
        </SectionRow>
        <SectionRow
          title="Pause automatically"
          description={
            <>
              {auto
                ? SPEND_COPY.autoOn
                : plan === "paid"
                  ? SPEND_COPY.autoOffPaid
                  : SPEND_COPY.autoOffFree}{" "}
              <Link href={SPEND_DEFAULTS_HREF}>Change the default</Link>
            </>
          }
          action={
            <Select
              aria-label="Pause automatically"
              className="w-60"
              disabled={!isAdmin}
              value={shown.autoPause}
              onValueChange={(value) => {
                const next = value === "on" || value === "off" ? value : "default";
                change?.({ autoPause: next }, { autoPause: next });
              }}
              items={[
                {
                  value: "default",
                  label: `Account default (${defaults.autoPause ? "on" : "off"})`,
                },
                { value: "on", label: "On for this app" },
                { value: "off", label: "Off for this app" },
              ]}
            />
          }
        >
          {auto && <PauseTriggers data={data} shown={shown} change={change} />}
          {plan === "paid" && defaults.budget.on && (
            <BudgetExemption
              budget={defaults.budget.amount}
              exempt={shown.budgetExempt}
              onChange={
                change && ((exempt) => change({ budgetExempt: exempt }, { budgetExempt: exempt }))
              }
            />
          )}
        </SectionRow>
        {!isAdmin && (
          <div className="px-5 py-4">
            <Text variant="secondary">{SPEND_COPY.membersOnly}</Text>
          </div>
        )}
      </SectionRows>
    </Section>
  );
}

type Shown = UsageTabData["spend"]["own"];

/**
 * Under "Pause automatically" while it is on: what makes Appflare pause the
 * app. The account's triggers (read-only, with where the app stands) until
 * an admin customizes them for this app.
 */
function PauseTriggers({
  data,
  shown,
  change,
}: {
  data: UsageTabData;
  shown: Shown;
  change?: (patch: AppSpendPatch, show: Partial<Shown>) => void;
}) {
  const { spend, plan, now } = data;
  const { defaults } = spend;
  const paused = data.pause !== null;
  const own = shown.customTriggers;
  const loop: LoopTrigger = own
    ? { on: shown.loopOn, level: shown.loopLevel ?? defaults.loop.level }
    : defaults.loop;
  const cap: CapTrigger = own
    ? { on: shown.capOn, amount: shown.capAmount, period: shown.capPeriod }
    : defaults.cap;
  const edit = own ? change : undefined;
  // Workers Free has no dollar cap: an app's own triggers start without one there.
  const startCap = plan === "paid" ? defaults.cap : { ...defaults.cap, on: false };
  return (
    <div className="grid gap-3 rounded-lg px-4 py-3 ring-1 ring-kumo-hairline">
      <div className="flex flex-wrap items-center justify-between gap-2 border-b border-kumo-hairline pb-3">
        <Text>
          {own ? (
            "This app's own triggers."
          ) : (
            <>
              The account's triggers. <Link href={SPEND_DEFAULTS_HREF}>Edit them</Link>
            </>
          )}
        </Text>
        {change !== undefined && (
          <Button
            variant="secondary"
            size="sm"
            onClick={() =>
              own
                ? change({ customTriggers: false }, { customTriggers: false })
                : // Start from what it follows now.
                  change(
                    { customTriggers: true, loop: defaults.loop, cap: startCap },
                    {
                      customTriggers: true,
                      loopOn: defaults.loop.on,
                      loopLevel: defaults.loop.level,
                      capOn: startCap.on,
                      capAmount: startCap.amount,
                      capPeriod: startCap.period,
                    },
                  )
            }
          >
            {own ? "Use the account's triggers" : "Customize for this app"}
          </Button>
        )}
      </div>
      <TriggerRows
        plan={plan}
        loop={loop}
        cap={cap}
        onLoop={
          edit && ((next) => edit({ loop: next }, { loopOn: next.on, loopLevel: next.level }))
        }
        onCap={
          edit &&
          ((next) =>
            edit({ cap: next }, { capOn: next.on, capAmount: next.amount, capPeriod: next.period }))
        }
        loopStatus={(level) => (
          <LoopNow
            plan={plan}
            paused={paused}
            burnPerHour={spend.burnPerHour}
            ratio={spend.ratio}
            check={spend.loop[level]}
          />
        )}
        capStatus={(amount, period) => {
          const p = spend.periods[period];
          return (
            <CapProgress
              spent={p.spent}
              projected={p.projected}
              resetsAt={p.resetsAt}
              cap={amount}
              period={period}
              paused={paused}
              passedAt={capPassedAt(data.costHours, amount, periodStart(period, now))}
            />
          );
        }}
      />
    </div>
  );
}

/**
 * The account's monthly budget can pause any app, even with auto-pause off,
 * so this shows whenever the budget is on: what it means for this app, and
 * the opt-out for an app that costs more to stop than to pay for.
 */
function BudgetExemption({
  budget,
  exempt,
  onChange,
}: {
  budget: number;
  exempt: boolean;
  onChange?: (exempt: boolean) => void;
}) {
  return (
    <div className="grid gap-1.5 rounded-lg px-4 py-3 ring-1 ring-kumo-hairline">
      <Text>
        Monthly budget: Appflare may pause this app when the account's bill is on pace to pass{" "}
        <span className="font-medium tabular-nums">{usd(budget)}</span>.{" "}
        <Link href={SPEND_DEFAULTS_HREF}>Budget settings</Link>
      </Text>
      <Checkbox
        label="Never pause this app for the budget"
        checked={exempt}
        disabled={onChange === undefined}
        onCheckedChange={(v: boolean) => onChange?.(v)}
      />
      {exempt && (
        <div className="pl-7">
          <Text variant="secondary">{SPEND_COPY.budgetExempt}</Text>
        </div>
      )}
    </div>
  );
}
