/**
 * What a failed pause or resume tells the pages, in one short sentence:
 * why it failed, never the API's own words (request paths name the account,
 * and its messages name versions and resource ids). The job log keeps the
 * details. A refusal by Cloudflare says so; a failure of Appflare's own
 * (the app was gone, not paused, busy) says what it was, without blaming
 * Cloudflare. Pure; client-safe.
 */

const DETAILS = "The job log has the details.";

/** An error from a Cloudflare API request, as the client words it. */
const FROM_CLOUDFLARE = /Cloudflare API request failed|Cloudflare did not answer|->\s*\d{3}\b/i;

/** Cloudflare's error codes and words, and what they mean for a pause. */
const CLOUDFLARE_REASONS: ReadonlyArray<{ test: RegExp; says: string }> = [
  {
    // 10210 (a version's binding refers to a resource that is gone),
    // 10041 (a KV namespace that is not valid), and the like.
    test: /\b(10210|10041|10181)\b|no longer exists|does not exist|could not be found|not found/i,
    says: "Cloudflare refused the change: a binding points to something that no longer exists.",
  },
  {
    test: /\b(401|403)\b|\b(9106|9109|10000)\b|unauthori[sz]ed|authentication|permission/i,
    says: "Cloudflare refused the change: Appflare's connection may not make it.",
  },
  {
    test: /\b429\b|rate.?limit|too many requests/i,
    says: "Cloudflare was busy and refused the change for now.",
  },
  {
    test: /\b5\d\d\b|timed? ?out|did not answer|network|fetch failed/i,
    says: "Cloudflare did not answer in time.",
  },
];

/** Appflare's own reasons a pause or resume stops, from the pause and resume jobs. */
const LOCAL_REASONS: ReadonlyArray<{ test: RegExp; says: string }> = [
  { test: /not paused/i, says: "The app was not paused." },
  {
    test: /no longer exists|no such app|only an installed app/i,
    says: "The app is no longer installed as it was.",
  },
  {
    test: /has no deployment|nothing to pause/i,
    says: "Its Worker serves no version, so there was nothing to pause.",
  },
  {
    test: /pause closed while|already|another job|busy|is running|self-update|updating/i,
    says: "Another change to the app was under way. Try again once it ends.",
  },
  { test: /account is not known/i, says: "Appflare does not know its Cloudflare account yet." },
];

/** The short sentence for a pause or resume that failed with `error`. */
export function pauseErrorSummary(error: string): string {
  if (FROM_CLOUDFLARE.test(error)) {
    const reason = CLOUDFLARE_REASONS.find((r) => r.test.test(error));
    return `${reason?.says ?? "Cloudflare refused the change."} ${DETAILS}`;
  }
  const local = LOCAL_REASONS.find((r) => r.test.test(error));
  return `${local?.says ?? "The change could not be made."} ${DETAILS}`;
}
