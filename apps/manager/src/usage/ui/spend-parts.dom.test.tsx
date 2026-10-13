import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { CapProgress } from "./cap-progress";
import { ProgressBar } from "./progress-bar";
import { LoopNow, TriggerRows } from "./triggers";
import { UNUSUAL_FACTOR_ITEMS, unusualFactorOf } from "./unusual-factors";

/** The spend protection pieces the account page, an app's Usage tab and Home share. */

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
});

function show(node: React.ReactNode) {
  act(() => root.render(node));
}

function text(): string {
  return (container.textContent ?? "").replace(/\s+/g, " ");
}

function part(name: string): HTMLElement | null {
  return container.querySelector<HTMLElement>(`[data-part="${name}"]`);
}

const usd = (v: number) => `$${v.toFixed(2)}`;

describe("ProgressBar", () => {
  it("draws nothing without a target", () => {
    show(<ProgressBar now={1} projected={2} target={0} label="Cap" fmt={usd} />);
    expect(container.innerHTML).toBe("");
  });

  it("is a meter with the spent part solid, the pace hatched and the target ticked", () => {
    show(<ProgressBar now={2} projected={4} target={10} label="Cap $10.00" fmt={usd} />);
    const meter = container.querySelector('[role="meter"]');
    expect(meter?.getAttribute("aria-valuetext")).toBe("$2.00 of Cap $10.00, on pace for $4.00");
    // Scaled to 125% of the target: $2 is 16% of $12.50.
    expect(part("spent")?.style.width).toBe("16%");
    expect(part("spent")?.className).toContain("bg-kumo-brand");
    // The pace in the spent part's blue (`text-kumo-brand` is Cloudflare's orange).
    expect(part("pace")?.className).toContain("text-(--color-kumo-brand)");
    expect(part("target")?.style.left).toBe("80%");
    expect(part("target")?.className).toContain("bg-kumo-contrast");
    expect(text()).toContain("Cap $10.00");
    // The pace ends inside the bar: no label for it.
    expect(part("projected")).toBeNull();
  });

  it("turns amber on pace to pass the target, red past it, and names a projection off the end", () => {
    show(<ProgressBar now={6} projected={14} target={10} label="Cap" fmt={usd} />);
    expect(part("spent")?.className).toContain("bg-kumo-warning");
    expect(part("pace")?.className).toContain("text-kumo-danger");
    expect(text()).toContain("→ $14.00");
    expect(part("projected")?.className).toContain("text-kumo-danger");
    show(<ProgressBar now={12} projected={30} target={10} label="Cap" fmt={usd} />);
    expect(part("spent")?.className).toContain("bg-kumo-danger");
  });

  it("leaves the labels out when compact", () => {
    show(<ProgressBar compact now={6} projected={40} target={10} label="Cap" fmt={usd} />);
    expect(text()).toBe("");
  });
});

describe("CapProgress", () => {
  const base = {
    resetsAt: Date.UTC(2026, 10, 1),
    cap: 10,
    period: "month" as const,
    paused: false,
    passedAt: null,
  };

  it("says what was spent and where the pace takes it", () => {
    show(<CapProgress {...base} spent={3} projected={6} />);
    expect(text()).toContain("$3.00 spent this month");
    expect(text()).toContain("resets Nov 1");
    expect(text()).toContain("On pace for $6.00 by the reset, under the cap.");
    show(<CapProgress {...base} spent={3} projected={16} />);
    expect(text()).toContain("On pace for $16.00 by the reset, so it would be paused before then.");
  });

  it("says when the cap was passed, and that a paused app spends no more", () => {
    show(<CapProgress {...base} spent={12} projected={20} passedAt={Date.UTC(2026, 9, 12, 14)} />);
    expect(text()).toMatch(/Passed the cap at .+: Appflare pauses the app on its next check/);
    show(<CapProgress {...base} spent={12} projected={12} paused passedAt={null} />);
    expect(text()).toContain("Passed the cap and was paused, so nothing more is being spent.");
  });
});

describe("LoopNow", () => {
  const quiet = { money: false, abnormal: false, trips: false };

  it("tells where one app stands against the loop check", () => {
    show(<LoopNow plan="paid" paused={false} burnPerHour={0.02} ratio={1.2} check={quiet} />);
    expect(text()).toBe("Right now: $0.02 an hour, 1.2× its normal. Fine.");
    show(
      <LoopNow
        plan="paid"
        paused={false}
        burnPerHour={3.2}
        ratio={3000}
        check={{ money: true, abnormal: true, trips: true }}
      />,
    );
    expect(text()).toContain("3,000× its normal. Over both, so it pauses on the next check");
    show(
      <LoopNow
        plan="free"
        paused={false}
        burnPerHour={0}
        ratio={null}
        check={{ ...quiet, abnormal: true }}
      />,
    );
    expect(text()).toBe(
      "Right now: no normal yet. Far above normal, but not costing enough to pause.",
    );
    show(<LoopNow plan="paid" paused burnPerHour={0} ratio={null} check={quiet} />);
    expect(text()).toBe("Paused, so nothing to check until it resumes.");
  });
});

describe("TriggerRows", () => {
  it("reads as sentences without handlers, and warns when nothing is a trigger", () => {
    show(
      <TriggerRows
        plan="paid"
        loop={{ on: false, level: "standard" }}
        cap={{ on: true, amount: null, period: "day" }}
      />,
    );
    expect(text()).toContain("Loops: not a trigger");
    expect(text()).toContain("Spending: not a trigger");
    expect(text()).toContain("Nothing is a trigger, so auto-pause never pauses anything.");
  });

  it("passes the live status the level and the cap, for the page to fill in", () => {
    show(
      <TriggerRows
        plan="paid"
        loop={{ on: true, level: "strict" }}
        cap={{ on: true, amount: 2, period: "week" }}
        loopStatus={(level) => <span>loop at {level}</span>}
        capStatus={(amount, period) => (
          <span>
            cap of {amount} per {period}
          </span>
        )}
      />,
    );
    expect(text()).toContain("Over $0.25 an hour and 20× its normal, for 10 minutes.");
    expect(text()).toContain("loop at strict");
    expect(text()).toContain("cap of 2 per week");
  });
});

describe("unusual usage choices", () => {
  it("offers off and the three factors, and reads them back", () => {
    expect(UNUSUAL_FACTOR_ITEMS.map((i) => i.label)).toEqual([
      "Don't alert",
      "At 5× its normal",
      "At 20× its normal",
      "At 100× its normal",
    ]);
    expect(unusualFactorOf("100")).toBe(100);
    expect(unusualFactorOf("0")).toBe(0);
    expect(unusualFactorOf("7")).toBeNull();
  });
});
