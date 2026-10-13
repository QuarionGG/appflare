import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { loopingApp, spendApp, spendData } from "../../test/spend-fixture";
import type { SpendProtectionData } from "../spend-defaults.functions";
import { DEFAULT_SPEND_DEFAULTS } from "../store/spend-settings";

// Saving reaches the server and the router; these tests look, type and click.
const router = vi.hoisted(() => ({ invalidate: vi.fn(async () => {}) }));
const server = vi.hoisted(() => ({ setSpendDefaults: vi.fn(), getSpendProtection: vi.fn() }));
vi.mock("@tanstack/react-router", () => ({ useRouter: () => router }));
vi.mock("../spend-defaults.functions", () => server);

const { SpendProtectionSection } = await import("./spend-protection-section");

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  router.invalidate.mockClear();
  server.setSpendDefaults.mockReset();
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
  document.body.innerHTML = "";
});

function show(data: SpendProtectionData, isAdmin = true) {
  act(() => root.render(<SpendProtectionSection data={data} isAdmin={isAdmin} />));
}

function text(): string {
  return (container.textContent ?? "").replace(/\s+/g, " ");
}

function switchNamed(label: string): HTMLElement | null {
  return container.querySelector<HTMLElement>(`[role="switch"][aria-label="${label}"]`);
}

function checkbox(label: string): HTMLElement | null {
  return (
    [...container.querySelectorAll<HTMLElement>('[role="checkbox"]')].find((el) =>
      el.closest("label")?.textContent?.includes(label),
    ) ?? null
  );
}

function input(name: string): HTMLInputElement {
  const found = container.querySelector<HTMLInputElement>(`input[name="${name}"]`);
  if (found === null) throw new Error(`no ${name} input`);
  return found;
}

/** Types into a field the way React notices. */
function type(field: HTMLInputElement, value: string) {
  const setValue = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set;
  act(() => {
    setValue?.call(field, value);
    field.dispatchEvent(new Event("input", { bubbles: true }));
  });
}

async function leave(field: HTMLInputElement) {
  await act(async () => {
    field.dispatchEvent(new FocusEvent("focusout", { bubbles: true }));
  });
}

function links(): { label: string; href: string | null }[] {
  return [...container.querySelectorAll("a")].map((a) => ({
    label: a.textContent ?? "",
    href: a.getAttribute("href"),
  }));
}

/** Paid, auto-pause and the budget on, one app looping past the budget, one with its own triggers. */
const BUSY = spendData({
  defaults: { autoPause: true, budget: { on: true, amount: 50 } },
  overview: {
    bill: { now: 18.4, projected: 66.45 },
    budgetPick: "install-statusbeam",
    apps: [
      loopingApp("install-statusbeam", "Service status"),
      spendApp("install-cut", "Short links", { budgetExempt: true }),
      spendApp("install-emdash", "Journal", { followsAccountTriggers: false }),
    ],
  },
});

