import { Badge, Button, InputGroup, Select, Text } from "@cloudflare/kumo";
import { PencilSimpleIcon, TrashIcon } from "@phosphor-icons/react";
import { useId, useState } from "react";
import type { AccountPlan } from "../../account/plan";
import { type AlertRuleFields, alertSentenceParts, checkAlertAmount } from "../alert-rules";
import { count, PERIOD_NOUN, usd } from "../attention-format";
import { PERIODS, type Period } from "../math";
import type { AlertRuleView } from "../tab";
import { ProgressBar } from "../ui/progress-bar";
import { AmountError } from "../ui/triggers";

/**
 * Usage alerts as rows: the rule as a sentence, where it stands ("$3.10 of
 * $6.00", a badge), and a thin bar of the period so far (solid), where the
 * pace takes it (hatched) and the amount (a tick). An admin edits a rule in
 * place, as a sentence to fill in.
 */

const STATE_BADGE: Record<
  AlertRuleView["state"],
  { label: string; variant: "error" | "warning" | "outline" }
> = {
  fired: { label: "Alert sent", variant: "error" },
  on_pace: { label: "On pace to pass", variant: "warning" },
  near: { label: "Close", variant: "warning" },
  watching: { label: "Watching", variant: "outline" },
};

const NOT_USED = { label: "Not used", variant: "outline" } as const;

/** The rule's amount as it is measured: dollars, a percent, or past 10× a multiple. */
function ruleFormat(unit: AlertRuleView["unit"]) {
  return (v: number) =>
    unit === "usd" ? usd(v) : v >= 1000 ? `${count(v / 100)}× included` : `${Math.round(v)}%`;
}

/** "When it has spent $6.00 this month", the amount set apart. */
export function RuleSentence({ plan, rule }: { plan: AccountPlan; rule: AlertRuleFields }) {
  const p = alertSentenceParts(plan, rule);
  return (
    <>
      {p.before} <span className="font-medium tabular-nums">{p.amount}</span> {p.after}
    </>
  );
}

/**
 * Why a rule set on Workers Paid does nothing on Free, where an alert
 * watches a share of a free daily limit today; null when it is used.
 */
export function unusedOnFree(plan: AccountPlan, rule: AlertRuleFields): string | null {
  if (plan !== "free") return null;
  if (rule.unit === "usd") return "Dollar alerts aren't used on Workers Free.";
  if (rule.period !== "day") return "On Workers Free an alert watches today only.";
  return null;
}

/** What the editor starts from: the rule, made one the plan uses. */
export function editableRule(plan: AccountPlan, rule: AlertRuleFields): AlertRuleFields {
  const fields = { kind: rule.kind, unit: rule.unit, amount: rule.amount, period: rule.period };
  if (unusedOnFree(plan, fields) === null) return fields;
  return { ...fields, unit: "pct", amount: rule.unit === "pct" ? rule.amount : 0, period: "day" };
}

export function RuleItem({
  plan,
  rule,
  onEdit,
  onRemove,
}: {
  plan: AccountPlan;
  rule: AlertRuleView;
  /** Without these the row is read-only (a member). */
  onEdit?: () => void;
  onRemove?: () => void;
}) {
  const fmt = ruleFormat(rule.unit);
  const unused = unusedOnFree(plan, rule);
  const badge = unused === null ? STATE_BADGE[rule.state] : NOT_USED;
  const progress =
    rule.kind === "spent"
      ? `${fmt(rule.spent)} of ${fmt(rule.amount)}`
      : `on pace for ${fmt(rule.projected)}`;
  return (
    <div className="grid gap-1.5 px-3 py-2" data-rule={rule.id}>
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
        <Text>
          <RuleSentence plan={plan} rule={rule} />
        </Text>
        <span className="ml-auto flex items-center gap-2">
          {unused === null && (
            <Text variant="secondary">
              <span className="tabular-nums">{progress}</span>
            </Text>
          )}
          <Badge variant={badge.variant}>{badge.label}</Badge>
          {(onEdit !== undefined || onRemove !== undefined) && (
            <span className="flex">
              {onEdit !== undefined && (
                <Button
                  variant="ghost"
                  size="sm"
                  shape="square"
                  icon={<PencilSimpleIcon />}
                  aria-label="Edit alert"
                  title="Edit"
                  onClick={onEdit}
                />
              )}
              {onRemove !== undefined && (
                <Button
                  variant="ghost"
                  size="sm"
                  shape="square"
                  icon={<TrashIcon />}
                  aria-label="Remove alert"
                  title="Remove"
                  onClick={onRemove}
                />
              )}
            </span>
          )}
        </span>
      </div>
      {unused !== null && <Text variant="secondary">{unused}</Text>}
      {unused === null && (
        <ProgressBar
          compact
          now={rule.spent}
          projected={rule.projected}
          target={rule.amount}
          label={fmt(rule.amount)}
          fmt={fmt}
        />
      )}
    </div>
  );
}

