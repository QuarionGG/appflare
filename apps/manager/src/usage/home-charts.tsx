import { Chart, ChartPalette, type KumoChartOption } from "@cloudflare/kumo";
import { LineChart } from "echarts/charts";
import { GridComponent, LegendComponent, TooltipComponent } from "echarts/components";
import * as echarts from "echarts/core";
import { CanvasRenderer } from "echarts/renderers";
import { useMemo, useSyncExternalStore } from "react";
import { count } from "./attention-format";
import type { ProductChart, UsagePoint, UsageTone } from "./home";
import { type AxisParam, cardTooltip, stackedTooltip } from "./home-tooltips";
import type { ProductKey } from "./math";

/**
 * Home's usage charts, on Kumo's `Chart` (ECharts, only the parts used):
 * the section's stacked area by app, and the small chart on an app card.
 * Kumo's `Chart` ignores `tooltip.formatter`; tooltips go through
 * `dangerousHtmlFormatter`, with the escaped HTML of `home-tooltips.ts`.
 */

echarts.use([LineChart, GridComponent, LegendComponent, TooltipComponent, CanvasRenderer]);

/** Whether the page shows in dark mode (Kumo's `data-mode` on the root), kept current. */
export function useDarkMode(): boolean {
  return useSyncExternalStore(
    (changed) => {
      const observer = new MutationObserver(changed);
      observer.observe(document.documentElement, { attributeFilter: ["data-mode"] });
      return () => observer.disconnect();
    },
    () => document.documentElement.dataset.mode === "dark",
    () => false,
  );
}

/** The colour of a tone: the app's palette colour, red for running away, grey for paused. */
export function toneColour(tone: UsageTone, dark: boolean): string {
  if (tone.kind === "alert") return ChartPalette.semantic("Attention", dark);
  if (tone.kind === "muted") return ChartPalette.text("secondary", dark);
  return ChartPalette.categorical(tone.index, dark);
}

/** The section's chart: the selected product, stacked by app, per hour, over 7 days. */
export function UsageByAppChart({ chart }: { chart: ProductChart }) {
  const dark = useDarkMode();
  const options = useMemo(() => {
    const product: ProductKey = chart.product;
    const points = chart.series[0]?.points ?? [];
    const colours = {
      muted: ChartPalette.text("primary", dark),
      rule: dark ? "#3F3F46" : "#E5E7EB",
    };
    return {
      tooltip: {
        trigger: "axis" as const,
        confine: true,
        dangerousHtmlFormatter: (params: AxisParam[]) =>
          stackedTooltip(product, points, colours, params),
      },
      legend: { bottom: 0, icon: "circle", itemWidth: 8, itemHeight: 8 },
      grid: { left: 48, right: 12, top: 12, bottom: 36 },
      xAxis: { type: "time" as const },
      yAxis: { type: "value" as const, axisLabel: { formatter: (v: number) => count(v) } },
      series: chart.series.map((s) => {
        const colour = toneColour(s.tone, dark);
        return {
          name: s.name,
          type: "line" as const,
          stack: "apps",
          showSymbol: false,
          smooth: true,
          itemStyle: { color: colour },
          lineStyle: { width: 1, color: colour },
          areaStyle: { opacity: 0.45, color: colour },
          emphasis: { focus: "series" as const },
          data: s.points.map((p) => [p.t, p.perHour]),
        };
      }),
    };
  }, [chart, dark]);
  return (
    <Chart
      echarts={echarts}
      isDarkMode={dark}
      options={options as unknown as KumoChartOption}
      // A product with fewer apps must not keep the last product's extra series.
      optionUpdateBehavior={{ notMerge: true }}
      height={240}
    />
  );
}

/** An app card's chart: 7 days of one product in one colour; hover for the value at a time. */
export function CardUsageChart({
  product,
  points,
  tone,
}: {
  product: ProductKey;
  points: readonly UsagePoint[];
  tone: UsageTone;
}) {
  const dark = useDarkMode();
  const options = useMemo(() => {
    const colour = toneColour(tone, dark);
    const muted = ChartPalette.text("primary", dark);
    return {
      grid: { left: 0, right: 0, top: 4, bottom: 0 },
      xAxis: { type: "time" as const, show: false },
      yAxis: { type: "value" as const, show: false, min: 0 },
      tooltip: {
        trigger: "axis" as const,
        confine: true,
        axisPointer: { type: "line" as const, lineStyle: { color: dark ? "#52525B" : "#D1D5DB" } },
        dangerousHtmlFormatter: (params: AxisParam[]) =>
          cardTooltip(product, points, { muted }, params),
      },
      series: [
        {
          type: "line" as const,
          showSymbol: false,
          smooth: true,
          data: points.map((p) => [p.t, p.perHour]),
          itemStyle: { color: colour },
          lineStyle: { width: 1.5, color: colour },
          areaStyle: { color: colour, opacity: 0.12 },
        },
      ],
    };
  }, [product, points, tone, dark]);
  return (
    <Chart
      echarts={echarts}
      isDarkMode={dark}
      options={options as unknown as KumoChartOption}
      height={48}
    />
  );
}
