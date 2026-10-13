/**
 * Checks for the plain values the spend watcher's units hand each other over
 * `SELF`, without Zod: the units run every five minutes in code that never
 * runs often enough to be optimized, where Zod's first parse in an isolate
 * costs milliseconds of the Workers Free plan's 10 ms of CPU time. Each unit's
 * input keeps its Zod schema for its type and a test holds the two together.
 */

/** Thrown for an input its schema would refuse. */
export class UnitInputError extends Error {
  override name = "UnitInputError";
}

export const isRecord = (v: unknown): v is Record<string, unknown> =>
  typeof v === "object" && v !== null && !Array.isArray(v);

export function need(ok: boolean, what: string): void {
  if (!ok) throw new UnitInputError(`Invalid unit input: ${what}`);
}

/** A finite number (what `z.number()` accepts). */
export function numberIn(v: unknown, what: string): number {
  need(typeof v === "number" && Number.isFinite(v), `${what} is not a number`);
  return v as number;
}

export function stringsIn(v: unknown, what: string): string[] {
  need(Array.isArray(v), `${what} is not a list`);
  return (v as unknown[]).map((s, i) => {
    need(typeof s === "string", `${what}.${i} is not a string`);
    return s as string;
  });
}

export function recordIn<T>(
  v: unknown,
  what: string,
  item: (x: unknown, at: string) => T,
): Record<string, T> {
  need(isRecord(v), `${what} is not an object`);
  const out: Record<string, T> = {};
  for (const [k, x] of Object.entries(v as Record<string, unknown>)) {
    out[k] = item(x, `${what}.${k}`);
  }
  return out;
}

/** `{ installId, installedAt }` items, at most `max` (the units' app lists). */
export function appsIn(
  v: unknown,
  what: string,
  max: number,
): Array<{ installId: string; installedAt: number }> {
  need(
    Array.isArray(v) && (v as unknown[]).length <= max,
    `${what} is not a list of at most ${max}`,
  );
  return (v as unknown[]).map((a, i) => {
    need(isRecord(a), `${what}.${i} is not an object`);
    const app = a as Record<string, unknown>;
    need(
      typeof app.installId === "string" && app.installId.length > 0,
      `${what}.${i}.installId is empty`,
    );
    return {
      installId: app.installId as string,
      installedAt: numberIn(app.installedAt, `${what}.${i}.installedAt`),
    };
  });
}

/** Alarm counts by install: `{ [installId]: [{ object, alarms }] }`. */
export function alarmsIn(
  v: unknown,
  what: string,
): Record<string, Array<{ object: string; alarms: number }>> {
  return recordIn(v, what, (list, at) => {
    need(Array.isArray(list), `${at} is not a list`);
    return (list as unknown[]).map((o, i) => {
      need(isRecord(o), `${at}.${i} is not an object`);
      const x = o as Record<string, unknown>;
      need(typeof x.object === "string", `${at}.${i}.object is not a string`);
      return { object: x.object as string, alarms: numberIn(x.alarms, `${at}.${i}.alarms`) };
    });
  });
}

/** Resume windows by install: `{ [installId]: { at, base: { [product]: number } } }`. */
export function resumesIn(
  v: unknown,
  what: string,
): Record<string, { at: number; base: Record<string, number> }> {
  return recordIn(v, what, (w, at) => {
    need(isRecord(w), `${at} is not an object`);
    const x = w as Record<string, unknown>;
    return {
      at: numberIn(x.at, `${at}.at`),
      base: recordIn(x.base, `${at}.base`, (n, where) => numberIn(n, where)),
    };
  });
}
