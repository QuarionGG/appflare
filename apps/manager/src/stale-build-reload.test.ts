import { describe, expect, it } from "vitest";
import {
  installStaleBuildReload,
  isStaleBuildError,
  PRELOAD_ERROR_EVENT,
  reloadForNewBuild,
  STALE_BUILD_RELOAD_KEY,
  STALE_BUILD_RELOAD_WINDOW_MS,
  type StaleBuildReloadDeps,
} from "./stale-build-reload";

/** A tab: its session storage, a clock, and the reloads it did. */
function tab(storage: Map<string, string> | null = new Map()) {
  let clock = 1_000_000;
  const reloads: number[] = [];
  const deps: StaleBuildReloadDeps = {
    storage: () =>
      storage === null
        ? null
        : {
            getItem: (key) => storage.get(key) ?? null,
            setItem: (key, value) => void storage.set(key, value),
          },
    reload: () => reloads.push(clock),
    now: () => clock,
  };
  return {
    deps,
    reloads,
    storage,
    advance: (ms: number) => {
      clock += ms;
    },
  };
}

describe("reloadForNewBuild", () => {
  it("reloads the first time and records when", () => {
    const t = tab();
    expect(reloadForNewBuild(t.deps)).toBe(true);
    expect(t.reloads).toHaveLength(1);
    expect(t.storage?.get(STALE_BUILD_RELOAD_KEY)).toBe("1000000");
  });

  it("does not reload again while the failure persists right after a reload", () => {
    const t = tab();
    expect(reloadForNewBuild(t.deps)).toBe(true);
    // The reloaded page fails again (an outage): no loop.
    t.advance(2_000);
    expect(reloadForNewBuild(t.deps)).toBe(false);
    t.advance(STALE_BUILD_RELOAD_WINDOW_MS - 2_001);
    expect(reloadForNewBuild(t.deps)).toBe(false);
    expect(t.reloads).toHaveLength(1);
  });

  it("reloads again for a later update in the same tab", () => {
    const t = tab();
    reloadForNewBuild(t.deps);
    t.advance(STALE_BUILD_RELOAD_WINDOW_MS);
    expect(reloadForNewBuild(t.deps)).toBe(true);
    expect(t.reloads).toHaveLength(2);
  });

  it("never reloads without a usable session storage", () => {
    expect(reloadForNewBuild(tab(null).deps)).toBe(false);
    const throwing = tab();
    throwing.deps.storage = () => {
      throw new Error("SecurityError");
    };
    expect(reloadForNewBuild(throwing.deps)).toBe(false);
    const full = tab();
    const inner = full.deps.storage();
    full.deps.storage = () => ({
      getItem: (key) => inner?.getItem(key) ?? null,
      setItem: () => {
        throw new Error("QuotaExceededError");
      },
    });
    expect(reloadForNewBuild(full.deps)).toBe(false);
    expect([...throwing.reloads, ...full.reloads]).toEqual([]);
  });

  it("ignores a stored value it cannot read", () => {
    const t = tab(new Map([[STALE_BUILD_RELOAD_KEY, "garbage"]]));
    expect(reloadForNewBuild(t.deps)).toBe(true);
  });
});

describe("installStaleBuildReload", () => {
  it("reloads once on Vite's preload error, however often it fires and is installed", () => {
    const t = tab();
    const target = new EventTarget();
    installStaleBuildReload(target, t.deps);
    installStaleBuildReload(target, t.deps);
    target.dispatchEvent(new Event(PRELOAD_ERROR_EVENT, { cancelable: true }));
    target.dispatchEvent(new Event(PRELOAD_ERROR_EVENT, { cancelable: true }));
    expect(t.reloads).toHaveLength(1);
  });

  it("leaves the error to the import's caller", () => {
    const target = new EventTarget();
    installStaleBuildReload(target, tab().deps);
    const event = new Event(PRELOAD_ERROR_EVENT, { cancelable: true });
    target.dispatchEvent(event);
    expect(event.defaultPrevented).toBe(false);
  });

  it("does nothing for other events", () => {
    const t = tab();
    const target = new EventTarget();
    installStaleBuildReload(target, t.deps);
    target.dispatchEvent(new Event("error"));
    expect(t.reloads).toEqual([]);
  });
});

describe("isStaleBuildError", () => {
  it("recognises a failed import in each browser, and a failed stylesheet preload", () => {
    for (const message of [
      "Failed to fetch dynamically imported module: https://a.example/assets/x-1.js",
      "error loading dynamically imported module: https://a.example/assets/x-1.js",
      "Importing a module script failed.",
      "Unable to preload CSS for /assets/x-1.css",
    ]) {
      expect(isStaleBuildError(new TypeError(message))).toBe(true);
    }
  });

  it("is false for anything else", () => {
    expect(isStaleBuildError(new Error("The catalog is unreachable."))).toBe(false);
    expect(isStaleBuildError("Failed to fetch dynamically imported module")).toBe(false);
    expect(isStaleBuildError(undefined)).toBe(false);
  });
});