describe("SpendProtectionSection", () => {
  it("is the account's spend protection, a link target, in the order of its settings", () => {
    show(BUSY);
    expect(container.querySelector("section")?.id).toBe("spend-protection");
    const page = text();
    const order = [
      "Spend protection",
      "Pause apps automatically",
      "What pauses an app",
      "Monthly budget",
      "Unusual usage alerts",
    ].map((t) => page.indexOf(t));
    expect(order.every((at) => at >= 0)).toBe(true);
    expect([...order].sort((a, b) => a - b)).toEqual(order);
    expect(page).toContain(
      "What every app in this account follows. An app's Usage tab can change it for that app.",
    );
    const docs = container.querySelector('a[aria-label="Learn more in the docs"]');
    expect(docs?.getAttribute("href")).toContain(
      "/guides/spend-protection/?utm_source=appflare-manager&utm_medium=app&utm_content=spendProtectionAccount#pause-apps-automatically",
    );
  });

  it("shows the paid account's triggers live: the app looping, the app over the cap, and the apps with their own", () => {
    show(BUSY);
    expect(switchNamed("Pause apps automatically")?.getAttribute("aria-checked")).toBe("true");
    const page = text();
    expect(page).toContain("On: Appflare pauses an app when one of the triggers below trips");
    expect(checkbox("When it loops")?.getAttribute("aria-checked")).toBe("true");
    expect(page).toContain("Over $1.00 an hour and 50× its normal, for 10 minutes.");
    expect(page).toContain("Looping right now: Service status.");
    expect(checkbox("When it spends more than")?.getAttribute("aria-checked")).toBe("true");
    expect(input("cap-amount").value).toBe("10");
    expect(page).toContain("Service status: $12.40 this month, over it");
    // Journal sets its own, so it is left out of the account's live lines.
    expect(page).not.toContain("Journal: ");
    expect(page).toContain("Set their own: Journal.");
    expect(links()).toContainEqual({
      label: "Journal",
      href: "/apps/install-emdash?tab=usage#spend-protection",
    });
  });

  it("says an app's cap is set aside instead of calling it over the cap", () => {
    show(
      spendData({
        overview: {
          apps: [
            loopingApp("install-statusbeam", "Service status", {
              capSetAsideUntil: Date.UTC(2026, 10, 1),
            }),
          ],
        },
      }),
    );
    expect(text()).toMatch(/Service status: \$12\.40 this month, the cap set aside until Nov 1/);
    expect(text()).not.toContain("over it");
  });

  it("shows the budget, the bill against it, which app it pauses first and which never", () => {
    show(BUSY);
    expect(switchNamed("Monthly budget")?.getAttribute("aria-checked")).toBe("true");
    expect(input("budget").value).toBe("50");
    const page = text();
    expect(page).toContain("Keep this month's bill under");
    expect(page).toContain("including the $5 plan");
    expect(page).toContain(
      "$18.40 so far this month, on pace for $66.45. Over the budget, so Appflare would pause Service status first.",
    );
    expect(page).toContain(
      "Never paused for the budget: Short links. Their spend still counts, so other apps are paused first.",
    );
    expect(links()).toContainEqual({
      label: "Short links",
      href: "/apps/install-cut?tab=usage#spend-protection",
    });
    const meter = container.querySelector('[role="meter"][aria-label="Budget $50.00"]');
    expect(meter?.getAttribute("aria-valuenow")).toBe("18.4");
    // Where the month ends at this pace runs past the bar: named at its end, in red.
    const projected = container.querySelector('[data-part="projected"]');
    expect(projected?.textContent).toBe("→\u00a0$66.45");
    expect(projected?.className).toContain("text-kumo-danger");
    expect(page).toContain("At 20× its normal");
  });

  it("shows a quiet paid account with everything off", () => {
    show(
      spendData({
        defaults: {
          loop: { on: false, level: "standard" },
          cap: { on: false, amount: 10, period: "month" },
        },
      }),
    );
    expect(switchNamed("Pause apps automatically")?.getAttribute("aria-checked")).toBe("false");
    expect(switchNamed("Monthly budget")?.getAttribute("aria-checked")).toBe("false");
    const page = text();
    expect(page).toContain("Off: Appflare alerts you and apps keep running.");
    expect(page).toContain("Nothing is a trigger, so auto-pause never pauses anything.");
    expect(page).not.toContain("Keep this month's bill under");
    expect(container.querySelector('input[name="budget"]')).toBeNull();
    expect(page).not.toContain("Set their own");
  });

  it("says when no app following the triggers is near them", () => {
    show(spendData());
    const page = text();
    expect(page).toContain("None of the apps following these is looping right now.");
    expect(page).toContain("Every app following it is well under it this month.");
  });

  it("leaves the dollars out on the Free plan: no cap, no budget", () => {
    show(spendData({ overview: { plan: "free", bill: { now: 0, projected: 0 } } }));
    const page = text();
    expect(page).toContain(
      "50× its normal and on pace to use 25% of a free daily limit within the day, for 10 minutes.",
    );
    expect(checkbox("When it spends more than")).toBeNull();
    expect(container.querySelector('input[name="cap-amount"]')).toBeNull();
    expect(switchNamed("Monthly budget")).toBeNull();
    expect(page).toContain(
      "Workers Free can't bill you for Workers, so there's no budget or dollar cap. R2 still bills past its free amount.",
    );
    // Nothing past R2's free amount: no line about it.
    expect(page).not.toContain("R2 this month");
  });

  it("shows what R2 bills this month on the Free plan", () => {
    show(spendData({ overview: { plan: "free", bill: { now: 0.42, projected: 1.3 } } }));
    expect(text()).toContain("R2 this month: $0.42 so far, on pace for $1.30.");
  });

  it("shows members everything without a way to change it", () => {
    show(BUSY, false);
    expect(switchNamed("Pause apps automatically")?.hasAttribute("data-disabled")).toBe(true);
    expect(switchNamed("Monthly budget")?.hasAttribute("data-disabled")).toBe(true);
    // The triggers read as sentences, not controls.
    expect(container.querySelectorAll('[role="checkbox"]')).toHaveLength(0);
    expect(container.querySelector('input[name="cap-amount"]')).toBeNull();
    const page = text();
    expect(page).toContain("When it loops");
    expect(page).toContain("Standard");
    expect(page).toMatch(/When it spends more than\s*\$10\.00 this month/);
    expect(page).toContain("Looping right now: Service status.");
    expect(input("budget").disabled).toBe(true);
    expect(page).toContain("Only admins can change these.");
  });

  it("keeps the settings but leaves the numbers out while usage cannot be read", () => {
    const blind = spendData({
      defaults: { budget: { on: true, amount: 50 } },
      overview: { missingScopes: ["account-analytics.read"], apps: [loopingApp("l", "Loop")] },
    });
    show(blind);
    let page = text();
    expect(page).toContain("Appflare can't read usage until Cloudflare is reconnected");
    expect(links()).toContainEqual({
      label: "Reconnect Cloudflare",
      href: "/settings/account?reconnect=1#connection",
    });
    expect(switchNamed("Pause apps automatically")).not.toBeNull();
    expect(page).not.toContain("Looping right now");
    expect(page).not.toContain("so far this month");
    expect(container.querySelector('[role="meter"]')).toBeNull();

    show(blind, false);
    page = text();
    expect(page).toContain("Appflare can't read usage until Cloudflare is reconnected");
    expect(links().map((l) => l.label)).not.toContain("Reconnect Cloudflare");
  });
});

