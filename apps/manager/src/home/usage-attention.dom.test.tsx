import { Toasty } from "@cloudflare/kumo";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { StartUpdateHandle } from "../components/update-banner";
import type { UsageAttention } from "../usage/attention";
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

const APPS = [app("status", "Service status"), app("links", "Short links"), app("feed", "Feed")];
const at = (h: number, m: number) => Date.UTC(2026, 9, 12, h, m);

const UNUSUAL: UsageAttention = {
  kind: "unusual",
  installId: "status",
  plan: "paid",
  since: at(14, 5),
  product: "do_requests",
  perHour: 48_200,
  times: 120,
  burnPerHour: 3.2,
  spentToday: 9.8,
  freeShare: null,
  sentTo: ["Telegram"],
};
const USED_UP: UsageAttention = {
  kind: "limit-used-up",
  installId: "status",
  product: "do_requests",
  limit: 100_000,
  appShare: 0.97,
  loopSince: at(14, 5),
};
const PAUSED: UsageAttention = {
  kind: "paused",
  installId: "status",
  pausedAt: at(15, 0),
  pausedBy: null,
  cause: { reason: "cap", amount: 2, period: "day", spent: 2.04 },
  loopSince: null,
  stillPastCap: null,
};
const NEAR: UsageAttention = {
  kind: "limit-near",
  installId: "links",
  product: "workers_requests",
  limit: 100_000,
  runsOutAt: at(21, 40),
  appShare: 0.64,
};

const update: StartUpdateHandle = { start: vi.fn(), pendingId: null, error: null, dialog: null };

function render(usage: UsageAttention[], isAdmin = true) {
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
            usage,
          })}
          isAdmin={isAdmin}
          update={update}
          onDismissAccountRow={() => {}}
          onUpdateAllOutcome={() => {}}
          now={new Date(at(15, 30))}
        />
      </Toasty>,
    ),
  );
}

const section = () => container.querySelector("#needs-attention");
const actions = () =>
  [...(section()?.querySelectorAll("button, a") ?? [])].map((b) => b.textContent?.trim());
const link = (label: string) =>
  [...(section()?.querySelectorAll("a") ?? [])].find((a) => a.textContent?.trim() === label);

async function settle() {
  await act(async () => {
    await new Promise((done) => setTimeout(done, 50));
  });
}

function dialog(): HTMLElement {
  const found = document.body.querySelector<HTMLElement>('[role="dialog"], [role="alertdialog"]');
  if (found === null) throw new Error("no dialog");
  return found;
}

function button(within: Element | null, label: string): HTMLButtonElement {
  const found = [...(within?.querySelectorAll("button") ?? [])].find(
    (b) => b.textContent?.trim() === label,
  );
  if (found === undefined) throw new Error(`no button "${label}"`);
  return found;
}

