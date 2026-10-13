import { MANAGER_OAUTH_SCOPE_BY_GROUP, OFFLINE_ACCESS_SCOPE } from "@appflare/cf-api/oauth";
import {
  MANAGER_SCOPE_REASONS,
  OFFLINE_ACCESS_REASON,
  type ScopeReason,
} from "@appflare/cf-api/scope-reasons";

/**
 * Why Appflare holds each permission of its Cloudflare sign-in, in the
 * words the install page showed before Cloudflare's consent page: the
 * connection card's Details list them instead of scope ids. Client-safe.
 */

/**
 * Scopes earlier versions of Appflare asked for and this one does not. A
 * sign-in made back then still holds them, and is not asked to reconnect
 * over them; the connection card says what each one is, rather than
 * showing its bare id.
 */
const FORMER_SCOPE_REASONS: ReadonlyArray<readonly [string, ScopeReason]> = [
  [
    "workers-tail.read",
    {
      label: "Workers Tail",
      text: "Workers Tail lets a sign-in read a Worker's live logs. Earlier versions of Appflare asked for it; this version does not use it or ask for it.",
    },
  ],
];

/** OAuth scope id -> why Appflare asks for it, or why an earlier version did. */
const REASON_BY_SCOPE: ReadonlyMap<string, ScopeReason> = new Map([
  ...Object.entries(MANAGER_OAUTH_SCOPE_BY_GROUP).flatMap(([group, scope]) => {
    const reason = (MANAGER_SCOPE_REASONS as Record<string, ScopeReason | undefined>)[group];
    return scope === null || reason === undefined ? [] : [[scope, reason] as const];
  }),
  [OFFLINE_ACCESS_SCOPE, OFFLINE_ACCESS_REASON],
  ...FORMER_SCOPE_REASONS,
]);

/**
 * The reasons for `scopes`, in the order given; a scope Appflare has no
 * reason for (one Cloudflare granted besides) is named by its id.
 */
export function scopeReasons(scopes: readonly string[]): Array<{ scope: string } & ScopeReason> {
  return scopes.map((scope) => {
    const reason = REASON_BY_SCOPE.get(scope);
    return reason === undefined ? { scope, label: scope, text: scope } : { scope, ...reason };
  });
}
