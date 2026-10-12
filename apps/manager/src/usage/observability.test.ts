import { NonRetryableError } from "cloudflare:workflows";
import { CloudflareApiError, type ScriptSettings } from "@appflare/cf-api";
import { describe, expect, it } from "vitest";
import { toStepError } from "../jobs/errors";
import { LOGS_OFF, LOGS_ON } from "../test/workers-logs";
import {
  ObservabilityReadError,
  observabilityToCarry,
  type WorkersApi,
  withCarriedObservability,
  workersLogsOn,
} from "./observability";
import { observabilityToCarryInStep } from "./observability-keep";

/** A Workers API whose script-settings read answers `answer` (or throws it). */
function api(answer: ScriptSettings | Error): WorkersApi & { reads: string[] } {
  const reads: string[] = [];
  const workers = {
    getScriptSettings: async (name: string) => {
      reads.push(name);
      if (answer instanceof Error) throw answer;
      return answer;
    },
  };
  return { workers, reads } as unknown as WorkersApi & { reads: string[] };
}

const refused = (status: number, code: number, message: string) =>
  new CloudflareApiError({
    status,
    method: "GET",
    path: "/accounts/a/workers/scripts/cut/script-settings",
    errors: [{ code, message }],
  });

const NOT_FOUND = refused(404, 10007, "This Worker does not exist on your account.");
const MANIFEST = { enabled: true };

describe("the Workers Logs setting a deploy carries", () => {
  it("is the one the Worker has, on or off, whatever the app's own says", async () => {
    for (const setting of [LOGS_ON, LOGS_OFF]) {
      const a = api({ observability: setting });
      expect(await observabilityToCarry(a, "cut", MANIFEST)).toEqual(setting);
      expect(a.reads).toEqual(["cut"]);
    }
  });

  it("is none for a Worker that never had it, and the app's own for a new Worker", async () => {
    expect(await observabilityToCarry(api({ observability: null }), "cut", MANIFEST)).toBeNull();
    expect(await observabilityToCarry(api({}), "cut", MANIFEST)).toBeNull();
    expect(await observabilityToCarry(api(NOT_FOUND), "cut", MANIFEST)).toEqual(MANIFEST);
    expect(await observabilityToCarry(api(NOT_FOUND), "cut", undefined)).toBeNull();
  });

  it("fails, keeping Cloudflare's error, when the setting cannot be read", async () => {
    for (const cause of [
      refused(500, 10013, "internal error"),
      refused(403, 10000, "Authentication error"),
      new TypeError("fetch failed"),
    ]) {
      const error = await observabilityToCarry(api(cause), "cut", MANIFEST).catch((e) => e);
      expect(error).toBeInstanceOf(ObservabilityReadError);
      expect(error.cause).toBe(cause);
      expect(error.scriptName).toBe("cut");
      expect(error.subject).toBe(
        "Appflare could not read whether Workers Logs are on for cut, and deploying it without that setting would turn them off, so nothing was deployed",
      );
      expect(error.message).toBe(`${error.subject} (${cause.message})`);
    }
  });

  it("replaces the metadata's own block, or leaves it out, and keeps the rest", async () => {
    const metadata = { main_module: "worker.js", bindings: [], observability: MANIFEST };
    expect(
      await withCarriedObservability(api({ observability: LOGS_OFF }), "cut", metadata),
    ).toEqual({ main_module: "worker.js", bindings: [], observability: LOGS_OFF });
    expect(await withCarriedObservability(api({ observability: null }), "cut", metadata)).toEqual({
      main_module: "worker.js",
      bindings: [],
    });
    expect(await withCarriedObservability(api(NOT_FOUND), "cut", metadata)).toEqual(metadata);
    // The input is left as it was.
    expect(metadata.observability).toBe(MANIFEST);
  });
});

describe("workersLogsOn", () => {
  it("is on only when observability and its logs are", () => {
    expect(workersLogsOn(LOGS_ON)).toBe(true);
    expect(workersLogsOn({ enabled: true })).toBe(true);
    expect(workersLogsOn(LOGS_OFF)).toBe(false);
    expect(workersLogsOn({ ...LOGS_ON, logs: { enabled: false, invocation_logs: true } })).toBe(
      false,
    );
    expect(workersLogsOn(null)).toBe(false);
    expect(workersLogsOn(undefined)).toBe(false);
  });
});

describe("the carried block inside a job step", () => {
  it("is the same block, and a failed read stops the step for a refusal, retries otherwise", async () => {
    expect(await observabilityToCarryInStep(api({ observability: LOGS_ON }), "cut", null)).toEqual(
      LOGS_ON,
    );
    const final = await observabilityToCarryInStep(
      api(refused(403, 10000, "Authentication error")),
      "cut",
      null,
    ).catch((e: unknown) => e);
    expect(toStepError(final)).toBeInstanceOf(NonRetryableError);
    expect((final as Error).message).toMatch(
      /^Appflare could not read whether Workers Logs are on for cut, .* \(.*403.*\)$/,
    );
    for (const cause of [refused(500, 10013, "internal error"), refused(429, 971, "slow down")]) {
      const retried = await observabilityToCarryInStep(api(cause), "cut", null).catch(
        (e: unknown) => e,
      );
      expect(toStepError(retried)).not.toBeInstanceOf(NonRetryableError);
    }
  });
});