describe("SpendProtectionSection, unreadable", () => {
  it("says it could not be read, as the section's error, with no settings", () => {
    act(() => root.render(<SpendProtectionSection data={null} isAdmin />));
    expect(container.querySelector("section")?.id).toBe("spend-protection");
    expect(text()).toContain(
      "Spend protection could not be read just now. Reload the page to try again.",
    );
    expect(switchNamed("Pause apps automatically")).toBeNull();
  });
});

describe("SpendProtectionSection, saving", () => {
  it("saves the switch on change and keeps it", async () => {
    server.setSpendDefaults.mockResolvedValue({ ...DEFAULT_SPEND_DEFAULTS, autoPause: true });
    show(spendData());
    await act(async () => switchNamed("Pause apps automatically")?.click());
    expect(server.setSpendDefaults).toHaveBeenCalledWith({ data: { autoPause: true } });
    expect(router.invalidate).toHaveBeenCalled();
    expect(switchNamed("Pause apps automatically")?.getAttribute("aria-checked")).toBe("true");
  });

  it("puts the switch back and says so when the save fails", async () => {
    server.setSpendDefaults.mockRejectedValue(new Error("You do not have permission to do that."));
    show(spendData());
    await act(async () => switchNamed("Pause apps automatically")?.click());
    expect(switchNamed("Pause apps automatically")?.getAttribute("aria-checked")).toBe("false");
    expect(text()).toContain("You do not have permission to do that.");
  });

  it("puts a setting back to what the server last saved, not to what it showed before", async () => {
    server.setSpendDefaults
      .mockResolvedValueOnce({ ...DEFAULT_SPEND_DEFAULTS, autoPause: true })
      .mockRejectedValueOnce(new Error("Could not save the setting."));
    show(spendData());
    const toggle = () => switchNamed("Pause apps automatically")?.click();
    // On (saved), then off (refused) before the first save answered.
    act(() => toggle());
    act(() => toggle());
    await act(async () => {});
    expect(server.setSpendDefaults).toHaveBeenNthCalledWith(1, { data: { autoPause: true } });
    expect(server.setSpendDefaults).toHaveBeenNthCalledWith(2, { data: { autoPause: false } });
    expect(switchNamed("Pause apps automatically")?.getAttribute("aria-checked")).toBe("true");
    expect(text()).toContain("Could not save the setting.");
    // The page's data is reloaded once both are done.
    expect(router.invalidate).toHaveBeenCalledTimes(1);
  });

  it("follows a cap as it is typed and saves it once the field is left", async () => {
    server.setSpendDefaults.mockImplementation(async ({ data }) => ({
      ...DEFAULT_SPEND_DEFAULTS,
      ...data,
    }));
    show(BUSY);
    const field = input("cap-amount");
    type(field, "20");
    // Live, before saving: Service status spent $12.40, over half of $20.
    expect(text()).toContain("Service status: $12.40 this month, on pace for $61.80");
    expect(server.setSpendDefaults).not.toHaveBeenCalled();
    await leave(field);
    expect(server.setSpendDefaults).toHaveBeenCalledWith({
      data: { cap: { on: true, amount: 20, period: "month" } },
    });
  });

  it("saves the budget once its field is left, without Enter", async () => {
    server.setSpendDefaults.mockImplementation(async ({ data }) => ({
      ...DEFAULT_SPEND_DEFAULTS,
      ...data,
    }));
    show(BUSY);
    const field = input("budget");
    type(field, "80");
    expect(server.setSpendDefaults).not.toHaveBeenCalled();
    await leave(field);
    expect(server.setSpendDefaults).toHaveBeenCalledWith({
      data: { budget: { on: true, amount: 80 } },
    });
  });

  it("refuses a cap of less than a cent, saying the smallest it takes", async () => {
    show(BUSY);
    const field = input("cap-amount");
    type(field, "0.0005");
    await leave(field);
    expect(server.setSpendDefaults).not.toHaveBeenCalled();
    expect(text()).toContain("Enter an amount of dollars from $0.01 to $100,000.");
  });

  it("does not save an amount that is not one, and says what is wrong", async () => {
    show(BUSY);
    const field = input("budget");
    type(field, "3");
    await leave(field);
    expect(server.setSpendDefaults).not.toHaveBeenCalled();
    expect(text()).toContain("Enter an amount of dollars, more than the $5 plan");
  });

  it("saves turning the loop trigger off", async () => {
    server.setSpendDefaults.mockImplementation(async ({ data }) => ({
      ...DEFAULT_SPEND_DEFAULTS,
      ...data,
    }));
    show(spendData());
    const box = checkbox("When it loops")?.closest("label")?.querySelector("input");
    await act(async () => box?.click());
    expect(server.setSpendDefaults).toHaveBeenCalledWith({
      data: { loop: { on: false, level: "standard" } },
    });
  });
});
