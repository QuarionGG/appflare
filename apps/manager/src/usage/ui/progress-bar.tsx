import { cn } from "@cloudflare/kumo";

/**
 * Spent so far (solid), where the pace takes it by the period's end
 * (hatched), and the target as a tick. Scaled to the target with headroom so
 * the tick stays readable. A projection that runs past the bar's end is
 * named at its right ("→ $66.45"). Nothing renders without a target. `compact` is the thin bar of a
 * row in a list, without the labels.
 */
export function ProgressBar({
  now,
  projected,
  target,
  label,
  fmt,
  compact = false,
}: {
  now: number;
  projected: number;
  target: number;
  /** Names the target under its tick: "Cap $10.00". */
  label: string;
  fmt: (value: number) => string;
  compact?: boolean;
}) {
  if (!(target > 0)) return null;
  const scale = Math.max(target * 1.25, Math.min(now, target * 2) * 1.05);
  const at = (v: number) => `${Math.max(0, Math.min(100, (v / scale) * 100))}%`;
  const over = now >= target;
  const toward = projected >= target;
  return (
    <div className={compact ? "relative" : "relative mr-20 mb-5"}>
      {/* biome-ignore lint/a11y/useSemanticElements: a native meter cannot hold the hatched pace layer under the spent one */}
      <div
        role="meter"
        aria-valuemin={0}
        aria-valuemax={target}
        aria-valuenow={Math.round(now * 100) / 100}
        aria-valuetext={`${fmt(now)} of ${label}, on pace for ${fmt(projected)}`}
        aria-label={label}
        className={cn(
          "relative w-full overflow-hidden rounded-full bg-kumo-fill",
          compact ? "h-1.5" : "h-2.5",
        )}
      >
        <div
          data-part="pace"
          className={cn(
            "absolute inset-y-0 left-0 rounded-full opacity-40",
            // The brand blue of the spent part (Kumo's text-kumo-brand is another colour).
            toward ? "text-kumo-danger" : "text-(--color-kumo-brand)",
          )}
          style={{
            width: at(projected),
            backgroundImage:
              "repeating-linear-gradient(135deg, currentColor 0 3px, transparent 3px 6px)",
          }}
        />
        <div
          data-part="spent"
          className={cn(
            "absolute inset-y-0 left-0 rounded-full",
            over ? "bg-kumo-danger" : toward ? "bg-kumo-warning" : "bg-kumo-brand",
          )}
          style={{ width: at(now) }}
        />
      </div>
      <div
        aria-hidden
        data-part="target"
        className={cn(
          "absolute w-0.5 -translate-x-1/2 rounded-full bg-kumo-contrast",
          compact ? "-inset-y-0.5" : "-inset-y-1",
        )}
        style={{ left: at(target) }}
      />
      {!compact && (
        <span
          aria-hidden
          className="absolute top-full mt-1.5 -translate-x-1/2 whitespace-nowrap text-kumo-subtle"
          style={{ left: at(target) }}
        >
          {label}
        </span>
      )}
      {!compact && projected > scale && (
        <span
          aria-hidden
          data-part="projected"
          // Past the bar's end is past the target too: always the danger tone.
          className="absolute top-1/2 left-full -translate-y-1/2 whitespace-nowrap pl-2 text-kumo-danger"
        >
          →&nbsp;{fmt(projected)}
        </span>
      )}
    </div>
  );
}
