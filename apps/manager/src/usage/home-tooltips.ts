import { productAmount, type UsagePoint } from "./home";
import type { ProductKey } from "./math";

/**
 * The tooltips of Home's usage charts, as HTML for Kumo's
 * `dangerousHtmlFormatter` (its `Chart` ignores `formatter`). App names are
 * labels people choose, so every text is escaped and a colour is used only
 * when it reads as one. Pure, so they are tested without a canvas.
 */

/** One series under the pointer, as ECharts gives it to an axis tooltip. */
export interface AxisParam {
  seriesName: string;
  color: string;
  dataIndex: number;
  value: [number, number];
}

/** The tooltip's own colours: muted text and the line above the total. */
export interface TooltipColours {
  muted: string;
  rule: string;
}

export function escapeHtml(text: string): string {
  return text.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
}

/** A colour for a style attribute: a hex colour or `transparent`, else none. */
function safeColour(colour: string): string {
  return /^(#[0-9a-f]{3,8}|transparent)$/i.test(colour) ? colour : "transparent";
}

const HOUR_LABEL = new Intl.DateTimeFormat("en", {
  month: "short",
  day: "numeric",
  hour: "numeric",
  minute: "2-digit",
});
const DAY_LABEL = new Intl.DateTimeFormat("en", {
  month: "short",
  day: "numeric",
  timeZone: "UTC",
});

/** When a point is: a day ("Oct 8", a UTC day, as the rollups are) or an hour in the reader's time. */
function pointTime(point: UsagePoint): string {
  return point.day ? DAY_LABEL.format(point.t) : HOUR_LABEL.format(point.t);
}

/** A tooltip row: a dot in the series colour, the name, the value. */
function row(colour: string, name: string, value: string): string {
  return `<div style="display:flex;gap:16px;justify-content:space-between;align-items:center"><span style="display:flex;gap:6px;align-items:center"><span style="width:8px;height:8px;border-radius:9999px;background:${safeColour(colour)}"></span>${escapeHtml(name)}</span><span style="font-weight:500;font-variant-numeric:tabular-nums">${escapeHtml(value)}</span></div>`;
}

/** The section chart's tooltip: when, then each app's use (largest first), then all apps. */
export function stackedTooltip(
  product: ProductKey,
  points: readonly UsagePoint[],
  colours: TooltipColours,
  params: readonly AxisParam[],
): string {
  const point = points[params[0]?.dataIndex ?? 0];
  const sorted = [...params].sort((a, b) => b.value[1] - a.value[1]);
  const total = sorted.reduce((t, p) => t + p.value[1], 0);
  return [
    `<div style="margin-bottom:6px;color:${safeColour(colours.muted)}">${point === undefined ? "" : `${escapeHtml(pointTime(point))} · ${point.day ? "an hour on average" : "per hour"}`}</div>`,
    ...sorted.map((p) => row(p.color, p.seriesName, productAmount(product, p.value[1]))),
    sorted.length > 1
      ? `<div style="margin-top:6px;border-top:1px solid ${safeColour(colours.rule)};padding-top:6px">${row("transparent", "All apps", productAmount(product, total))}</div>`
      : "",
  ].join("");
}

/** An app card's tooltip: when, and how much in that hour. */
export function cardTooltip(
  product: ProductKey,
  points: readonly UsagePoint[],
  colours: Pick<TooltipColours, "muted">,
  params: readonly AxisParam[],
): string {
  const point = points[params[0]?.dataIndex ?? 0];
  if (point === undefined) return "";
  return `<div style="color:${safeColour(colours.muted)}">${escapeHtml(pointTime(point))}</div><span style="font-weight:500;font-variant-numeric:tabular-nums">${escapeHtml(productAmount(product, point.perHour))}</span> ${point.day ? "an hour on average" : "an hour"}`;
}
