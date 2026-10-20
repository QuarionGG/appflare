import { reset } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { SANDBOX_PROTOCOL_VERSION } from "@appflare/schema";
import { afterEach, describe, expect, it } from "vitest";
import {
  addedEmdashMigrations,
  checkEmdashPlugins,
  prepareEmdashUpgrade,
  validateEmdashPackageChange,
} from "./emdash-upgrade";
import { validateDerivedEmdashManifest } from "./emdash-upgrade-script";
import { gitTokenEnv } from "./github";
import { BUILD_COMMAND_ENV, BUILD_ENV } from "./protocol";
import type { BuildSandbox, ExecOptions, ExecOutcome } from "./sandbox";

const BASE = "0123456789abcdef0123456789abcdef01234567";
const TOKEN = "github_pat_read_only_test_credential";
const original = {
  name: "custom-blog",
  packageManager: "pnpm@10.34.1",
  scripts: { build: "astro build", deploy: "wrangler deploy" },
  dependencies: {
    emdash: "^1.1.0",
    "@emdash-cms/cloudflare": "~1.1.0",
    "@orangecrm/emdash": "file:vendor/orangecrm-emdash.tgz",
  },
};
const upgraded = {
  ...original,
  dependencies: {
    ...original.dependencies,
    emdash: "^1.3.0",
    "@emdash-cms/cloudflare": "~1.3.0",
  },
};
const before = {
  fromVersion: "1.1.0",
  identity: { emdashVersion: "1.1.0", names: ["001_initial"], fingerprint: "a".repeat(64) },
  plugins: [{ name: "@orangecrm/emdash", version: "0.1.0", ranges: [">=1.1.0 <2"] }],
};
const lockfile = `lockfileVersion: '9.0'\n#${"a".repeat(65_510)}è${"b".repeat(240_000)}\n`;

/** Simulates process output, including a lockfile larger than one SDK response. */
class UpgradeSandbox implements BuildSandbox {
  readonly calls: Array<{ command: string; options: ExecOptions }> = [];
  readonly writes = new Map<string, string>();
  destroyed = false;
  mutated = false;
  constructor(
    readonly failure: RegExp | null = null,
    readonly reportedBase = BASE,
    readonly originalFacts = before,
    readonly derivedManifest: { originalText: string; generatedText: string } | null = null,
  ) {}
  async gitCheckout(): Promise<void> {
    throw new Error("The upgrade must pin git fetch explicitly");
  }
  async mountBucket(): Promise<void> {
    throw new Error("An upgrade must not mount artifact output");
  }
  async unmountBucket(): Promise<void> {
    throw new Error("An upgrade must not mount artifact output");
  }
  async destroy(): Promise<void> {
    this.destroyed = true;
  }
  async writeFile(path: string, content: string): Promise<void> {
    this.writes.set(path, content);
  }
  async exec(command: string, options: ExecOptions): Promise<ExecOutcome> {
    this.calls.push({ command, options });
    if (this.failure?.test(command)) {
      options.onOutput(`failure ${TOKEN}`);
      return { exitCode: 1, stdout: "", stderr: `failure ${TOKEN}` };
    }
    let stdout = "";
    if (command.includes("rev-parse HEAD")) stdout = `${this.reportedBase}\n`;
    else if (command.endsWith(" before")) stdout = JSON.stringify(this.originalFacts);
    else if (command.includes(" mutate ")) this.mutated = true;
    else if (command.includes(" after ")) {
      stdout = JSON.stringify({
        before: this.originalFacts,
        plugins: this.originalFacts.plugins,
        afterMigrations: {
          emdashVersion: "1.3.0",
          names: ["001_initial", "002_update"],
          fingerprint: "b".repeat(64),
        },
        derivedManifest: this.derivedManifest,
        sizes: {
          "package.json": new TextEncoder().encode(JSON.stringify(upgraded)).length,
          "pnpm-lock.yaml": new TextEncoder().encode(lockfile).length,
        },
      });
    } else {
      const match = / read (package\.json|pnpm-lock\.yaml) (\d+)$/.exec(command);
      if (match) {
        const content =
          match[1] === "package.json"
            ? JSON.stringify(this.mutated ? upgraded : original)
            : lockfile;
        const bytes = new TextEncoder()
          .encode(content)
          .subarray(Number(match[2]), Number(match[2]) + 65_536);
        stdout = JSON.stringify(
          btoa(Array.from(bytes, (byte) => String.fromCharCode(byte)).join("")),
        );
      }
    }
    return { exitCode: 0, stdout, stderr: "" };
  }
}

