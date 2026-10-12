import { Toasty } from "@cloudflare/kumo";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { StartUpdateHandle } from "../components/update-banner";
import type { UsageAttention } from "../usage/attention";
import type { HomeUsageData, HomeUsageSeries } from "../usage/home";
import type { ProductKey } from "../usage/math";
import { attentionItems } from "./attention";
import type { HomeApp } from "./layout-data";

// Actions reach the server and the router; these tests only look and click.
const router = vi.hoisted(() => ({ invalidate: vi.fn(async () => {}) }));
const server = vi.hoisted(() => ({ pauseAppFn: vi.fn(), resumeAppFn: vi.fn() }));
vi.mock("@tanstack/react-router", () => ({
  useRouter: () => ({ ...router, navigate: async () => {} }),
}));
vi.mock("../usage/pause.functions", () => server);
vi.mock("../installs/health.functions", () => ({ checkInstallHealth: vi.fn() }));
vi.mock("../installs/update-all.functions", () => ({ startAllUpdates: vi.fn() }));
vi.mock("../deploy-button/deploy-copy.functions", () => ({ dismissDeployCopy: vi.fn() }));
// ECharts draws on a canvas, which happy-dom lacks: the charts show what they were given.
vi.mock("../usage/home-charts", () => ({
  UsageByAppChart: ({ chart }: { chart: { product: string; series: { name: string }[] } }) => (
    <div data-chart={chart.product} data-series={chart.series.map((s) => s.name).join(",")} />
  ),
  CardUsageChart: ({ product, tone }: { product: string; tone: { kind: string } }) => (
    <div data-card-chart={product} data-tone={tone.kind} />
  ),
}));

const { HomeView } = await import("./home-view");

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  router.invalidate.mockClear();
  server.pauseAppFn.mockReset();
  server.resumeAppFn.mockReset();
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
  document.body.innerHTML = "";
});

function app(id: string, label: string): HomeApp {
  return {
    id,
    slug: id,
    catalogSource: null,
    origin: "catalog",
    icon: null,
    name: label,
    displayName: null,
    label,
    workerName: id,
    status: "installed",
    version: "1.0.0",
    latestVersion: "1.0.0",
    updateAvailable: false,
    reinstallNeeded: false,
    address: `https://${id}.acme.workers.dev`,
    updatedAt: "2026-10-01T12:00:00.000Z",
    uninstalledAt: null,
    healthStatus: "verified",
    healthAccess: false,
    healthCheckedAt: null,
    updateNeeds: null,
  };
}

const NOW = Date.UTC(2026, 9, 12, 15, 30);
const APPS = [app("status", "Service status"), app("links", "Short links"), app("new", "Notes")];

function series(installId: string, product: ProductKey, perHour: number): HomeUsageSeries {
  return {
    installId,
    product,
    past: new Array<number>(6).fill(perHour * 24),
    hours: new Array<number>(16).fill(perHour),
    ratio: null,
  };
}

function usage(over: Partial<HomeUsageData> = {}): HomeUsageData {
  return {
    plan: "paid",
    now: NOW,
    needsAccess: null,
    bill: { now: 7.85, projected: 66.45 },
    apps: [
      { installId: "status", installedAt: 1, paused: false, burnPerHour: 1.02, ratio: 3000 },
      { installId: "links", installedAt: 1, paused: false, burnPerHour: 0.01, ratio: 1 },
      {
        installId: "new",
        installedAt: NOW - 6 * 60_000,
        paused: false,
        burnPerHour: 0,
        ratio: null,
      },
    ],
    windowStart: Date.UTC(2026, 9, 6),
    grain: "day",
    series: [
      series("status", "workers_requests", 100),
      series("status", "do_requests", 4_000_000),
      series("links", "workers_requests", 300),
      series("links", "kv_reads", 300),
    ],
    // Today: 16 hours of the series above.
    account: {
      workers_requests: { today: 6_400, month: 6_400 },
      do_requests: { today: 64_000_000, month: 64_000_000 },
      kv_reads: { today: 4_800, month: 4_800 },
    },
    ...over,
  };
}

