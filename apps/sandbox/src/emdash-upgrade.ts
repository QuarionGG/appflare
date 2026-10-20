import {
  buildKeys,
  DEFAULT_SANDBOX_INSTANCE_TYPE,
  EMDASH_UPGRADE_FILE_BYTES,
  type EmdashUpgradeOutcome,
  emdashMigrationIdentitySchema,
  emdashUpgradeOutcomeSchema,
  emdashUpgradeRequestSchema,
  emdashVersionSatisfies,
} from "@appflare/schema";
import { z } from "zod";
import { EMDASH_UPGRADE_SCRIPT, validateDerivedEmdashManifest } from "./emdash-upgrade-script";
import { gitTokenEnv, tokenRedactions } from "./github";
import { BuildLog } from "./log";
import {
  BUILD_COMMAND_ENV,
  BUILD_ENV,
  cloneUrl,
  commandLine,
  installArgv,
  LOG_FLUSH_INTERVAL_MS,
  repositorySandboxId,
  SOURCE_DIR,
  STAGE_TIMEOUTS,
  shellQuote,
  WORK_ROOT,
} from "./protocol";
import type { RepositoryBuildDeps } from "./repository";
import type { BuildSandbox } from "./sandbox";
import { CommandRunner, messageOf } from "./steps";

const SCRIPT = `${WORK_ROOT}/emdash-upgrade.mjs`;
const FILES = ["package.json", "pnpm-lock.yaml"] as const;
const CHUNK_BYTES = 65_536;
const MAX_LOG_TAIL = 200_000;
const pluginFactsSchema = z.object({
  name: z.string().min(1).max(200),
  version: z.string().max(200),
  ranges: z.array(z.string().max(512)).max(4),
});
const beforeSchema = z.object({
  fromVersion: z.string().min(1).max(100),
  identity: emdashMigrationIdentitySchema,
  plugins: z.array(pluginFactsSchema).max(200),
});
const afterSchema = z.object({
  before: beforeSchema,
  afterMigrations: emdashMigrationIdentitySchema,
  plugins: z.array(pluginFactsSchema).max(200),
  derivedManifest: z
    .object({
      originalText: z.string().max(65_536),
      generatedText: z.string().max(65_536),
    })
    .nullable()
    .default(null),
  sizes: z.object({
    "package.json": z.int().positive().max(EMDASH_UPGRADE_FILE_BYTES),
    "pnpm-lock.yaml": z.int().positive().max(EMDASH_UPGRADE_FILE_BYTES),
  }),
});

/** Validate the proposed commit separately from anything a project build did. */
export function validateEmdashPackageChange(
  originalText: string,
  updatedText: string,
  targetVersion: string,
): void {
  const original: unknown = JSON.parse(originalText);
  const updated: unknown = JSON.parse(updatedText);
  if (
    original === null ||
    updated === null ||
    typeof original !== "object" ||
    typeof updated !== "object" ||
    Array.isArray(original) ||
    Array.isArray(updated)
  ) {
    throw new Error("package.json must be an object");
  }
  const expected = structuredClone(original) as Record<string, unknown>;
  for (const name of ["emdash", "@emdash-cms/cloudflare"]) {
    const sections = ["dependencies", "devDependencies", "optionalDependencies"].filter(
      (section) => {
        const entries = expected[section];
        return entries !== null && typeof entries === "object" && Object.hasOwn(entries, name);
      },
    );
    if (sections.length !== 1) throw new Error(`${name} must be a direct dependency exactly once`);
    const entries = expected[sections[0] as string] as Record<string, unknown>;
    const value = entries[name];
    if (typeof value !== "string" || !/^[~^]?\d+\.\d+\.\d+$/.test(value)) {
      throw new Error(`${name} must use a stable exact, caret or tilde version`);
    }
    entries[name] = `${/^[~^]/.exec(value)?.[0] ?? ""}${targetVersion}`;
  }
  // Object order and formatting are immaterial; scripts and all other values are not.
  function sorted(value: unknown): unknown {
    if (Array.isArray(value)) return value.map(sorted);
    if (value !== null && typeof value === "object") {
      return Object.fromEntries(
        Object.entries(value)
          .sort(([a], [b]) => a.localeCompare(b))
          .map(([key, item]) => [key, sorted(item)]),
      );
    }
    return value;
  }
  if (JSON.stringify(sorted(expected)) !== JSON.stringify(sorted(updated))) {
    throw new Error("package.json changed beyond the two approved EmDash dependency versions");
  }
}