function request(extra: Record<string, unknown> = {}) {
  return {
    protocol: SANDBOX_PROTOCOL_VERSION,
    installId: "01J8REPOINSTALL",
    runId: "01J8UPGRADEJOB",
    repo: "QuarionGG/quariongg-emdash-demo",
    baseSha: BASE,
    targetVersion: "1.3.0",
    githubTokenSecret: "GITHUB_TOKEN_01J8READTOKEN",
    ...extra,
  };
}
function run(sandbox: UpgradeSandbox, input = request()) {
  return prepareEmdashUpgrade(input, {
    bucket: env.BUILDS,
    sandboxVersion: "0.1.7",
    openSandbox: () => sandbox,
    githubToken: () => TOKEN,
  });
}

afterEach(() => reset());

describe("dependency-only EmDash changes", () => {
  it("accepts only the derived migration identity, preserving database and site configuration", () => {
    const original = {
      schemaVersion: 1,
      emdashVersion: "1.1.0",
      migrationSet: { names: ["001_initial"], fingerprint: "a".repeat(64) },
      database: { type: "sqlite", executorConfig: { binding: "DB" } },
      i18n: { defaultLocale: "it", locales: ["it"] },
    };
    const identity = {
      emdashVersion: "1.3.0",
      names: ["001_initial", "002_update"],
      fingerprint: "b".repeat(64),
    };
    const generated = {
      ...original,
      emdashVersion: "1.3.0",
      migrationSet: { names: identity.names, fingerprint: identity.fingerprint },
    };
    expect(() =>
      validateDerivedEmdashManifest(JSON.stringify(original), JSON.stringify(generated), identity),
    ).not.toThrow();
    for (const tampered of [
      {
        ...generated,
        database: { ...generated.database, executorConfig: { binding: "OTHER_DB" } },
      },
      { ...generated, i18n: null },
      { ...generated, additionalConfig: true },
      { ...generated, migrationSet: { ...generated.migrationSet, names: ["001_initial"] } },
      { ...generated, migrationSet: { ...generated.migrationSet, fingerprint: "c".repeat(64) } },
    ]) {
      expect(() =>
        validateDerivedEmdashManifest(JSON.stringify(original), JSON.stringify(tampered), identity),
      ).toThrow();
    }
  });
  it("keeps theme/plugin configuration and existing range styles", () => {
    expect(() =>
      validateEmdashPackageChange(JSON.stringify(original), JSON.stringify(upgraded), "1.3.0"),
    ).not.toThrow();
    const orderedDifferently = Object.fromEntries(Object.entries(upgraded).reverse());
    expect(() =>
      validateEmdashPackageChange(
        JSON.stringify(original),
        JSON.stringify(orderedDifferently),
        "1.3.0",
      ),
    ).not.toThrow();
  });
  it("refuses custom plugin, script and unrelated configuration changes", () => {
    for (const altered of [
      { ...upgraded, scripts: { build: "download-other-theme" } },
      { ...upgraded, dependencies: { ...upgraded.dependencies, "@orangecrm/emdash": "latest" } },
      { ...upgraded, overrides: { emdash: "1.3.0" } },
      { ...upgraded, dependencies: { ...upgraded.dependencies, emdash: "1.3.0" } },
    ]) {
      expect(() =>
        validateEmdashPackageChange(JSON.stringify(original), JSON.stringify(altered), "1.3.0"),
      ).toThrow();
    }
  });
  it("rejects aliases and ambiguous duplicate dependencies", () => {
    expect(() =>
      validateEmdashPackageChange(
        JSON.stringify({ ...original, devDependencies: { emdash: "1.1.0" } }),
        JSON.stringify(upgraded),
        "1.3.0",
      ),
    ).toThrow();
    expect(() =>
      validateEmdashPackageChange(
        JSON.stringify({
          ...original,
          dependencies: { ...original.dependencies, emdash: "npm:emdash@1.1.0" },
        }),
        JSON.stringify(upgraded),
        "1.3.0",
      ),
    ).toThrow();
  });
  it("blocks declared incompatible or unreadable plugin ranges", () => {
    expect(checkEmdashPlugins(before.plugins, "1.3.0")[0]?.compatible).toBe(true);
    expect(() => checkEmdashPlugins(before.plugins, "2.0.0")).toThrow(/orangecrm/);
    expect(() =>
      checkEmdashPlugins([{ name: "custom", version: "1", ranges: ["not-a-range"] }], "1.3.0"),
    ).toThrow();
    expect(
      checkEmdashPlugins([{ name: "custom", version: "1", ranges: [] }], "1.3.0")[0]?.compatible,
    ).toBeNull();
  });
  it("requires core migrations to extend the existing ordered identity", () => {
    expect(addedEmdashMigrations(["001_initial"], ["001_initial", "002_update"])).toEqual([
      "002_update",
    ]);
    expect(() => addedEmdashMigrations(["001_initial"], [])).toThrow();
    expect(() =>
      addedEmdashMigrations(["001_initial", "002_other"], ["001_initial", "002_update"]),
    ).toThrow();
  });
});

