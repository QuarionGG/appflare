import { Checkbox, cn, InputGroup, Select, Text } from "@cloudflare/kumo";
import { type ReactNode, useEffect, useId, useState } from "react";
import type { AccountPlan } from "../../account/plan";
import { LOOP_LEVEL_NAMES, type LoopLevel, PERIODS, type Period } from "../math";
import { capWatch, type LoopNowAtLevel, loopingNow, type SpendApp } from "../overview";
import { checkCapAmount, dollarsText } from "../spend-defaults";
import { dateTime, LOOP_LEVEL_LABELS, loopRuleSentence, PERIOD_NOUN, times, usd } from "./format";

/**
 * What makes Appflare pause an app: a loop (real money and far above
 * normal, on two checks in a row) and, on Paid, a spending cap. The account
 * sets them for every app (Settings → Your account); an app can set its own
 * (its Usage tab). The same rows show on both pages with a live status the
 * page passes in: where this app stands, or which apps would trip right now.
 */

export interface LoopTrigger {
  on: boolean;
  level: LoopLevel;
}

export interface CapTrigger {
  on: boolean;
  /** Dollars per `period`; null when none was entered. */
  amount: number | null;
  period: Period;
}

const LEVEL_ITEMS = LOOP_LEVEL_NAMES.map((level) => ({
  value: level,
  label: LOOP_LEVEL_LABELS[level],
}));
const PERIOD_ITEMS = PERIODS.map((period) => ({ value: period, label: PERIOD_NOUN[period] }));

function isLoopLevel(value: unknown): value is LoopLevel {
  return LOOP_LEVEL_NAMES.some((l) => l === value);
}

function isPeriod(value: unknown): value is Period {
  return PERIODS.some((p) => p === value);
}

export function TriggerRows({
  plan,
  loop,
  cap,
  onLoop,
  onCap,
  disabled = false,
  loopStatus,
  capStatus,
}: {
  plan: AccountPlan;
  loop: LoopTrigger;
  cap: CapTrigger;
  /** Without both handlers the rows are read-only (an app following the account, a member). */
  onLoop?: (next: LoopTrigger) => void;
  onCap?: (next: CapTrigger) => void;
  disabled?: boolean;
  /** The loop check's live status at a level, under its rule. */
  loopStatus?: (level: LoopLevel) => ReactNode;
  /** The cap's live status for an amount (as typed, once it is one) and period. */
  capStatus?: (amount: number, period: Period) => ReactNode;
}) {
  const editable = onLoop !== undefined && onCap !== undefined;
  const [draft, setDraft] = useState(cap.amount === null ? "" : dollarsText(cap.amount));
  const [draftError, setDraftError] = useState<string | null>(null);
  const errorId = useId();
  // A saved amount (or one put back after a failed save) replaces the draft.
  useEffect(() => {
    setDraft(cap.amount === null ? "" : dollarsText(cap.amount));
    setDraftError(null);
  }, [cap.amount]);
  const typed = checkCapAmount(draft);
  const liveAmount = "amount" in typed ? typed.amount : cap.amount;
  // The cap's amount while it is a trigger (Paid, on, with an amount), else null.
  const armed =
    plan === "paid" && cap.on && liveAmount !== null && liveAmount > 0 ? liveAmount : null;

  function commitAmount() {
    if (onCap === undefined) return;
    const checked = checkCapAmount(draft);
    if ("error" in checked) {
      setDraftError(checked.error);
      return;
    }
    setDraftError(null);
    if (checked.amount !== cap.amount) onCap({ ...cap, amount: checked.amount });
  }

  return (
    <div className="grid divide-y divide-kumo-hairline">
      <div className="grid gap-2 py-3 first:pt-0">
        <span className="flex flex-wrap items-center gap-2">
          {editable ? (
            <Checkbox
              label="When it loops"
              checked={loop.on}
              disabled={disabled}
              onCheckedChange={(on: boolean) => onLoop({ ...loop, on })}
            />
          ) : (
            <Text bold>{loop.on ? "When it loops" : "Loops: not a trigger"}</Text>
          )}
          {editable ? (
            <Select
              aria-label="Loop sensitivity"
              className="w-36"
              disabled={disabled || !loop.on}
              value={loop.level}
              onValueChange={(value) => {
                if (isLoopLevel(value)) onLoop({ ...loop, level: value });
              }}
              items={LEVEL_ITEMS}
            />
          ) : (
            loop.on && <Text variant="secondary">{LOOP_LEVEL_LABELS[loop.level]}</Text>
          )}
        </span>
        {loop.on && (
          <Indent editable={editable}>
            <Text variant="secondary">{loopRuleSentence(plan, loop.level)}</Text>
            {loopStatus?.(loop.level)}
          </Indent>
        )}
      </div>
      {plan === "paid" && (
        <div className="grid gap-2 py-3 last:pb-0">
          <span className="flex flex-wrap items-center gap-2">
            {editable ? (
              <>
                <Checkbox
                  label="When it spends more than"
                  checked={cap.on}
                  disabled={disabled}
                  onCheckedChange={(on: boolean) => onCap({ ...cap, on })}
                />
                <InputGroup
                  className="w-28"
                  disabled={disabled || !cap.on}
                  error={draftError === null ? undefined : { message: draftError, match: true }}
                >
                  <InputGroup.Addon>$</InputGroup.Addon>
                  <InputGroup.Input
                    aria-label="Spending cap in dollars"
                    name="cap-amount"
                    inputMode="decimal"
                    autoComplete="off"
                    placeholder="10"
                    aria-describedby={draftError === null ? undefined : errorId}
                    value={draft}
                    onChange={(e) => setDraft(e.currentTarget.value)}
                    onBlur={commitAmount}
                    onKeyDown={(e) => {
                      if (e.key === "Enter") commitAmount();
                    }}
                  />
                </InputGroup>
                <Select
                  aria-label="Spending cap period"
                  className="w-36"
                  disabled={disabled || !cap.on}
                  value={cap.period}
                  onValueChange={(value) => {
                    if (isPeriod(value)) onCap({ ...cap, period: value });
                  }}
                  items={PERIOD_ITEMS}
                />
              </>
            ) : (
              <>
                <Text bold>
                  {armed !== null ? "When it spends more than" : "Spending: not a trigger"}
                </Text>
                {armed !== null && (
                  <Text>
                    <span className="font-medium tabular-nums">{usd(armed)}</span>{" "}
                    {PERIOD_NOUN[cap.period]}
                  </Text>
                )}
              </>
            )}
          </span>
          {draftError !== null && <AmountError id={errorId}>{draftError}</AmountError>}
          {armed !== null && capStatus !== undefined && (
            <Indent editable={editable}>{capStatus(armed, cap.period)}</Indent>
          )}
        </div>
      )}
      {!loop.on && armed === null && (
        <div className="py-3 last:pb-0">
          <Text>
            <span className="text-kumo-warning">
              Nothing is a trigger, so auto-pause never pauses anything.
            </span>
          </Text>
        </div>
      )}
    </div>
  );
}

