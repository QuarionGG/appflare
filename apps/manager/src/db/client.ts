import { type DrizzleD1Database, drizzle } from "drizzle-orm/d1";

export type Database = DrizzleD1Database;

/**
 * Drizzle over the manager's D1 binding. Cheap; build one per request.
 *
 * Built without the schema: the manager writes every query with the query
 * builder (`db.select().from(table)`), never with Drizzle's relational
 * queries (`db.query.<table>`), and passing the schema would make every
 * call work out the relations of every table again (about a millisecond
 * of CPU time each on Workers, several times per scheduled check).
 */
export function createDb(d1: D1Database): Database {
  return drizzle(d1);
}