describe("prepareEmdashUpgrade", () => {
  it("restores only a verified generated migration manifest before the final diff check", async () => {
    const originalManifest = {
      schemaVersion: 1,
      emdashVersion: "1.1.0",
      migrationSet: { names: ["001_initial"], fingerprint: "a".repeat(64) },
      database: { executorConfig: { binding: "DB" } },
      i18n: null,
    };
    const generatedManifest = {
      ...originalManifest,
      emdashVersion: "1.3.0",
      migrationSet: { names: ["001_initial", "002_update"], fingerprint: "b".repeat(64) },
    };
    const sandbox = new UpgradeSandbox(null, BASE, before, {
      originalText: JSON.stringify(originalManifest),
      generatedText: JSON.stringify(generatedManifest),
    });
    const result = await run(sandbox);
    expect(result.ok, result.ok ? "" : result.error).toBe(true);
    const restore = sandbox.calls.findIndex((call) => call.command.endsWith(" restore-derived"));
    const verify = sandbox.calls.findIndex((call) => call.command.endsWith(" verify-diff"));
    expect(restore).toBeGreaterThan(0);
    expect(verify).toBeGreaterThan(restore);
    const tampered = new UpgradeSandbox(null, BASE, before, {
      originalText: JSON.stringify(originalManifest),
      generatedText: JSON.stringify({
        ...generatedManifest,
        database: { executorConfig: { binding: "OTHER_DB" } },
      }),
    });
    expect((await run(tampered)).ok).toBe(false);
    expect(tampered.calls.some((call) => call.command.endsWith(" restore-derived"))).toBe(false);
  });
  it("returns a verified patch without deploying, credentials only on the git fetch", async () => {
    const sandbox = new UpgradeSandbox();
    const result = await run(sandbox);
    expect(result.ok, result.ok ? "" : result.error).toBe(true);
    if (!result.ok) return;
    expect(result.baseSha).toBe(BASE);
    expect(result.files.find((file) => file.path === "pnpm-lock.yaml")?.content).toBe(lockfile);
    expect(result.report).toMatchObject({
      fromVersion: "1.1.0",
      targetVersion: "1.3.0",
      addedMigrations: ["002_update"],
      preservedPaths: ["theme", "plugins", "configuration"],
      buildVerified: true,
    });
    const fetch = sandbox.calls.find((call) => call.command.includes(" fetch "));
    expect(fetch?.options.env).toEqual({ ...BUILD_ENV, ...gitTokenEnv(TOKEN) });
    for (const call of sandbox.calls.filter((call) => call !== fetch)) {
      expect(JSON.stringify(call.options.env ?? BUILD_ENV)).not.toContain(TOKEN);
    }
    expect(sandbox.calls.find((call) => call.command === "pnpm run build")?.options.env).toEqual(
      BUILD_COMMAND_ENV,
    );
    expect(sandbox.calls.map((call) => call.command).join("\n")).not.toMatch(
      /push|wrangler deploy|migrate|appflare-pack/,
    );
    expect(sandbox.calls.filter((call) => call.command.includes("--frozen-lockfile"))).toHaveLength(
      2,
    );
    expect(sandbox.destroyed).toBe(true);
  });
  it("refuses an invalid request before opening a container", async () => {
    const sandbox = new UpgradeSandbox();
    expect((await run(sandbox, request({ targetVersion: "latest" }))).ok).toBe(false);
    expect(sandbox.calls).toHaveLength(0);
  });
  it("refuses a moved checkout and destroys its container", async () => {
    const sandbox = new UpgradeSandbox(null, "f".repeat(40));
    expect((await run(sandbox)).ok).toBe(false);
    expect(sandbox.calls.some((call) => call.command.includes("pnpm install"))).toBe(false);
    expect(sandbox.destroyed).toBe(true);
  });
  it("stops on incompatible plugins before changing dependency files", async () => {
    const sandbox = new UpgradeSandbox(null, BASE, {
      ...before,
      plugins: [{ name: "custom", version: "1.0.0", ranges: ["<1.2.0"] }],
    });
    const result = await run(sandbox);
    expect(result.ok).toBe(false);
    expect(sandbox.mutated).toBe(false);
    expect(sandbox.destroyed).toBe(true);
  });
  it("reports a failed build without leaking the repository token or writing GitHub", async () => {
    const sandbox = new UpgradeSandbox(/^pnpm run build$/);
    const result = await run(sandbox);
    expect(result.ok).toBe(false);
    expect(JSON.stringify(result)).not.toContain(TOKEN);
    expect(result.logTail).toContain("[redacted]");
    expect(sandbox.destroyed).toBe(true);
  });
});
