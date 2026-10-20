import { describe, expect, it } from "vitest";
import {
  compareStableVersions,
  directDependencies,
  lockedEmdashVersion,
  prepareEmdashUpgradeInput,
  stableVersion,
} from "./emdash-upgrades";

describe("EmDash upgrade metadata", () => {
  it("selects stable releases and compares numeric version parts", () => {
    expect(stableVersion("1.3.0")).toBe("1.3.0");
    for (const value of ["latest", "^1.3.0", "1.3.0-rc.1", "1.3.0;whoami", null])
      expect(stableVersion(value)).toBeNull();
    expect(compareStableVersions("1.10.0", "1.9.9")).toBe(1);
    expect(compareStableVersions("1.3.0", "1.3.0")).toBe(0);
    expect(compareStableVersions("1.2.9", "1.3.0")).toBe(-1);
  });

  it("reads locked versions instead of treating a dependency range as the installed release", () => {
    const pkg = { dependencies: { emdash: "^1.1.0" } };
    expect(lockedEmdashVersion(null, pkg)).toBeNull();
    expect(
      lockedEmdashVersion(
        "importers:\n  .:\n    dependencies:\n      emdash:\n        specifier: ^1.1.0\n        version: 1.3.0(astro@7.0.0)\npackages:\n",
        pkg,
      ),
    ).toBe("1.3.0");
    expect(
      lockedEmdashVersion(
        JSON.stringify({ packages: { "node_modules/emdash": { version: "1.2.0" } } }),
        pkg,
      ),
    ).toBe("1.2.0");
    expect(lockedEmdashVersion(null, { dependencies: { emdash: "1.3.0" } })).toBe("1.3.0");
  });

  it("retains custom plugin declarations alongside core dependency metadata", () => {
    expect(
      directDependencies({
        dependencies: { emdash: "^1.1.0", "@orangecrm/emdash": "file:vendor/plugin.tgz" },
        devDependencies: { "@emdash-cms/plugin-test": "1.2.3" },
      }),
    ).toEqual({
      emdash: "^1.1.0",
      "@orangecrm/emdash": "file:vendor/plugin.tgz",
      "@emdash-cms/plugin-test": "1.2.3",
    });
    expect(directDependencies(null)).toEqual({});
  });

  it("requires a checked commit and an exact stable target for preparation", () => {
    expect(
      prepareEmdashUpgradeInput.safeParse({
        installId: "blog",
        expectedBaseSha: "a".repeat(40),
        targetVersion: "1.3.0",
        costConfirmed: true,
      }).success,
    ).toBe(true);
    expect(
      prepareEmdashUpgradeInput.safeParse({
        installId: "blog",
        expectedBaseSha: "main",
        targetVersion: "latest",
        costConfirmed: true,
      }).success,
    ).toBe(false);
  });
});
