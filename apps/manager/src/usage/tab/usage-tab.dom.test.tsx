import { Toasty } from "@cloudflare/kumo";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { type UsageScenario, usageTabFixture } from "../../test/usage-tab-fixture";
import type { PauseView, UsageTabData } from "../tab";

// Reads and changes reach the server; the chart draws on a canvas. These tests look and click.
const router = vi.hoisted(() => ({ invalidate: vi.fn(async () => {}) }));
const server = vi.hoisted(() => ({
  getUsageTab: vi.fn(),
  setAppSpend: vi.fn(),
  createAlertRuleFn: vi.fn(),
  updateAlertRuleFn: vi.fn(),
  deleteAlertRuleFn: vi.fn(),
  setObservabilityFn: vi.fn(),
  pauseAppFn: vi.fn(),
  resumeAppFn: vi.fn(),
}));
vi.mock("@tanstack/react-router", () => ({
  useRouter: () => ({ ...router, navigate: async () => {} }),
}));
vi.mock("../tab.functions", () => ({
  getUsageTab: server.getUsageTab,
  setAppSpend: server.setAppSpend,
}));
vi.mock("../alert-rules.functions", () => ({
  createAlertRuleFn: server.createAlertRuleFn,
  updateAlertRuleFn: server.updateAlertRuleFn,
  deleteAlertRuleFn: server.deleteAlertRuleFn,
}));
vi.mock("../observability.functions", () => ({ setObservabilityFn: server.setObservabilityFn }));
vi.mock("../pause.functions", () => ({
  pauseAppFn: server.pauseAppFn,
  resumeAppFn: server.resumeAppFn,
}));
vi.mock("./usage-chart", () => ({
  default: (props: {
    product: { key: string; normal: number | null };
    range: string;
    events: { at: number }[];
  }) => (
    <div
      data-testid="chart"
      data-product={props.product.key}
      data-range={props.range}
      data-normal={props.product.normal === null ? "" : "yes"}
    />
  ),
}));

const { UsageTab } = await import("./usage-tab");

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const NOW = Date.UTC(2026, 9, 12, 15, 30);
let container: HTMLDivElement;
let root: Root;
/** A new tab each time, as opening it again would. */
let shown = 0;

beforeEach(() => {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  for (const fn of Object.values(server)) fn.mockReset();
  router.invalidate.mockClear();
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
  document.body.innerHTML = "";
});

async function settle() {
  for (let i = 0; i < 6; i++) await act(async () => {});
}

async function show(data: UsageTabData, { isAdmin = true, app = "Service status" } = {}) {
  server.getUsageTab.mockResolvedValue(data);
  act(() =>
    root.render(
      <Toasty>
        <UsageTab key={++shown} installId={data.installId} app={app} isAdmin={isAdmin} />
      </Toasty>,
    ),
  );
  await settle();
}

function scenario(name: UsageScenario, options: Parameters<typeof usageTabFixture>[1] = {}) {
  return usageTabFixture(name, { now: NOW, ...options });
}

function text(): string {
  return (container.textContent ?? "").replace(/\s+/g, " ");
}

function buttons(): string[] {
  return [...container.querySelectorAll("button")].map((b) => b.textContent?.trim() ?? "");
}

function button(label: string, within: Element = container): HTMLButtonElement {
  const found = [...within.querySelectorAll("button")].find(
    (b) => b.textContent?.trim() === label || b.getAttribute("aria-label") === label,
  );
  if (found === undefined) throw new Error(`no button ${label}`);
  return found;
}

function spendSection(): HTMLElement {
  const found = container.querySelector<HTMLElement>("#spend-protection");
  if (found === null) throw new Error("no spend protection section");
  return found;
}

function banner(): HTMLElement | null {
  return container.querySelector<HTMLElement>('[role="alert"], [role="status"]');
}

function chart(): HTMLElement {
  const found = container.querySelector<HTMLElement>('[data-testid="chart"]');
  if (found === null) throw new Error("no chart");
  return found;
}

