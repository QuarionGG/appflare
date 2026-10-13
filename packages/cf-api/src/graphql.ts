import type { HttpApi } from "./http";

/** Cloudflare's GraphQL Analytics endpoint, relative to the API base. */
export const GRAPHQL_PATH = "/graphql";

/** One entry of a GraphQL answer's `errors`, as Cloudflare sends it. */
export interface GraphQLErrorItem {
  message: string;
  path?: Array<string | number> | null;
  /** Cloudflare puts a short `code` here for some refusals (`quota`, `authz`). */
  extensions?: { code?: string; [key: string]: unknown };
}

/**
 * Thrown when Cloudflare's GraphQL Analytics API answers with `errors`. It
 * answers those with HTTP 200, so they never reach `CloudflareApiError`; a
 * credential it refuses outright still does (HTTP 400, code 9106, in the
 * usual REST envelope). The message holds Cloudflare's own error messages,
 * never the query's variables.
 */
export class CloudflareGraphQLError extends Error {
  readonly errors: GraphQLErrorItem[];
  /** The `extensions.code` of each error that has one, such as `quota`. */
  readonly codes: string[];

  constructor(errors: GraphQLErrorItem[]) {
    const detail = errors.map((e) => e.message).join("; ");
    super(`Cloudflare GraphQL query failed: ${detail || "no data in the answer"}`);
    this.name = "CloudflareGraphQLError";
    this.errors = errors;
    this.codes = errors.flatMap((e) =>
      typeof e.extensions?.code === "string" ? [e.extensions.code] : [],
    );
  }
}

interface GraphQLAnswer<T> {
  data?: T | null;
  errors?: GraphQLErrorItem[] | null;
}

/**
 * The GraphQL Analytics transport: `POST /graphql` with `{ query, variables }`.
 * Answers with `errors` throw {@link CloudflareGraphQLError}; everything else
 * returns `data`. Cloudflare caches an answer per query and variables for
 * 20 minutes or more, whatever the response's `cache-control` says, so a
 * caller polling for fresh numbers must make every request's variables
 * different (the usage queries put the current time in each one).
 */
export function createGraphQL(http: HttpApi) {
  return {
    async query<T>(query: string, variables: Record<string, unknown>): Promise<T> {
      const answer = (await http.send("POST", GRAPHQL_PATH, {
        json: { query, variables },
      })) as unknown as GraphQLAnswer<T>;
      if (Array.isArray(answer.errors) && answer.errors.length > 0) {
        throw new CloudflareGraphQLError(answer.errors);
      }
      if (answer.data === undefined || answer.data === null) {
        throw new CloudflareGraphQLError([]);
      }
      return answer.data;
    },
  };
}

export type GraphQLClient = ReturnType<typeof createGraphQL>;
