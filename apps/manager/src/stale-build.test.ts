import { describe, expect, it } from "vitest";
import { isStaleBuildError } from "./stale-build";

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