const UNUSUAL: UsageAttention = {
  kind: "unusual",
  installId: "status",
  plan: "paid",
  since: NOW - 3_600_000,
  product: "do_requests",
  perHour: 4_000_000,
  times: 3000,
  burnPerHour: 1.02,
  spentToday: 3.03,
  freeShare: null,
  sentTo: [],
};
const PAUSED: UsageAttention = {
  kind: "paused",
  installId: "status",
  pausedAt: NOW - 1_800_000,
  pausedBy: null,
  cause: { reason: "loop", level: "standard", plan: "paid" },
  loopSince: null,
  stillPastCap: null,
};

const update: StartUpdateHandle = { start: vi.fn(), pendingId: null, error: null, dialog: null };

function render(data: HomeUsageData | null, rows: UsageAttention[] = [], isAdmin = true) {
  act(() =>
    root.render(
      <Toasty>
        <HomeView
          apps={APPS}
          items={attentionItems({
            isAdmin,
            apps: APPS,
            failedJobs: [],
            accountRows: [],
            dismissedAccountRows: new Set(),
            deployCopy: null,
            downgrade: null,
            usage: rows,
          })}
          isAdmin={isAdmin}
          update={update}
          onDismissAccountRow={() => {}}
          onUpdateAllOutcome={() => {}}
          now={new Date(NOW)}
          usage={data}
        />
      </Toasty>,
    ),
  );
}

const section = () => container.querySelector("#usage");
const card = (id: string) => container.querySelector(`[data-app-card="${id}"]`);
const buttons = (within: Element | null) =>
  [...(within?.querySelectorAll("button, a") ?? [])].map((b) => b.textContent?.trim());

async function settle() {
  await act(async () => {
    await new Promise((done) => setTimeout(done, 50));
  });
}

describe("Home's Usage section", () => {
  it("sits above Your apps with the Paid totals and the chart of the product in trouble", () => {
    render(usage(), [UNUSUAL]);
    const sections = [...container.querySelectorAll("section")].map((s) => s.id);
    expect(sections.indexOf("usage")).toBeLessThan(sections.indexOf("your-apps"));
    const text = section()?.textContent ?? "";
    expect(text).toContain("Usage this month$2.85Past what the $5 plan includes (estimate)");
    expect(text).toContain("Projected month$66.45");
    expect(text).toContain("Burning now$1.03/hMostly Service status");
    expect(section()?.querySelector(".text-kumo-danger")?.textContent).toBe("$1.03/h");
    const chart = section()?.querySelector("[data-chart]");
    expect(chart?.getAttribute("data-chart")).toBe("do_requests");
    expect(chart?.getAttribute("data-series")).toBe("Service status");
    expect(text).toContain("Last 7 days · ");
    const tabs = [...(section()?.querySelectorAll('[role="tab"]') ?? [])].map((t) => t.textContent);
    expect(tabs).toEqual(["Worker requests", "Durable Objects", "KV reads"]);
  });

  it("changes the chart with the product tab", async () => {
    render(usage(), [UNUSUAL]);
    const tab = [...(section()?.querySelectorAll<HTMLElement>('[role="tab"]') ?? [])].find(
      (t) => t.textContent === "Worker requests",
    );
    await act(async () => tab?.click());
    const chart = section()?.querySelector("[data-chart]");
    expect(chart?.getAttribute("data-chart")).toBe("workers_requests");
    expect(chart?.getAttribute("data-series")).toBe("Service status,Short links");
  });

  it("on Free, says what can be billed, R2 included", () => {
    render(usage({ plan: "free", bill: { now: 0.42, projected: 1.3 } }));
    const text = section()?.textContent ?? "";
    expect(text).toContain("Can be billed$0.42 (R2)");
    expect(text).toContain("Closest daily limit");
    expect(text).toContain("Apps needing a look0");
  });

  it("without the usage permissions, offers to reconnect instead of charts, on the cards too", () => {
    render(usage({ needsAccess: { via: "oauth" } }), [UNUSUAL]);
    expect(section()?.textContent).toContain("Reconnect Cloudflare to see usage");
    const link = section()?.querySelector("a");
    expect(link?.textContent).toBe("Reconnect Cloudflare");
    expect(link?.getAttribute("href")).toContain("reconnect=1");
    expect(section()?.querySelector("[data-chart]")).toBeNull();
    expect(container.querySelector("[data-card-chart]")).toBeNull();
    expect(buttons(card("status"))).toEqual(["Open", "Manage"]);
  });

  it("tells a member an admin can reconnect", () => {
    render(usage({ needsAccess: { via: "oauth" } }), [], false);
    expect(section()?.textContent).toContain("An admin can reconnect it.");
    expect(section()?.querySelector("a")).toBeNull();
  });

  it("with an API token, asks for the permission on the token instead", () => {
    render(usage({ needsAccess: { via: "token" } }));
    expect(section()?.textContent).toContain(
      "Appflare's API token needs permission to read Cloudflare's analytics",
    );
    const link = section()?.querySelector("a");
    expect(link?.textContent).toBe("Cloudflare connection");
    expect(link?.getAttribute("href")).toBe("/settings/account#connection");
    expect(container.querySelector("[data-card-chart]")).toBeNull();
  });

  it("says when usage could not be read, and the cards show none", () => {
    render(null);
    expect(section()?.textContent).toContain("Usage could not be read just now.");
    expect(container.querySelector("[data-card-chart]")).toBeNull();
  });
});

