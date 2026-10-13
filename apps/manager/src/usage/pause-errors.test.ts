import { describe, expect, it } from "vitest";
import { pauseErrorSummary } from "./pause-errors";

/** A refusal as the pause job recorded it on a live account (the account id shortened here). */
const REFUSED =
  'serve the stand-in of Worker chk-loop: Cloudflare API request failed: POST /accounts/5b98c14a/workers/scripts/chk-loop/deployments -> 400: [10210] Invalid deployment: The version "57e950ab" cannot be deployed because it has a resource that was modified: the binding "TEMP_KV" references KV Namespace "aba9890a" that no longer exists - check the request details and try again.';

describe("pauseErrorSummary", () => {
  it("says why in a short sentence, never in the API's own words", () => {
    const summary = pauseErrorSummary(REFUSED);
    expect(summary).toBe(
      "Cloudflare refused the change: a binding points to something that no longer exists. The job log has the details.",
    );
    expect(summary).not.toMatch(/accounts|5b98c14a|57e950ab|TEMP_KV|\/workers\//);
  });

  it("tells a refused connection, a busy API and no answer apart", () => {
    expect(
      pauseErrorSummary(
        "Cloudflare API request failed: PUT /x -> 403: [10000] Authentication error",
      ),
    ).toBe(
      "Cloudflare refused the change: Appflare's connection may not make it. The job log has the details.",
    );
    expect(pauseErrorSummary("-> 429: rate limited")).toBe(
      "Cloudflare was busy and refused the change for now. The job log has the details.",
    );
    expect(pauseErrorSummary("-> 503: Service Unavailable")).toBe(
      "Cloudflare did not answer in time. The job log has the details.",
    );
  });

  it("falls back to a plain refusal for an API error it does not know", () => {
    expect(pauseErrorSummary("Cloudflare API request failed: PUT /x -> 400: [12345] odd")).toBe(
      "Cloudflare refused the change. The job log has the details.",
    );
  });

  it("does not blame Cloudflare for Appflare's own reasons", () => {
    expect(pauseErrorSummary("the app is not paused")).toBe(
      "The app was not paused. The job log has the details.",
    );
    expect(pauseErrorSummary("the install no longer exists")).toBe(
      "The app is no longer installed as it was. The job log has the details.",
    );
    expect(pauseErrorSummary('Worker "x" has no deployment, so there is nothing to pause')).toBe(
      "Its Worker serves no version, so there was nothing to pause. The job log has the details.",
    );
    expect(pauseErrorSummary("the app's pause closed while this one started")).toBe(
      "Another change to the app was under way. Try again once it ends. The job log has the details.",
    );
    expect(pauseErrorSummary("something else")).toBe(
      "The change could not be made. The job log has the details.",
    );
  });
});
