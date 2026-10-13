import type { BatchItem } from "drizzle-orm/batch";
import type { Database } from "./client";

/**
 * Reads that share one round trip to D1. On Workers each D1 call costs CPU
 * time of its own (about a millisecond in code that does not run often
 * enough to be optimized, which is how a scheduled check runs), so work
 * that reads several tables at once sends them as one batch: a read is its
 * statements and what their rows mean, and {@link readTogether} sends the
 * statements of several reads together and hands each read its own results.
 *
 * A D1 batch runs as one transaction: the reads see one moment of the
 * database, and a failing statement fails them all.
 */
export interface Read<T> {
  /** The statements, in order; none for a read that needs no query. */
  queries: readonly BatchItem<"sqlite">[];
  /** The value, from each statement's result as Drizzle maps it (one per statement). */
  decode(results: readonly unknown[]): T;
}

/** A read of `queries`, decoded by `decode`. */
export function read<T>(
  queries: readonly BatchItem<"sqlite">[],
  decode: (results: readonly unknown[]) => T,
): Read<T> {
  return { queries, decode };
}

/** A read that is already known: no statement. */
export function known<T>(value: T): Read<T> {
  return { queries: [], decode: () => value };
}

type Values<R extends readonly Read<unknown>[]> = {
  -readonly [K in keyof R]: R[K] extends Read<infer T> ? T : never;
};

/** Sends the reads' statements in one batch and decodes each read from its own results. */
export async function readTogether<const R extends readonly Read<unknown>[]>(
  db: Database,
  reads: R,
): Promise<Values<R>> {
  const all = reads.flatMap((r) => r.queries);
  const [first, ...rest] = all;
  const results: readonly unknown[] = first === undefined ? [] : await db.batch([first, ...rest]);
  let at = 0;
  return reads.map((r) => {
    const own = results.slice(at, at + r.queries.length);
    at += r.queries.length;
    return r.decode(own);
  }) as Values<R>;
}

/** One read on its own: a single statement is sent as it is, more as a batch. */
export async function runRead<T>(db: Database, r: Read<T>): Promise<T> {
  if (r.queries.length === 1) {
    const [only] = r.queries;
    // A single builder query awaited directly, as it would be without the batch.
    return r.decode([await (only as unknown as PromiseLike<unknown>)]);
  }
  return (await readTogether(db, [r] as const))[0];
}
