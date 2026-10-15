/**
 * This source-baked channel intentionally identifies the QuarionGG fork.
 * An editable Worker variable must never let the official release feed
 * replace its adoption support. Catalog app updates use their own policy.
 * Update this manager by deploying a reviewed build of this fork.
 */
export const MANAGER_BUILD_CHANNEL = "quariongg-fork";

export const FORK_MANAGER_UPDATE_MESSAGE =
  "This QuarionGG fork includes imported-app support. Official Appflare updates would replace that code, so manager updates are disabled. Deploy a reviewed build of this fork to update Appflare. Catalog app updates still work. Rolling back to an official build would hide imported apps until this fork is deployed again.";

/** Null only on a build whose source explicitly permits official manager updates. */
export function managerSelfUpdateBlock(): string | null {
  return FORK_MANAGER_UPDATE_MESSAGE;
}
