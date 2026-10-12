import { ChartPalette } from "@cloudflare/kumo";

/**
 * A small line of values with its area filled faintly, scaled to its own
 * peak: the shape of the last 24 hours in a table cell, in the large
 * chart's colours (red when far above normal, grey when paused).
 * Decorative: the cells beside it carry the numbers.
 */

const COLOR = {
  neutral: () => ChartPalette.categorical(0),
  alert: () => ChartPalette.semantic("Attention"),
  muted: () => ChartPalette.semantic("Disabled"),
} as const;

export function Sparkline({
  values,
  tone = "neutral",
  width = 96,
  height = 24,
}: {
  values: readonly number[];
  tone?: "neutral" | "alert" | "muted";
  width?: number;
  height?: number;
}) {
  const max = Math.max(...values, 1e-9);
  const points = values.map((v, i) => [
    (i / Math.max(1, values.length - 1)) * width,
    height - 2 - (Math.max(0, v) / max) * (height - 4),
  ]);
  const line = points
    .map(([x, y], i) => `${i === 0 ? "M" : "L"}${x?.toFixed(1)},${y?.toFixed(1)}`)
    .join(" ");
  return (
    <svg
      width={width}
      height={height}
      viewBox={`0 0 ${width} ${height}`}
      aria-hidden
      data-tone={tone}
      className="shrink-0 overflow-visible"
      style={{ color: COLOR[tone]() }}
    >
      {values.length > 0 && (
        <>
          <path
            d={`${line} L${width},${height} L0,${height} Z`}
            fill="currentColor"
            opacity={0.12}
          />
          <path
            d={line}
            fill="none"
            stroke="currentColor"
            strokeWidth={1.5}
            strokeLinejoin="round"
          />
        </>
      )}
    </svg>
  );
}
