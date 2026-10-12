import type { WorkerObservability } from "@appflare/cf-api";

/**
 * Test-only: a Worker's Workers Logs setting as Cloudflare reports it
 * (`GET .../script-settings`): turned on (seen live on 2026-10-12), and
 * turned off in the Worker's own configuration, a block with `enabled`
 * false. Turning them off with the switch leaves no block at all (null).
 */

export const LOGS_ON: WorkerObservability = {
  enabled: true,
  head_sampling_rate: 1,
  redact_query_string: false,
  logs: { enabled: true, head_sampling_rate: 1, persist: true, invocation_logs: true },
  traces: { enabled: false, persist: true, head_sampling_rate: 1 },
};

export const LOGS_OFF: WorkerObservability = {
  enabled: false,
  head_sampling_rate: 1,
  redact_query_string: false,
  logs: { enabled: false, head_sampling_rate: 1, persist: true, invocation_logs: true },
  traces: { enabled: false, persist: true, head_sampling_rate: 1 },
};