export function checkEmdashPlugins(plugins: z.infer<typeof pluginFactsSchema>[], target: string) {
  return plugins.map((plugin) => {
    const constraints = plugin.ranges.map((range) => emdashVersionSatisfies(target, range));
    if (constraints.some((result) => result !== true)) {
      throw new Error(
        `${plugin.name}@${plugin.version} does not declare compatibility with EmDash ${target} (${plugin.ranges.join(" and ")})`,
      );
    }
    return {
      name: plugin.name,
      version: plugin.version,
      range: plugin.ranges.length === 0 ? null : plugin.ranges.join(" and "),
      compatible: plugin.ranges.length === 0 ? null : true,
    };
  });
}

/** A migration list must extend the known ordered set; downgrades need manual review. */
export function addedEmdashMigrations(
  before: readonly string[],
  after: readonly string[],
): string[] {
  if (before.some((name, index) => after[index] !== name)) {
    throw new Error("The target changes or removes existing core migrations; review it manually");
  }
  return after.slice(before.length);
}

function parsedJson<T>(text: string, schema: z.ZodType<T>): T {
  return schema.parse(JSON.parse(text));
}

/**
 * Prepare two dependency files, not a deployment artifact. The trusted Worker
 * persists them as a reviewable commit before a normal pinned source build.
 * No Cloudflare credential, site secret or GitHub write token enters this run.
 */