const PERIOD_ITEMS = PERIODS.map((p) => ({ value: p, label: PERIOD_NOUN[p] }));

function isPeriod(value: unknown): value is Period {
  return PERIODS.some((p) => p === value);
}

/** A new rule's starting point: dollars this month on Paid; a share of a free daily limit today on Free. */
export function newRule(plan: AccountPlan): AlertRuleFields {
  return plan === "free"
    ? { kind: "spent", unit: "pct", amount: 0, period: "day" }
    : { kind: "spent", unit: "usd", amount: 0, period: "month" };
}

/** The alert as a sentence to fill in: "When it [has spent] [$ 6.00] [in dollars] [this month]". */
export function RuleEditor({
  plan,
  initial,
  onSave,
  onCancel,
}: {
  plan: AccountPlan;
  initial: AlertRuleFields;
  /** Resolves to an error to show, or null once saved. */
  onSave: (rule: AlertRuleFields) => Promise<string | null>;
  onCancel: () => void;
}) {
  const free = plan === "free";
  const [rule, setRule] = useState(initial);
  const [text, setText] = useState(initial.amount > 0 ? String(initial.amount) : "");
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const errorId = useId();
  const usdUnit = rule.unit === "usd";
  const typed = checkAlertAmount(text, rule.unit);

  async function save() {
    const checked = checkAlertAmount(text, rule.unit);
    if ("error" in checked) {
      setError(checked.error);
      return;
    }
    setSaving(true);
    setError(await onSave({ ...rule, amount: checked.amount }));
    setSaving(false);
  }

  return (
    <div className="grid gap-3 bg-kumo-recessed px-3 py-3">
      <div className="flex flex-wrap items-center gap-2">
        <Text>When it</Text>
        <Select
          aria-label="Alert when it has or is on pace to"
          className="w-48"
          value={rule.kind}
          onValueChange={(v) => setRule({ ...rule, kind: v === "pace" ? "pace" : "spent" })}
          items={[
            { value: "spent", label: usdUnit ? "has spent" : "has used" },
            { value: "pace", label: usdUnit ? "is on pace to spend" : "is on pace to use" },
          ]}
        />
        <InputGroup className="w-28">
          {usdUnit && <InputGroup.Addon>$</InputGroup.Addon>}
          <InputGroup.Input
            aria-label="Amount"
            name="alert-amount"
            inputMode="decimal"
            autoComplete="off"
            placeholder={usdUnit ? "6.00" : "50"}
            aria-describedby={error === null ? undefined : errorId}
            value={text}
            onChange={(e) => {
              setText(e.currentTarget.value);
              setError(null);
            }}
            onKeyDown={(e) => {
              if (e.key === "Enter") void save();
            }}
          />
          {!usdUnit && <InputGroup.Addon align="end">%</InputGroup.Addon>}
        </InputGroup>
        {!free && (
          <Select
            aria-label="Unit"
            className="w-48"
            value={rule.unit}
            onValueChange={(v) => setRule({ ...rule, unit: v === "pct" ? "pct" : "usd" })}
            items={[
              { value: "usd", label: "in dollars" },
              { value: "pct", label: "of included usage" },
            ]}
          />
        )}
        {free ? (
          <Text>of a free daily limit today</Text>
        ) : (
          <Select
            aria-label="Period"
            className="w-36"
            value={rule.period}
            onValueChange={(v) => {
              if (isPeriod(v)) setRule({ ...rule, period: v });
            }}
            items={PERIOD_ITEMS}
          />
        )}
      </div>
      {error !== null && <AmountError id={errorId}>{error}</AmountError>}
      <div className="flex justify-end gap-2">
        <Button variant="secondary" size="sm" onClick={onCancel}>
          Cancel
        </Button>
        <Button
          variant="primary"
          size="sm"
          disabled={!("amount" in typed) || saving}
          onClick={() => void save()}
        >
          Save alert
        </Button>
      </div>
    </div>
  );
}
