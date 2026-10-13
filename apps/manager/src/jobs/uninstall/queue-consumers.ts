import type { CloudflareClient } from "@appflare/cf-api";
import { z } from "zod";
import { isNotFound, type JobSteps } from "../steps";

/**
 * Queue consumers of the app's Workers that the install never recorded: one
 * attached by hand or by the app itself, one of an install made before
 * consumers were recorded, one whose queue the install recorded without an
 * id, or one an app's own installer attached. Cloudflare refuses to delete a
 * Worker that still consumes a queue ("Cannot delete this Worker as it is a
 * consumer for a Queue", code 10064, even with `?force=true`), and refuses
 * to delete a queue a Worker still reads (code 11005), so every one of them
 * goes before the Workers.
 *
 * `GET /queues` lists each queue with its consumers (`consumers`, each with
 * `consumer_id`, `type` and the Worker as `script`; seen on the dev account
 * 2026-10-12), so one listing finds them all; a queue listed without its
 * consumers is asked for them in a step of its own, one request per step.
 * The recorded consumers are removed before this runs
 * (../install/queue-consumers.ts), so it usually finds none.
 */

/** A consumer as `GET /queues` and `GET /queues/{id}/consumers` describe it. */
const consumerSchema = z.object({
  consumer_id: z.string().min(1),
  type: z.string().optional(),
  script: z.string().optional(),
  script_name: z.string().optional(),
  service: z.string().optional(),
});
type ListedConsumer = z.infer<typeof consumerSchema>;

/** The fields of a `GET /queues` entry this reads; the cf-api type leaves out the consumers. */
const listedQueueSchema = z.object({
  queue_id: z.string().min(1),
  queue_name: z.string(),
  consumers: z.array(consumerSchema).optional(),
});

/** A queue, by id and name. */
interface QueueRef {
  queueId: string;
  queueName: string;
}

/** One consumer that delivers a queue's messages to one of the app's Workers. */
export interface WorkerConsumer extends QueueRef {
  consumerId: string;
  worker: string;
}

/** The Worker a consumer delivers to, or null for one that is not a Worker (HTTP pull, R2). */
function consumerWorker(consumer: ListedConsumer): string | null {
  if (consumer.type !== undefined && consumer.type !== "worker") return null;
  // The API names the Worker in any of these, depending on the consumer's age.
  return consumer.script ?? consumer.script_name ?? consumer.service ?? null;
}

/** The consumers of `queue` that deliver to one of `workers`. */
function deliveringTo(
  queue: QueueRef,
  consumers: readonly ListedConsumer[],
  workers: ReadonlySet<string>,
): WorkerConsumer[] {
  return consumers.flatMap((consumer) => {
    const worker = consumerWorker(consumer);
    if (worker === null || !workers.has(worker)) return [];
    return [{ ...queue, consumerId: consumer.consumer_id, worker }];
  });
}

/** A queue's consumers asked for on their own; none when the queue is gone by now. */
async function consumersOf(api: CloudflareClient, queueId: string): Promise<ListedConsumer[]> {
  try {
    return (await api.queues.listConsumers(queueId)).flatMap((c) => {
      const one = consumerSchema.safeParse(c);
      return one.success ? [one.data] : [];
    });
  } catch (error) {
    if (isNotFound(error)) return [];
    throw error;
  }
}

function describe(consumers: readonly WorkerConsumer[]): string {
  return consumers.map((c) => `"${c.queueName}" to "${c.worker}"`).join(", ");
}

/**
 * Finds every consumer in the account that delivers to one of `workers`: one
 * step lists the queues, then each queue listed without its consumers is
 * asked for them in a step of its own. The steps' results are the record a
 * retried or resumed job reads back.
 */
export async function findConsumersPhase(
  steps: JobSteps,
  workers: readonly string[],
): Promise<WorkerConsumer[]> {
  if (workers.length === 0) return [];
  const names = new Set(workers);
  const listed = await steps.run("check queues for consumers", async ({ log, cf }) => {
    const found: WorkerConsumer[] = [];
    const unlisted: QueueRef[] = [];
    for (const raw of await cf().queues.listQueues()) {
      const parsed = listedQueueSchema.safeParse(raw);
      if (!parsed.success) continue;
      const queue = { queueId: parsed.data.queue_id, queueName: parsed.data.queue_name };
      if (parsed.data.consumers === undefined) unlisted.push(queue);
      else found.push(...deliveringTo(queue, parsed.data.consumers, names));
    }
    if (found.length > 0) {
      log.info(`Queues that still deliver to the app's Workers: ${describe(found)}.`);
    } else if (unlisted.length === 0) {
      log.info("No queue delivers its messages to the app's Workers any more.");
    }
    if (unlisted.length > 0) {
      log.info(
        `Cloudflare listed ${unlisted.length} queue(s) without their consumers; asking each for them.`,
      );
    }
    return { found, unlisted };
  });
  const found = [...listed.found];
  for (const queue of listed.unlisted) {
    const { consumers } = await steps.run(
      `check consumers of queue ${queue.queueName}`,
      async ({ log, cf }) => {
        const delivering = deliveringTo(queue, await consumersOf(cf(), queue.queueId), names);
        if (delivering.length > 0) {
          log.info(`The queue still delivers to the app's Workers: ${describe(delivering)}.`);
        }
        return { consumers: delivering };
      },
    );
    found.push(...consumers);
  }
  return found;
}

/**
 * Removes each consumer, a step each, so a retry repeats only what is left. A
 * consumer or queue that is already gone counts as removed. `afterInstaller`:
 * the consumers were found before an app's own installer ran its destroy
 * command, and the log says which ones it left.
 */
export async function removeConsumersPhase(
  steps: JobSteps,
  consumers: readonly WorkerConsumer[],
  opts: { afterInstaller?: boolean } = {},
): Promise<void> {
  for (const consumer of consumers) {
    const { queueName, worker } = consumer;
    await steps.run(`remove consumer of queue ${queueName} from ${worker}`, async ({ log, cf }) => {
      try {
        await cf().queues.deleteConsumer(consumer.queueId, consumer.consumerId);
        if (opts.afterInstaller === true) {
          log.warn(
            `The installer's destroy command left the queue "${queueName}" delivering to Worker "${worker}"; removed that consumer.`,
          );
        } else {
          log.info(`Worker "${worker}" no longer consumes the queue "${queueName}".`);
        }
      } catch (error) {
        if (!isNotFound(error)) throw error;
        log.info(
          opts.afterInstaller === true
            ? `The installer's destroy command removed the consumer of the queue "${queueName}".`
            : `The consumer of the queue "${queueName}" was already gone.`,
        );
      }
      return {};
    });
  }
}

/** Uninstall: finds the consumers the app's Workers still have, then removes each. */
export async function removeRemainingConsumersPhase(
  steps: JobSteps,
  workers: readonly string[],
): Promise<void> {
  await removeConsumersPhase(steps, await findConsumersPhase(steps, workers));
}