function type(field: HTMLInputElement, value: string) {
  const setValue = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set;
  act(() => {
    setValue?.call(field, value);
    field.dispatchEvent(new Event("input", { bubbles: true }));
  });
}

describe("UsageTab", () => {
  it("calm: a green line, the chart of the busiest product, the table, spend protection and recent activity, in order", async () => {
    await show(scenario("calm"));
    expect(server.getUsageTab).toHaveBeenCalledWith({ data: { installId: "install-statusbeam" } });
    const sections = [...container.querySelectorAll("section[id]")].map((s) => s.id);
    expect(sections).toEqual(["usage", "spend-protection", "activity"]);
    expect(banner()).toBeNull();
    const page = text();
    expect(page).toMatch(/Normal for this app\. \d+% of today's Worker requests in this account/);
    expect(container.querySelector('[data-tone="good"]')).not.toBeNull();
    expect(buttons()).toEqual(expect.arrayContaining(["24 hours", "7 days", "30 days"]));
    expect(chart().dataset).toMatchObject({
      product: "workers_requests",
      range: "24h",
      normal: "yes",
    });
    expect(page).toMatch(/\d+ requests in the last hour · updated a minute ago/);
    const heads = [...container.querySelectorAll("th")].map((th) => th.textContent);
    expect(heads).toEqual([
      "Product",
      "Last 24 hours",
      "Today",
      "This month",
      "Projected",
      "Of included",
      "Cost past included",
    ]);
    expect(container.querySelectorAll("tbody tr")).toHaveLength(3);
    expect(page).toContain("Alerts go to Telegram and Slack, and to Home.");
    expect(page).toContain("Auto-pause off");
    expect(page).not.toContain("alert sent");
    expect(page).toContain("When it has spent $6.00 this month");
    expect(page).toContain("When it is on pace to spend $20.00 by the end of the month");
    expect(page).toContain("Watching");
    expect(page).toContain("Account default (off)");
    expect(page).toContain("At 20× its normal");
    // Auto-pause is off: no triggers.
    expect(page).not.toContain("The account's triggers");
    expect(page).toContain("Updated to 0.1.0Automatic update");
    expect(page).toContain("InstalledFrom the catalog");
  });

  it("picks the chart's product from the table, by the row or its button, and the range", async () => {
    await show(scenario("calm"));
    const rows = [...container.querySelectorAll<HTMLElement>("tbody tr")];
    const dos = rows.find((r) => r.dataset.product === "do_requests");
    await act(async () => dos?.click());
    expect(chart().dataset.product).toBe("do_requests");
    const d1 = button("D1 rows written");
    await act(async () => d1.click());
    expect(chart().dataset.product).toBe("d1_rows_written");
    expect(d1.getAttribute("aria-pressed")).toBe("true");
    await act(async () => button("7 days").click());
    await settle();
    expect(chart().dataset.range).toBe("7d");
  });

  it("busy: a quiet banner and a badge on the product, Pause only by choice", async () => {
    await show(scenario("busy"), { app: "Short links" });
    expect(banner()?.textContent).toContain("Busier than usual");
    expect(text()).toMatch(/Busier than usual: .* its normal\. Not a loop\./);
    expect(container.querySelector('[data-tone="warn"]')).not.toBeNull();
    expect(text()).toMatch(/\d+(\.\d)?× normal/);
    // Not in the banner: the spend protection section offers it, as a quiet button.
    expect(banner()?.querySelector("button")).toBeNull();
    const pause = button("Pause Short links", spendSection());
    expect(pause.textContent?.trim()).toBe("Pause app");
    expect(buttons().filter((b) => b === "Pause app")).toHaveLength(1);
  });

  it("calm: admins can pause the app by choice; members cannot", async () => {
    await show(scenario("calm"), { app: "Short links" });
    expect(button("Pause Short links", spendSection()).textContent?.trim()).toBe("Pause app");
    await show(scenario("calm"), { app: "Short links", isAdmin: false });
    expect(buttons()).not.toContain("Pause app");
  });

  it("runaway: the banner with the numbers and Pause app, the product in red, the alert it sent", async () => {
    await show(scenario("runaway"));
    const b = banner();
    expect(b?.getAttribute("role")).toBe("alert");
    expect(b?.textContent).toContain("Far above normal since");
    expect(b?.textContent).toContain("Durable Objects requests at");
    expect(b?.textContent).toContain("It started right after a settings change.");
    expect(b?.textContent).toContain("Auto-pause is off for this app.");
    expect(button("Pause app", b ?? container)).toBeTruthy();
    expect(chart().dataset.product).toBe("do_requests");
    expect(text()).toContain("1 alert sent");
    expect(text()).toContain("Alert sent");
    expect(text()).toContain(
      "Unusual usageDurable Objects requests at about 3,000× this app's normal.",
    );
    // Pause asks first.
    await act(async () => button("Pause app").click());
    await settle();
    expect(document.body.textContent).toContain("It stops using Cloudflare until you resume it.");
  });

  it("limit (Free): the free limit used up, shares of free limits today, no dollars past included", async () => {
    await show(scenario("limit"));
    expect(banner()?.textContent).toContain("Used up today's free Durable Objects requests");
    expect(banner()?.textContent).toContain("Nothing is billed on the Free plan.");
    expect(text()).toContain("used up today's free limit after a loop from");
    const heads = [...container.querySelectorAll("th")].map((th) => th.textContent);
    expect(heads).toContain("Of free limit");
    expect(heads).not.toContain("Cost past included");
    expect(text()).toMatch(/100% today/);
    expect(text()).toContain(
      "Get told when this app uses, or is on pace to use, a share of a free daily limit.",
    );
    expect(text()).toContain("Turn it on to pause the app when it loops.");
  });

  it("paused past its cap: the reason, Resume asking to set the cap aside, the app's own triggers", async () => {
    await show(scenario("paused"));
    const b = banner();
    expect(b?.textContent).toContain("Paused by Appflare at");
    expect(b?.textContent).toContain("It passed its $2.00 daily cap.");
    expect(b?.textContent).toContain("Resume it when its cap resets, or change the cap below.");
    expect(text()).toMatch(
      /Paused since .*, so no usage since\. It used .* Durable Objects requests before that today\./,
    );
    expect(text()).toContain("Auto-pause on");
    expect(text()).toContain("This app's own triggers.");
    expect(text()).toContain("Paused, so nothing to check until it resumes.");
    expect(text()).toMatch(/Passed the cap at .* and was paused, so nothing more is being spent\./);
    await act(async () => button("Resume").click());
    await settle();
    expect(server.resumeAppFn).not.toHaveBeenCalled();
    expect(document.body.textContent).toContain("Resume until the cap resets");
    const link = [
      ...document.body.querySelectorAll('[role="dialog"] a, [role="alertdialog"] a'),
    ][0];
    expect(link?.getAttribute("href")).toBe("/apps/install-statusbeam?tab=usage#spend-protection");
  });

  function pausedBy(pause: Partial<PauseView>): UsageTabData {
    const data = scenario("paused");
    const p = { ...(data.pause as PauseView), ...pause, stillPastCap: null };
    return { ...data, pause: p, status: { kind: "paused", pause: p, product: "do_requests" } };
  }

  it("paused for a loop, for the budget, or by someone: each names its reason", async () => {
    await show(
      pausedBy({
        cause: { reason: "loop", level: "strict", plan: "paid", burnPerHour: 3.2, times: 120 },
      }),
    );
    expect(banner()?.textContent).toContain(
      "Its usage looked like a loop for 10 minutes: over $0.25 an hour and 20× its normal (loop check: Strict).",
    );
    expect(banner()?.textContent).toContain("Fix the cause first");
    await show(pausedBy({ cause: { reason: "budget", budget: 50, projected: 66.45 } }));
    expect(banner()?.textContent).toContain("past its $50.00 monthly budget");
    await show(pausedBy({ by: "Ada Lovelace", cause: { reason: "manual" } }));
    expect(banner()?.textContent).toContain("Paused by Ada Lovelace");
    expect(banner()?.textContent).toMatch(/Ada Lovelace paused it at /);
    // Without the cap still passed, Resume is one click.
    server.resumeAppFn.mockResolvedValue({ jobId: "j" });
    await act(async () => button("Resume").click());
    await settle();
    expect(server.resumeAppFn).toHaveBeenCalledWith({ data: { installId: "install-statusbeam" } });
  });

  it("fresh: says when usage shows up and turns Workers Logs on", async () => {
    await show(scenario("fresh"), { app: "Contact forms" });
    expect(text()).toContain("Usage shows up about an hour after install");
    expect(text()).toContain(
      "Installed 6 minutes ago. Cloudflare reports a new app's usage after about an hour.",
    );
    expect(container.querySelector('[data-testid="chart"]')).toBeNull();
    expect(buttons()).not.toContain("24 hours");
    server.setObservabilityFn.mockResolvedValue({ state: "on" });
    await act(async () => button("Turn on Workers Logs").click());
    await settle();
    expect(server.setObservabilityFn).toHaveBeenCalledWith({
      data: { installId: "install-formzero", enabled: true },
    });
    // Read again to show the new state.
    expect(server.getUsageTab).toHaveBeenCalledTimes(2);
  });

  it("reconnect: says why there are no numbers, with the way to reconnect for an admin", async () => {
    await show(scenario("reconnect"));
    expect(text()).toContain("Reconnect to see usage");
    expect(text()).toContain(
      "Appflare can't read this app's usage until Cloudflare is reconnected.",
    );
    const link = [...container.querySelectorAll("a")].find(
      (a) => a.textContent === "Reconnect Cloudflare",
    );
    expect(link?.getAttribute("href")).toBe("/settings/account?reconnect=1#connection");
    expect(text()).toContain("Spend protection");
  });

  it("reconnect with an API token: names the permissions the token needs", async () => {
    await show(scenario("reconnect", { via: "token" }));
    expect(text()).toContain("Give the token access to usage");
    expect(text()).toContain("Account Analytics (Read) and Workers Observability (Read)");
    const link = [...container.querySelectorAll("a")].find(
      (a) => a.textContent === "Cloudflare connection",
    );
    expect(link?.getAttribute("href")).toBe("/settings/account#connection");
  });

  it("member: everything shows, nothing changes", async () => {
    await show(scenario("runaway", { isAdmin: false }), { isAdmin: false });
    const all = buttons();
    expect(all).not.toContain("Pause app");
    expect(all).not.toContain("Add alert");
    expect(container.querySelector('[aria-label="Edit alert"]')).toBeNull();
    expect(container.querySelector('[aria-label="Remove alert"]')).toBeNull();
    expect(text()).toContain("Alerts go to the account's notification channels, and to Home.");
    expect(text()).toContain("Only admins can change these.");
    expect(text()).toContain("Far above normal since");
    for (const select of container.querySelectorAll(
      '[aria-label="Unusual usage alert"], [aria-label="Pause automatically"]',
    )) {
      expect(select.hasAttribute("disabled") || select.getAttribute("data-disabled") !== null).toBe(
        true,
      );
    }
  });

  it("a member does not see Resume on a paused app", async () => {
    await show(scenario("paused", { isAdmin: false }), { isAdmin: false });
    expect(buttons()).not.toContain("Resume");
    expect(buttons()).not.toContain("Use the account's triggers");
  });
});

describe("spend protection changes", () => {
  it("adds a usage alert from the sentence, and shows what the server answers", async () => {
    await show(scenario("calm"));
    await act(async () => button("Add alert").click());
    expect(text()).toContain("When it");
    const save = button("Save alert");
    expect(save.disabled).toBe(true);
    const amount = container.querySelector<HTMLInputElement>('input[name="alert-amount"]');
    if (amount === null) throw new Error("no amount");
    type(amount, "6");
    const answer = scenario("calm", {
      rules: [
        {
          id: "new",
          installId: "install-statusbeam",
          kind: "spent",
          unit: "usd",
          amount: 6,
          period: "month",
          createdAt: 0,
          createdBy: "u",
          lastFiring: null,
        },
      ],
    });
    server.createAlertRuleFn.mockResolvedValue(answer);
    await act(async () => button("Save alert").click());
    await settle();
    expect(server.createAlertRuleFn).toHaveBeenCalledWith({
      data: {
        installId: "install-statusbeam",
        rule: { kind: "spent", unit: "usd", amount: 6, period: "month" },
      },
    });
    expect(container.querySelector('input[name="alert-amount"]')).toBeNull();
    expect(container.querySelectorAll("[data-rule]")).toHaveLength(1);
  });

  it("keeps the editor open with the server's refusal", async () => {
    await show(scenario("calm"));
    await act(async () => button("Edit alert").click());
    const amount = container.querySelector<HTMLInputElement>('input[name="alert-amount"]');
    if (amount === null) throw new Error("no amount");
    expect(amount.value).toBe("6");
    type(amount, "8");
    server.updateAlertRuleFn.mockRejectedValue(
      new Error("There is no such alert. It may have been removed."),
    );
    server.getUsageTab.mockResolvedValue(scenario("calm"));
    await act(async () => button("Save alert").click());
    await settle();
    expect(server.updateAlertRuleFn).toHaveBeenCalledWith({
      data: {
        installId: "install-statusbeam",
        ruleId: "rule-spent",
        rule: { kind: "spent", unit: "usd", amount: 8, period: "month" },
      },
    });
    expect(text()).toContain("There is no such alert. It may have been removed.");
    expect(container.querySelector('input[name="alert-amount"]')).not.toBeNull();
  });

  it("says a typed amount is out of range before sending it", async () => {
    await show(scenario("calm"));
    await act(async () => button("Add alert").click());
    const amount = container.querySelector<HTMLInputElement>('input[name="alert-amount"]');
    if (amount === null) throw new Error("no amount");
    type(amount, "-3");
    expect(button("Save alert").disabled).toBe(true);
    await act(async () =>
      amount.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true })),
    );
    expect(text()).toContain("Enter an amount of dollars");
    expect(server.createAlertRuleFn).not.toHaveBeenCalled();
  });

  it("on Free, the sentence is a share of a free daily limit, today", async () => {
    await show(scenario("limit", { rules: [] }));
    await act(async () => button("Add alert").click());
    expect(text()).toContain("of a free daily limit today");
    expect(container.querySelector('[aria-label="Unit"]')).toBeNull();
    expect(container.querySelector('[aria-label="Period"]')).toBeNull();
    const amount = container.querySelector<HTMLInputElement>('input[name="alert-amount"]');
    if (amount === null) throw new Error("no amount");
    type(amount, "50");
    server.createAlertRuleFn.mockResolvedValue(scenario("limit"));
    await act(async () => button("Save alert").click());
    await settle();
    expect(server.createAlertRuleFn).toHaveBeenCalledWith({
      data: {
        installId: "install-statusbeam",
        rule: { kind: "spent", unit: "pct", amount: 50, period: "day" },
      },
    });
  });

  it("on Free, an old dollar alert says it is not used and opens as one Free can save", async () => {
    await show(scenario("limit"));
    const row = container.querySelector<HTMLElement>('[data-rule="rule-spent"]');
    expect(row?.textContent).toContain("Dollar alerts aren't used on Workers Free.");
    expect(row?.textContent).toContain("Not used");
    expect(row?.querySelector('[role="meter"]')).toBeNull();
    expect(row?.querySelector('[aria-label="Remove alert"]')).not.toBeNull();
    await act(async () => button("Edit alert", row ?? container).click());
    expect(text()).toContain("of a free daily limit today");
    const amount = container.querySelector<HTMLInputElement>('input[name="alert-amount"]');
    expect(amount?.value).toBe("");
    if (amount === null) throw new Error("no amount");
    type(amount, "40");
    server.updateAlertRuleFn.mockResolvedValue(scenario("limit"));
    await act(async () => button("Save alert").click());
    await settle();
    expect(server.updateAlertRuleFn).toHaveBeenCalledWith({
      data: {
        installId: "install-statusbeam",
        ruleId: "rule-spent",
        rule: { kind: "spent", unit: "pct", amount: 40, period: "day" },
      },
    });
  });

  it("paused: its alerts are watching, not on pace, since it uses nothing more", async () => {
    await show(scenario("paused"));
    const states = [...container.querySelectorAll("[data-rule]")].map((r) =>
      r.textContent?.includes("Watching") ? "watching" : "other",
    );
    expect(states).toEqual(["watching", "watching"]);
    expect(text()).not.toContain("On pace to pass");
  });

  it("removes an alert", async () => {
    await show(scenario("calm"));
    server.deleteAlertRuleFn.mockResolvedValue(scenario("calm", { rules: [] }));
    await act(async () =>
      [...container.querySelectorAll<HTMLButtonElement>('[aria-label="Remove alert"]')][0]?.click(),
    );
    await settle();
    expect(server.deleteAlertRuleFn).toHaveBeenCalledWith({
      data: { installId: "install-statusbeam", ruleId: "rule-spent" },
    });
    expect(container.querySelectorAll("[data-rule]")).toHaveLength(0);
  });

  it("goes back to the account's triggers, and exempts the app from the budget", async () => {
    await show(scenario("paused", { defaults: { budget: { on: true, amount: 50 } } }));
    server.setAppSpend.mockResolvedValue(scenario("paused"));
    await act(async () => button("Use the account's triggers").click());
    await settle();
    expect(server.setAppSpend).toHaveBeenCalledWith({
      data: { installId: "install-statusbeam", patch: { customTriggers: false } },
    });
    await show(
      scenario("calm", {
        own: { autoPause: "on", customTriggers: false },
        defaults: { budget: { on: true, amount: 50 } },
      }),
    );
    expect(text()).toContain("The account's triggers.");
    expect(text()).toContain(
      "Monthly budget: Appflare may pause this app when the account's bill is on pace to pass $50.00.",
    );
    server.setAppSpend.mockResolvedValue(
      scenario("calm", {
        own: { autoPause: "on", customTriggers: false, budgetExempt: true },
        defaults: { budget: { on: true, amount: 50 } },
      }),
    );
    const exempt = [...container.querySelectorAll<HTMLElement>('[role="checkbox"]')].find((el) =>
      el.closest("label")?.textContent?.includes("Never pause this app for the budget"),
    );
    await act(async () => exempt?.closest("label")?.querySelector("input")?.click());
    await settle();
    expect(server.setAppSpend).toHaveBeenLastCalledWith({
      data: { installId: "install-statusbeam", patch: { budgetExempt: true } },
    });
    await act(async () => button("Customize for this app").click());
    await settle();
    expect(server.setAppSpend).toHaveBeenLastCalledWith({
      data: {
        installId: "install-statusbeam",
        patch: {
          customTriggers: true,
          loop: { on: true, level: "standard" },
          cap: { on: true, amount: 10, period: "month" },
        },
      },
    });
  });

  it("shows a refused change in the section", async () => {
    await show(scenario("calm", { own: { autoPause: "on", customTriggers: false } }));
    server.setAppSpend.mockRejectedValue(new Error("There is no such app."));
    await act(async () => button("Customize for this app").click());
    await settle();
    expect(text()).toContain("There is no such app.");
  });
});
