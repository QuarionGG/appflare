import { ChartPalette, TimeseriesChart } from "@cloudflare/kumo";
import * as echarts from "echarts";
import { type ComponentProps, useSyncExternalStore } from "react";
import type { AccountPlan } from "../../account/plan";
import { resolveColorMode } from "../../components/color-mode";
import { useColorMode } from "../../components/use-color-mode";
import { count } from "../attention-format";
import { PRODUCTS } from "../math";
import type { ProductUsage, UsageEvent, UsageRange } from "../tab";
import { clock } from "../ui/format";
import { amount, chartDescription, eventCopy, isMarker, label } from "./copy";

/**
 * The large chart of one product over the chosen range: its hours (24
 * hours, 7 days) or days (30 days, as the day's average hour), a "Normal"
 * line at the app's normal hour (for storage, an "Included" line), and a
 * marker at each update, settings change, alert and pause. Red when the
 * product is far above its normal. Its own module, so echarts loads with
 * the Usage tab only.
 */

const DAY = new Intl.DateTimeFormat("en", { month: "short", day: "numeric" });

function subscribeToScheme(listener: () => void): () => void {
  const query = window.matchMedia("(prefers-color-scheme: dark)");
  query.addEventListener("change", listener);
  return () => query.removeEventListener("change", listener);
}

/** Whether the page shows in dark mode, after the Appearance choice and the system's. */
function useDarkMode(): boolean {
  const [choice] = useColorMode();
  const prefersDark = useSyncExternalStore(
    subscribeToScheme,
    () => window.matchMedia("(prefers-color-scheme: dark)").matches,
    () => false,
  );
  return resolveColorMode(choice, prefersDark) === "dark";
}

const NARROW = "(max-width: 640px)";

function subscribeToWidth(listener: () => void): () => void {
  const query = window.matchMedia(NARROW);
  query.addEventListener("change", listener);
  return () => query.removeEventListener("change", listener);
}

/** A phone-width screen, where the time axis has room for few labels. */
function useNarrow(): boolean {
  return useSyncExternalStore(
    subscribeToWidth,
    () => window.matchMedia(NARROW).matches,
    () => false,
  );
}

/** What the plan lets the account hold of a stored product; null when it sets nothing. */
function includedLevel(product: ProductUsage, plan: AccountPlan): number | null {
  const allowance = plan === "paid" ? PRODUCTS[product.key].included : PRODUCTS[product.key].free;
  return allowance !== null && allowance.amount > 0 ? allowance.amount : null;
}

export default function UsageChart({
  plan,
  product,
  range,
  app,
  events,
  now,
  channels,
}: {
  plan: AccountPlan;
  product: ProductUsage;
  range: UsageRange;
  /** The app's name, for the description a screen reader hears. */
  app: string;
  events: readonly UsageEvent[];
  now: number;
  /** The channels usage alerts go to; null when the viewer may not see them. */
  channels: readonly string[] | null;
}) {
  const dark = useDarkMode();
  const narrow = useNarrow();
  const points =
    range === "24h" ? product.hours.slice(-24) : range === "7d" ? product.hours : product.days;
  const from = points[0]?.[0] ?? now;
  const markers: NonNullable<ComponentProps<typeof TimeseriesChart>["markers"]> = events
    .filter((e) => isMarker(e) && e.at >= from && e.at <= now)
    .map((e) => {
      const copy = eventCopy(e, channels);
      return {
        timestamp: e.at,
        label: copy.label,
        description: copy.description,
        color: copy.alert ? ChartPalette.semantic("Attention", dark) : undefined,
      };
    });
  const neutral = ChartPalette.semantic("Neutral", dark);
  const included = product.level ? includedLevel(product, plan) : null;
  const thresholds = product.level
    ? included === null
      ? []
      : [{ value: included, label: "Included", color: neutral }]
    : product.normal === null
      ? []
      : [{ value: product.normal, label: "Normal", color: neutral }];
  const perHour = range === "30d" ? " an hour, that day's average" : " an hour";
  return (
    <TimeseriesChart
      echarts={echarts}
      type="line"
      gradient
      height={260}
      isDarkMode={dark}
      data={[
        {
          name: label(product.key),
          data: points,
          color: product.hot
            ? ChartPalette.semantic("Attention", dark)
            : ChartPalette.categorical(0, dark),
        },
      ]}
      markers={markers}
      thresholds={thresholds}
      // The line into the hour (or day) still filling up draws dashed.
      incomplete={{ after: points.at(-2)?.[0] ?? now }}
      yAxisTickFormat={(v) => count(v)}
      tooltipValueFormat={(v) => `${amount(v, product.key)}${product.level ? "" : perHour}`}
      xAxisTickFormat={(t) => (range === "24h" ? clock(t) : DAY.format(t))}
      xAxisTickCount={narrow ? 3 : undefined}
      ariaDescription={chartDescription(product.key, app, range)}
    />
  );
}