export async function prepareEmdashUpgrade(
  input: unknown,
  deps: RepositoryBuildDeps,
): Promise<EmdashUpgradeOutcome> {
  const parsed = emdashUpgradeRequestSchema.safeParse(input);
  if (!parsed.success) {
    return { ok: false, error: "The EmDash upgrade request is invalid", logTail: "" };
  }
  const request = parsed.data;
  const now = deps.now ?? Date.now;
  const log = new BuildLog({
    bucket: deps.bucket,
    key: buildKeys(request.installId, request.runId, "_").log,
    now,
    flushIntervalMs: deps.flushIntervalMs ?? LOG_FLUSH_INTERVAL_MS,
  });
  let sandbox: BuildSandbox | null = null;
  let outcome: EmdashUpgradeOutcome;
  try {
    let token: string | null = null;
    if (request.githubTokenSecret !== undefined) {
      token = deps.githubToken?.(request.githubTokenSecret) ?? null;
      if (token === null) throw new Error("The sandbox does not hold the repository read token");
      log.redact(tokenRedactions(token));
    }
    sandbox = deps.openSandbox(
      `${await repositorySandboxId(request.runId)}-upgrade`,
      DEFAULT_SANDBOX_INSTANCE_TYPE,
    );
    const steps = new CommandRunner(sandbox, log);
    const runScript = async (mode: string, args: string[] = []) => {
      const result = await steps.run("detect", commandLine(["node", SCRIPT, mode, ...args]), {
        cwd: SOURCE_DIR,
        timeoutMs: STAGE_TIMEOUTS.quick,
        quiet: true,
      });
      return result.stdout;
    };
    const readFile = async (file: (typeof FILES)[number]): Promise<string> => {
      const decoder = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true });
      let content = "";
      for (let offset = 0; offset < EMDASH_UPGRADE_FILE_BYTES; offset += CHUNK_BYTES) {
        const encoded = parsedJson(
          await runScript("read", [file, String(offset)]),
          z
            .string()
            .max(100_000)
            .regex(/^[A-Za-z0-9+/]*={0,2}$/),
        );
        const bytes = Uint8Array.from(atob(encoded), (character) => character.charCodeAt(0));
        if (bytes.length > CHUNK_BYTES)
          throw new Error("The sandbox returned an oversized file chunk");
        content += decoder.decode(bytes, { stream: true });
        if (bytes.length < CHUNK_BYTES) break;
      }
      return content + decoder.decode();
    };

    await log.stage("checkout", `Reading ${request.repo} at ${request.baseSha}`);
    const src = shellQuote(SOURCE_DIR);
    await steps.run(
      "checkout",
      [
        `rm -rf ${shellQuote(WORK_ROOT)}`,
        `mkdir -p ${shellQuote(WORK_ROOT)}`,
        `git init -q ${src}`,
        `git -C ${src} remote add origin ${shellQuote(cloneUrl(request.repo))}`,
        `git -C ${src} fetch -q --depth 1 origin ${request.baseSha}`,
        `git -C ${src} checkout -q --detach FETCH_HEAD`,
      ].join(" && "),
      {
        timeoutMs: STAGE_TIMEOUTS.checkout,
        env: token === null ? BUILD_ENV : { ...BUILD_ENV, ...gitTokenEnv(token) },
        failure: "The pinned repository commit could not be read",
      },
    );
    const head = await steps.run("checkout", `git -C ${src} rev-parse HEAD`, {
      timeoutMs: STAGE_TIMEOUTS.quick,
      quiet: true,
    });
    if (head.stdout.trim() !== request.baseSha)
      throw new Error("The checkout differs from the approved base commit");
    await sandbox.writeFile(SCRIPT, EMDASH_UPGRADE_SCRIPT);
    await log.stage("detect", "Checking the root pnpm project");
    await runScript("preflight");
    const originalPackage = await readFile("package.json");

    await log.stage("install", "Installing the current lockfile, dependency scripts disabled");
    const installOptions = { cwd: SOURCE_DIR, timeoutMs: STAGE_TIMEOUTS.install };
    await steps.run("install", commandLine(installArgv("pnpm")), installOptions);
    const before = parsedJson(await runScript("before"), beforeSchema);
    if (emdashVersionSatisfies(request.targetVersion, `>${before.fromVersion}`) !== true) {
      throw new Error("The approved target must be newer than the installed EmDash version");
    }
    if (before.identity.emdashVersion !== before.fromVersion)
      throw new Error("The original migration identity does not match EmDash");
    checkEmdashPlugins(before.plugins, request.targetVersion);

    await log.stage("install", `Preparing EmDash and Cloudflare adapter ${request.targetVersion}`);
    await runScript("mutate", [request.targetVersion]);
    await steps.run(
      "install",
      commandLine([
        "pnpm",
        "install",
        "--lockfile-only",
        "--ignore-scripts",
        "--config.package-manager-strict=false",
      ]),
      installOptions,
    );
    await steps.run("install", commandLine(installArgv("pnpm")), installOptions);
    await log.stage("build", "Building the upgraded project without site credentials");
    await steps.run("build", "pnpm run build", {
      cwd: SOURCE_DIR,
      timeoutMs: STAGE_TIMEOUTS.build,
      env: BUILD_COMMAND_ENV,
      failure: "The upgraded project did not build; no repository or deployed app was changed",
    });

    await log.stage(
      "verify",
      "Verifying preserved sources, plugin requirements and core migrations",
    );
    const after = parsedJson(await runScript("after", [request.targetVersion]), afterSchema);
    if (JSON.stringify(after.before) !== JSON.stringify(before))
      throw new Error("The original upgrade metadata changed during the build");
    if (after.afterMigrations.emdashVersion !== request.targetVersion)
      throw new Error("The target migration identity does not match EmDash");
    if (after.derivedManifest !== null) {
      validateDerivedEmdashManifest(
        after.derivedManifest.originalText,
        after.derivedManifest.generatedText,
        after.afterMigrations,
      );
      await runScript("restore-derived");
    }
    await runScript("verify-diff");
    const plugins = checkEmdashPlugins(after.plugins, request.targetVersion);
    const addedMigrations = addedEmdashMigrations(
      before.identity.names,
      after.afterMigrations.names,
    );
    const files = await Promise.all(
      FILES.map(async (path) => ({ path, content: await readFile(path) })),
    );
    for (const file of files) {
      if (new TextEncoder().encode(file.content).length !== after.sizes[file.path]) {
        throw new Error(`The returned ${file.path} is incomplete`);
      }
    }
    validateEmdashPackageChange(originalPackage, files[0]?.content ?? "", request.targetVersion);
    outcome = emdashUpgradeOutcomeSchema.parse({
      ok: true,
      baseSha: request.baseSha,
      targetVersion: request.targetVersion,
      files,
      report: {
        fromVersion: before.fromVersion,
        targetVersion: request.targetVersion,
        plugins,
        beforeMigrations: before.identity,
        afterMigrations: after.afterMigrations,
        addedMigrations,
        preservedPaths: ["theme", "plugins", "configuration"],
        buildVerified: true,
      },
    });
    log.line(
      "Prepared package.json and pnpm-lock.yaml. Theme, plugins and configuration are unchanged.",
    );
    log.line(`${addedMigrations.length} added core migrations; no database was contacted.`);
  } catch (error) {
    const message = log.scrub(messageOf(error)).slice(0, 4000);
    log.line(`FAILED: ${message}`);
    outcome = { ok: false, error: message, logTail: "" };
  }
  if (sandbox !== null) {
    try {
      await sandbox.destroy();
    } catch {
      log.line("Stopping the build container failed; its idle timeout will stop it.");
    }
  }
  try {
    await log.finish(outcome.ok ? "succeeded" : "failed");
  } catch {
    // The outcome still carries the log if R2 progress could not be written.
  }
  return { ...outcome, logTail: log.text.slice(-MAX_LOG_TAIL) };
}