describe("spend protection in Needs attention", () => {
  it("shows unusual usage first, with See usage and Pause app", () => {
    render([UNUSUAL]);
    const text = section()?.textContent ?? "";
    expect(text).toContain("Unusual usage");
    expect(text).toContain("Service status is using far more than usual");
    expect(text).toContain("Durable Objects requests at 48.2K an hour since");
    expect(text).toContain("120× its normal. About $3.20 an hour at Cloudflare's prices");
    expect(text).toContain("Sent to Telegram.");
    expect(actions()).toEqual(["See usage", "Pause app"]);
    expect(link("See usage")?.getAttribute("href")).toBe("/apps/status?tab=usage");
  });

  it("shows a used-up free daily limit, with Pause app", () => {
    render([USED_UP]);
    const text = section()?.textContent ?? "";
    expect(text).toContain("Limit reached");
    expect(text).toContain("Today's free Durable Objects requests are used up");
    expect(text).toContain("used this account's 100,000 free Durable Objects requests for today");
    expect(actions()).toEqual(["See usage", "Pause app"]);
  });

  it("shows a paused app and why, with Resume", () => {
    render([PAUSED]);
    const text = section()?.textContent ?? "";
    expect(text).toContain("Paused");
    expect(text).toContain("Appflare paused Service status");
    expect(text).toContain("It passed its $2.00 daily cap. Appflare paused it at");
    expect(actions()).toEqual(["See usage", "Resume"]);
  });

  it("shows a free daily limit about to run out, with See usage only", () => {
    render([NEAR]);
    const text = section()?.textContent ?? "";
    expect(text).toContain("Free Worker requests run out around");
    expect(text).toContain("Short links is getting 64% of today's Worker requests.");
    expect(actions()).toEqual(["See usage"]);
    expect(link("See usage")?.getAttribute("href")).toBe("/apps/links?tab=usage");
  });

  it("puts the rows above the rest, most urgent first", () => {
    render([NEAR, PAUSED]);
    const text = section()?.textContent ?? "";
    expect(text.indexOf("Appflare paused Service status")).toBeLessThan(
      text.indexOf("Free Worker requests run out"),
    );
  });

  it("lets members read every row, without Pause or Resume", () => {
    render([UNUSUAL, NEAR, { ...PAUSED, installId: "feed" }], false);
    const text = section()?.textContent ?? "";
    expect(text).toContain("Service status is using far more than usual");
    expect(text).toContain("Appflare paused Feed");
    expect(text).toContain("Free Worker requests run out around");
    // Members never see where alerts go: channels are for admins.
    expect(actions()).toEqual(["See usage", "See usage", "See usage"]);
  });
});

describe("Pause and Resume", () => {
  it("asks before pausing, and starts the pause on confirm", async () => {
    server.pauseAppFn.mockResolvedValue({ jobId: "job-pause" });
    render([UNUSUAL]);
    expect(document.body.querySelector('[role="alertdialog"]')).toBeNull();
    await act(async () => button(section(), "Pause app").click());
    await settle();
    expect(dialog().textContent).toContain("Pause Service status");
    expect(dialog().textContent).toContain("It stops using Cloudflare until you resume it.");
    expect(dialog().textContent).toContain("Visitors see a “paused” page");
    expect(server.pauseAppFn).not.toHaveBeenCalled();
    await act(async () => button(dialog(), "Pause Service status").click());
    await settle();
    expect(server.pauseAppFn).toHaveBeenCalledWith({ data: { installId: "status" } });
  });

  it("keeps the dialog open with the reason when the pause cannot start", async () => {
    server.pauseAppFn.mockRejectedValue(new Error("Pausing and resuming apps is not available."));
    render([USED_UP]);
    await act(async () => button(section(), "Pause app").click());
    await settle();
    await act(async () => button(dialog(), "Pause Service status").click());
    await settle();
    expect(dialog().textContent).toContain("Pausing and resuming apps is not available.");
    expect(router.invalidate).not.toHaveBeenCalled();
  });

  it("resumes in one click and reloads the page", async () => {
    server.resumeAppFn.mockResolvedValue({ jobId: "job-resume" });
    render([PAUSED]);
    await act(async () => button(section(), "Resume").click());
    await settle();
    expect(server.resumeAppFn).toHaveBeenCalledWith({ data: { installId: "status" } });
    expect(router.invalidate).toHaveBeenCalled();
    expect(document.body.querySelector('[role="alertdialog"]')).toBeNull();
  });

  it("asks to set the cap aside when the app is still past its cap", async () => {
    server.resumeAppFn.mockResolvedValue({ jobId: "job-resume" });
    render([
      {
        ...PAUSED,
        stillPastCap: { amount: 2, period: "day", spent: 2.04, resetsAt: Date.UTC(2026, 9, 13) },
      },
    ]);
    await act(async () => button(section(), "Resume").click());
    await settle();
    expect(server.resumeAppFn).not.toHaveBeenCalled();
    expect(dialog().textContent).toContain("It's still past its daily cap: $2.04 of $2.00.");
    expect(dialog().querySelector("a")?.getAttribute("href")).toBe("/apps/status?tab=usage");
    await act(async () => button(dialog(), "Resume until the cap resets").click());
    await settle();
    expect(server.resumeAppFn).toHaveBeenCalledWith({
      data: { installId: "status", untilCapResets: true },
    });
  });
});