/**
 * What is wrong with an amount as typed. Kumo's input group shows its error
 * only under a label, and these fields sit in a sentence without one.
 */
export function AmountError({ id, children }: { id: string; children: ReactNode }) {
  return (
    <p id={id} role="alert" className="text-kumo-danger">
      {children}
    </p>
  );
}

/** Lines the detail up under a checkbox's label, or flush when there is no checkbox. */
function Indent({ editable, children }: { editable: boolean; children: ReactNode }) {
  return <div className={cn("grid gap-2", editable && "pl-7")}>{children}</div>;
}

/** A status line: red when it trips, quiet otherwise. */
function Status({ alarm, children }: { alarm: boolean; children: ReactNode }) {
  return (
    <Text>
      <span className={alarm ? "text-kumo-danger" : "text-kumo-subtle"}>{children}</span>
    </Text>
  );
}

/** Where one app stands against the loop check right now. */
export function LoopNow({
  plan,
  paused,
  burnPerHour,
  ratio,
  check,
}: {
  plan: AccountPlan;
  paused: boolean;
  burnPerHour: number;
  /** Null with no normal yet. */
  ratio: number | null;
  check: LoopNowAtLevel;
}) {
  if (paused) return <Status alarm={false}>Paused, so nothing to check until it resumes.</Status>;
  const normal = ratio === null ? "no normal yet" : `${times(ratio)} its normal`;
  const now =
    plan === "free"
      ? `Right now: ${normal}.`
      : `Right now: ${usd(burnPerHour)} an hour, ${normal}.`;
  const verdict = check.trips
    ? ratio === null
      ? "No normal to compare with yet, so the money alone counts: it pauses on the next check if it stays there."
      : "Over both, so it pauses on the next check if it stays there."
    : check.abnormal
      ? "Far above normal, but not costing enough to pause."
      : check.money
        ? "Costly, but normal for this app."
        : "Fine.";
  return (
    <Status alarm={check.trips}>
      {now} {verdict}
    </Status>
  );
}

/** On the account's page: which of the apps following its triggers loop right now. */
export function LoopAcrossApps({ apps, level }: { apps: readonly SpendApp[]; level: LoopLevel }) {
  const looping = loopingNow(apps, level);
  return (
    <Status alarm={looping.length > 0}>
      {looping.length === 0
        ? "None of the apps following these is looping right now."
        : `Looping right now: ${looping.map((a) => a.label).join(", ")}.`}
    </Status>
  );
}

/** On the account's page: which of the apps following its cap are over it, or getting there. */
export function CapAcrossApps({
  apps,
  amount,
  period,
  now,
}: {
  apps: readonly SpendApp[];
  amount: number;
  period: Period;
  /** Epoch ms, to tell whether a cap set aside still is. */
  now: number;
}) {
  const rows = capWatch(apps, amount, period, now);
  if (rows.length === 0) {
    return (
      <Status alarm={false}>Every app following it is well under it {PERIOD_NOUN[period]}.</Status>
    );
  }
  return (
    <ul className="grid gap-1">
      {rows.map((r) => (
        <li key={r.app.installId}>
          <Text>
            {r.setAsideUntil !== null ? (
              <span className="text-kumo-subtle">
                {r.app.label}: {usd(r.spent)} {PERIOD_NOUN[period]}, the cap set aside until{" "}
                {dateTime(r.setAsideUntil)}
              </span>
            ) : (
              <span className={r.over ? "text-kumo-danger" : "text-kumo-warning"}>
                {r.app.label}: {usd(r.spent)} {PERIOD_NOUN[period]}
                {r.over ? ", over it" : `, on pace for ${usd(r.projected)}`}
              </span>
            )}
          </Text>
        </li>
      ))}
    </ul>
  );
}
