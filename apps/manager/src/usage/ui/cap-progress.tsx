import { cn, Text } from "@cloudflare/kumo";
import type { Period } from "../math";
import { clock, PERIOD_NOUN, resetsText, usd } from "./format";
import { ProgressBar } from "./progress-bar";

/**
 * One app's spend this period against its cap: what it spent, when the
 * period resets, the bar, and what happens next.
 */
export function CapProgress({
  spent,
  projected,
  resetsAt,
  cap,
  period,
  paused,
  passedAt,
}: {
  spent: number;
  /** Where the pace takes it by the reset. */
  projected: number;
  /** Epoch ms. */
  resetsAt: number;
  cap: number;
  period: Period;
  paused: boolean;
  /** Epoch ms of the hour the spend reached the cap, or null. */
  passedAt: number | null;
}) {
  const over = spent >= cap;
  const when = passedAt === null ? "" : ` at ${clock(passedAt)}`;
  return (
    <div className="grid gap-2">
      <div className="flex flex-wrap items-baseline justify-between gap-x-4">
        <Text>
          <span
            className={cn(
              "font-medium tabular-nums",
              over ? "text-kumo-danger" : projected > cap && "text-kumo-warning",
            )}
          >
            {usd(spent)}
          </span>
          <span className="text-kumo-subtle"> spent {PERIOD_NOUN[period]}</span>
        </Text>
        <Text variant="secondary">{resetsText(period, resetsAt)}</Text>
      </div>
      <ProgressBar
        now={spent}
        projected={projected}
        target={cap}
        label={`Cap ${usd(cap)}`}
        fmt={usd}
      />
      <Text variant="secondary">
        {paused && over
          ? `Passed the cap${when} and was paused, so nothing more is being spent.`
          : paused
            ? "Paused, so nothing more is being spent."
            : over
              ? `Passed the cap${when}: Appflare pauses the app on its next check, within 5 minutes.`
              : projected > cap
                ? `On pace for ${usd(projected)} by the reset, so it would be paused before then.`
                : `On pace for ${usd(projected)} by the reset, under the cap.`}
      </Text>
    </div>
  );
}
