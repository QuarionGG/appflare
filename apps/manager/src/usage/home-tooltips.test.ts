import { describe, expect, it } from "vitest";
import type { UsagePoint } from "./home";
import { type AxisParam, cardTooltip, escapeHtml, stackedTooltip } from "./home-tooltips";

/** The charts' tooltips are HTML: a name people chose must never become markup. */

const HOSTILE = `<img src=x onerror=alert(1)>`;
const POINTS: UsagePoint[] = [{ t: Date.UTC(2026, 9, 12, 14), perHour: 1200, day: false }];
const COLOURS = { muted: "#6B7280", rule: "#E5E7EB" };

function param(seriesName: string, value: number, color = "#2563EB"): AxisParam {
  return { seriesName, color, dataIndex: 0, value: [POINTS[0]?.t ?? 0, value] };
}

describe("Home's usage tooltips", () => {
  it("escapes an app's name in the stacked chart's tooltip", () => {
    const html = stackedTooltip("workers_requests", POINTS, COLOURS, [
      param(HOSTILE, 1000),
      param("Short links", 200),
    ]);
    expect(html).not.toContain("<img");
    expect(html).toContain(escapeHtml(HOSTILE));
    expect(html).toContain("1K requests");
    expect(html).toContain("All apps");
  });

  it("drops a colour that does not read as one", () => {
    const html = stackedTooltip("workers_requests", POINTS, COLOURS, [
      param("App", 10, `red"><img src=x onerror=alert(1)>`),
    ]);
    expect(html).not.toContain("<img");
    expect(html).toContain("background:transparent");
  });

  it("escapes what the card's tooltip shows", () => {
    const html = cardTooltip("workers_requests", POINTS, { muted: HOSTILE }, [
      param(HOSTILE, 1200),
    ]);
    expect(html).not.toContain("<img");
    expect(html).toContain("1.2K requests</span> an hour");
  });

  it("says a day's point is an hourly average", () => {
    const day: UsagePoint[] = [{ t: Date.UTC(2026, 9, 8, 12), perHour: 50, day: true }];
    expect(cardTooltip("kv_reads", day, COLOURS, [param("A", 50)])).toContain(
      'Oct 8</div><span style="font-weight:500;font-variant-numeric:tabular-nums">50 reads</span> an hour on average',
    );
  });
});
