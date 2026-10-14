import { LinkButton, Tabs, Text } from "@cloudflare/kumo";
import { useState } from "react";
import { reconnectDialogHref } from "../cloudflare/reconnect-outcome";
import { Section } from "../components/section";
import { settingsLink } from "../components/settings-links";
import { type HomeUsageView, productTabLabel } from "../usage/home";
import { UsageByAppChart } from "../usage/home-charts";
import { PRODUCTS, type ProductKey } from "../usage/math";

/** What Home's "Usage" section says in its header and states. */
export const HOME_USAGE_COPY = {
  description:
    "This Cloudflare account, by app. Estimates from Cloudflare's analytics, a few minutes behind.",
  readFailed: "Usage could not be read just now. Reload the page to try again.",
  reconnect:
    "Reconnect Cloudflare to see usage: Appflare needs permission to read Cloudflare's analytics.",
  reconnectMember: "An admin can reconnect it.",
  tokenAccess:
    "Appflare's API token needs permission to read Cloudflare's analytics before usage shows here.",
  tokenAccessMember: "An admin can give it.",
  noUsage: "No usage in the last 7 days.",
} as const;

/**
 * Home's "Usage", above "Your apps": three totals (on Paid, usage past
 * included this month, the projected month and what every app burns now; on
 * Free, what can be billed, the closest daily limit and the apps needing a
 * look), then a product's last 7 days stacked by app, one colour per app,
 * the same as on its card. Without the usage permissions, a short way to get
 * them instead: reconnect, or give the API token them.
 */
export function HomeUsageSection({
  view,
  needsAccess,
  isAdmin,
}: {
  /** Null when the usage could not be read. */
  view: HomeUsageView | null;
  /** Set while usage cannot be read without other permissions. */
  needsAccess: { via: "oauth" | "token" } | null;
  isAdmin: boolean;
}) {
  if (view === null) {
    return (
      <Section
        id="usage"
        title="Usage"
        description={HOME_USAGE_COPY.description}
        error={HOME_USAGE_COPY.readFailed}
      />
    );
  }
  if (needsAccess !== null) {
    const oauth = needsAccess.via === "oauth";
    return (
      <Section id="usage" title="Usage" description={HOME_USAGE_COPY.description}>
        <div className="flex flex-col gap-3 px-5 py-4 sm:flex-row sm:items-center sm:justify-between">
          <Text variant="secondary">
            {oauth ? HOME_USAGE_COPY.reconnect : HOME_USAGE_COPY.tokenAccess}
            {!isAdmin &&
              ` ${oauth ? HOME_USAGE_COPY.reconnectMember : HOME_USAGE_COPY.tokenAccessMember}`}
          </Text>
          {isAdmin && (
            <LinkButton
              href={oauth ? reconnectDialogHref() : settingsLink("account", "connection")}
              variant="secondary"
              size="sm"
            >
              {oauth ? "Reconnect Cloudflare" : "Cloudflare connection"}
            </LinkButton>
          )}
        </div>
      </Section>
    );
  }
  return (
    <Section id="usage" title="Usage" description={HOME_USAGE_COPY.description}>
      <div className="grid grid-cols-1 divide-y divide-kumo-hairline border-b border-kumo-hairline sm:grid-cols-3 sm:divide-x sm:divide-y-0">
        {view.tiles.map((tile) => (
          <div key={tile.label} className="grid content-start gap-0.5 px-5 py-4">
            <Text variant="secondary" size="sm">
              {tile.label}
            </Text>
            <span
              className={`text-lg font-semibold tabular-nums ${tile.bad ? "text-kumo-danger" : ""}`}
            >
              {tile.value}
            </span>
            <Text variant="secondary" size="sm">
              {tile.note}
            </Text>
          </div>
        ))}
      </div>
      <ProductChart view={view} />
    </Section>
  );
}

/** The product tabs and the selected product's chart. */
function ProductChart({ view }: { view: HomeUsageView }) {
  const [picked, setPicked] = useState<ProductKey | null>(null);
  const product = picked !== null && view.products.includes(picked) ? picked : view.initialProduct;
  if (product === null) {
    return (
      <div className="px-5 py-4">
        <Text variant="secondary">{HOME_USAGE_COPY.noUsage}</Text>
      </div>
    );
  }
  const chart = view.chart(product);
  return (
    <div className="grid min-w-0 gap-3 px-5 py-4">
      <div className="flex min-w-0 flex-wrap items-center justify-between gap-2">
        {/* On a phone the tabs scroll sideways instead of widening the chart. */}
        <div className="min-w-0 max-w-full overflow-x-auto">
          <Tabs
            variant="segmented"
            size="sm"
            value={product}
            onValueChange={(value) => setPicked(value as ProductKey)}
            tabs={view.products.map((key) => ({ value: key, label: productTabLabel(key) }))}
          />
        </div>
        <Text variant="secondary" size="sm">
          {chart.caption}
        </Text>
      </div>
      <div
        className="min-w-0"
        role="img"
        aria-label={`${PRODUCTS[product].label} by app, per hour, ${chart.caption.toLowerCase()}: ${chart.series.map((s) => s.name).join(", ")}.`}
      >
        <UsageByAppChart chart={chart} />
      </div>
      {chart.other !== null && (
        <Text variant="secondary" size="sm">
          {chart.other}
        </Text>
      )}
    </div>
  );
}
