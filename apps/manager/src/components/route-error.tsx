import { Banner } from "@cloudflare/kumo";
import { ArrowClockwiseIcon } from "@phosphor-icons/react";
import type { ErrorComponentProps } from "@tanstack/react-router";
import { ACCESS_DENIED_MESSAGE, isAccessDenied } from "../access/denied";
import { isStaleBuildError } from "../stale-build-reload";
import { BANNER_ICON, MessageText } from "./message-text";

/** Shown when a file of the page did not load and the automatic reload did not help. */
export const STALE_BUILD_MESSAGE =
  "Part of this page did not load. Appflare may have just been updated: reload the page to load the new version.";

/**
 * Default route error: the message only (server functions never put secrets in
 * errors). A call Cloudflare Access refused gets a plain explanation and a
 * reload, which sends the browser through the Access sign-in again. So does a
 * file of the page that failed to load (stale-build-reload.ts), when the page
 * has already reloaded once for it.
 */
export function RouteError({ error }: ErrorComponentProps) {
  const reloadable = isAccessDenied(error)
    ? ACCESS_DENIED_MESSAGE
    : isStaleBuildError(error)
      ? STALE_BUILD_MESSAGE
      : null;
  if (reloadable !== null) {
    return (
      <div className="mx-auto max-w-2xl px-6 py-10">
        <Banner
          variant="error"
          icon={BANNER_ICON.error}
          description={reloadable}
          action={
            <Banner.Action icon={<ArrowClockwiseIcon />} onClick={() => window.location.reload()}>
              Reload
            </Banner.Action>
          }
        />
      </div>
    );
  }
  return (
    <div className="mx-auto max-w-2xl px-6 py-10">
      <Banner
        variant="error"
        icon={BANNER_ICON.error}
        title="Something went wrong"
        description={
          <MessageText message={error instanceof Error ? error.message : "Unexpected error."} />
        }
      />
    </div>
  );
}
