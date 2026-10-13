import { z } from "zod";

/**
 * What a pause changed besides its Workers, as it records it on the pause
 * (`app_pauses.containers_json`, `queues_json`, `workflows_json`) before it
 * changes it, so Resume, or the undo of a pause that failed, puts back
 * exactly that. Something recorded but not changed in the end is put back
 * as it was, which changes nothing.
 */

/** Container applications set to no instances, each with the most it allowed before. */
export const pausedContainersSchema = z.array(
  z.object({
    id: z.string().min(1),
    name: z.string(),
    maxInstances: z.number().int().nonnegative(),
  }),
);
export type PausedContainers = z.infer<typeof pausedContainersSchema>;

/** Queues whose delivery the pause paused (never one that was paused already). */
export const pausedQueuesSchema = z.array(
  z.object({ id: z.string().min(1), name: z.string().min(1) }),
);
export type PausedQueues = z.infer<typeof pausedQueuesSchema>;

/** Workflow instances the pause paused, by Workflow name. */
export const pausedWorkflowsSchema = z.record(z.string().min(1), z.array(z.string().min(1)));
export type PausedWorkflows = z.infer<typeof pausedWorkflowsSchema>;

function parse<T>(schema: z.ZodType<T>, json: string | null, empty: T): T {
  if (json === null) return empty;
  try {
    const parsed = schema.safeParse(JSON.parse(json));
    return parsed.success ? parsed.data : empty;
  } catch {
    return empty;
  }
}

export function parsePausedContainers(json: string | null): PausedContainers {
  return parse(pausedContainersSchema, json, []);
}

export function parsePausedQueues(json: string | null): PausedQueues {
  return parse(pausedQueuesSchema, json, []);
}

export function parsePausedWorkflows(json: string | null): PausedWorkflows {
  return parse(pausedWorkflowsSchema, json, {});
}

/** Validated JSON of a record; null when there is nothing in it. */
export function containersJson(value: PausedContainers): string | null {
  return value.length === 0 ? null : JSON.stringify(pausedContainersSchema.parse(value));
}

export function queuesJson(value: PausedQueues): string | null {
  return value.length === 0 ? null : JSON.stringify(pausedQueuesSchema.parse(value));
}

export function workflowsJson(value: PausedWorkflows): string | null {
  return Object.keys(value).length === 0
    ? null
    : JSON.stringify(pausedWorkflowsSchema.parse(value));
}