describe("usage on Home's app cards", () => {
  it("a calm app: its chart in its colour and its share of today's requests, no extra button", () => {
    render(usage());
    const links = card("links");
    expect(links?.querySelector("[data-card-chart]")?.getAttribute("data-tone")).toBe("slot");
    expect(links?.textContent).toContain("75% of today's requests");
    expect(buttons(links)).toEqual(["Open", "Manage"]);
  });

  it("an app running away: a red chart and line, and Pause first", async () => {
    server.pauseAppFn.mockResolvedValue({ jobId: "job-pause" });
    render(usage(), [UNUSUAL]);
    const status = card("status");
    expect(status?.querySelector("[data-card-chart]")?.getAttribute("data-card-chart")).toBe(
      "do_requests",
    );
    expect(status?.querySelector("[data-card-chart]")?.getAttribute("data-tone")).toBe("alert");
    expect(status?.querySelector(".text-kumo-danger")?.textContent).toBe(
      "$1.02/h · Durable Objects requests far above normal",
    );
    expect(buttons(status)).toEqual(["Pause", "Open", "Manage"]);
    // Named with the app, like Open and Manage.
    expect(
      status?.querySelector('button[aria-label="Pause Service status"]')?.textContent?.trim(),
    ).toBe("Pause");
    await act(async () =>
      [...(status?.querySelectorAll("button") ?? [])]
        .find((b) => b.textContent?.trim() === "Pause")
        ?.click(),
    );
    await settle();
    const dialog = document.body.querySelector('[role="dialog"], [role="alertdialog"]');
    expect(dialog?.textContent).toContain("Pause Service status");
  });

  it("a paused app: a grey chart and Resume first", () => {
    render(usage(), [PAUSED]);
    const status = card("status");
    expect(status?.querySelector("[data-card-chart]")?.getAttribute("data-tone")).toBe("muted");
    expect(status?.textContent).toContain("Paused · no usage since");
    expect(buttons(status)).toEqual(["Resume", "Open", "Manage"]);
    // Named with the app, like Open and Manage.
    expect(
      status?.querySelector('button[aria-label="Resume Service status"]')?.textContent?.trim(),
    ).toBe("Resume");
  });

  it("a brand-new app says when its usage shows up", () => {
    render(usage());
    const fresh = card("new");
    expect(fresh?.textContent).toContain("Usage shows up about 15 minutes after install");
    expect(fresh?.textContent).toContain("Just installed");
    expect(fresh?.querySelector("[data-card-chart]")).toBeNull();
  });

  it("a member sees the charts but no Pause or Resume", () => {
    render(usage(), [UNUSUAL], false);
    expect(card("status")?.querySelector("[data-card-chart]")).not.toBeNull();
    expect(buttons(card("status"))).toEqual(["Open", "Manage"]);
  });
});
