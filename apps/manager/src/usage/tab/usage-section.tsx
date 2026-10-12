import { Badge, cn, Link, Table, Tabs, Text } from "@cloudflare/kumo";
import { ClockIcon, PlugsIcon } from "@phosphor-icons/react";
import { lazy, type ReactNode, Suspense, useState } from "react";
import { reconnectDialogHref } from "../../cloudflare/reconnect-outcome";
import { BusyButton } from "../../components/busy-button";
import { Section, SectionEmpty, SectionTable } from "../../components/section";
import { settingsLink } from "../../components/settings-links";
import { percent, usd } from "../attention-format";
import type { ProductKey } from "../math";
import { USAGE_RANGES, type UsageRange, type UsageTabData } from "../tab";
import {
  amount,
  chartHeadline,
  label,
  shortTimes,
  statusLine,
  type Tone,
  updatedText,
} from "./copy";
import { Sparkline } from "./sparkline";

/**
 * "Usage by product": how the app is doing in one line, the range, a large
 * chart of the product picked in the table under it, and the table of every
 * product the app uses. A brand-new app (Cloudflare reports nothing for
 * about 15 minutes) and a connection without the usage permissions show
 * why there is nothing yet instead.
 */

const UsageChart = lazy(() => import("./usage-chart"));

const RANGE_LABELS: Record<UsageRange, string> = {
  "24h": "24 hours",
  "7d": "7 days",
  "30d": "30 days",
};

const DOT: Record<Tone, string> = {
  bad: "bg-kumo-danger",
  warn: "bg-kumo-warning",
  muted: "bg-neutral-400 dark:bg-neutral-500",
  good: "bg-kumo-success",
};

/** One line on how the app is doing, with a dot in its state's colour: the table has the detail. */
export function StatusLine({ data }: { data: UsageTabData }) {
  const today = (key: ProductKey) => data.products.find((p) => p.key === key)?.today ?? 0;
  const { tone, text } = statusLine(data.status, { now: data.now, today });
  return (
    <span className="flex items-start gap-2" data-tone={tone}>
      {/* Kumo: an inline icon sits centred on the first line of text. */}
      <span aria-hidden className="flex h-lh shrink-0 items-center">
        <span className={cn("size-2 rounded-full", DOT[tone])} />
      </span>
      <span>{text}</span>
    </span>
  );
}

function RangeTabs({ range, onRange }: { range: UsageRange; onRange: (r: UsageRange) => void }) {
  return (
    <Tabs
      variant="segmented"
      size="sm"
      value={range}
      onValueChange={(v) => {
        const next = USAGE_RANGES.find((r) => r === v);
        if (next !== undefined) onRange(next);
      }}
      tabs={USAGE_RANGES.map((value) => ({ value, label: RANGE_LABELS[value] }))}
    />
  );
}

/** A brand-new app: Cloudflare's analytics show nothing yet; Workers Logs show it sooner. */
export function FreshUsage({
  data,
  isAdmin,
  onTurnOnLogs,
}: {
  data: UsageTabData;
  isAdmin: boolean;
  onTurnOnLogs: () => Promise<void>;
}) {
  const [pending, setPending] = useState(false);
  const minutes = Math.max(1, Math.round((data.now - data.installedAt) / 60_000));
  const logsOn = data.logs?.state === "on";
  return (
    <SectionEmpty
      icon={<ClockIcon size={48} className="text-kumo-inactive" />}
      title="Usage shows up about 15 minutes after install"
      description={`Installed ${minutes === 1 ? "1 minute" : `${minutes} minutes`} ago. Until Cloudflare reports its usage, alerts and auto-pause can't see this app; they start with the first numbers. ${logsOn ? "Workers Logs are on, so its requests show in Cloudflare's logs already." : "Workers Logs show it within a couple of minutes."}`}
      contents={
        isAdmin && !logsOn ? (
          <BusyButton
            variant="secondary"
            pending={pending}
            onClick={async () => {
              setPending(true);
              await onTurnOnLogs();
              setPending(false);
            }}
          >
            Turn on Workers Logs
          </BusyButton>
        ) : undefined
      }
    />
  );
}

/** The connection lacks the permissions usage is read with. */
export function ReconnectUsage({ isAdmin, via }: { isAdmin: boolean; via: "oauth" | "token" }) {
  if (via === "token") {
    return (
      <SectionEmpty
        icon={<PlugsIcon size={48} className="text-kumo-inactive" />}
        title="Give the token access to usage"
        description="Appflare reads usage with the Account Analytics (Read) and Workers Observability (Read) permissions, which its Cloudflare API token doesn't have. Add them to the token in the Cloudflare dashboard; spend protection starts with the first numbers."
        contents={
          isAdmin ? (
            <Link href={settingsLink("account", "connection")}>Cloudflare connection</Link>
          ) : (
            <Text variant="secondary">An admin can change the token.</Text>
          )
        }
      />
    );
  }
  return (
    <SectionEmpty
      icon={<PlugsIcon size={48} className="text-kumo-inactive" />}
      title="Reconnect to see usage"
      description="Appflare reads usage with Cloudflare permissions this connection doesn't have yet. Reconnecting Cloudflare adds them; spend protection starts with the first numbers."
      contents={
        isAdmin ? (
          <Link href={reconnectDialogHref()}>Reconnect Cloudflare</Link>
        ) : (
          <Text variant="secondary">An admin can reconnect Cloudflare.</Text>
        )
      }
    />
  );
}

/** A numeric cell. */
function Cell({ children }: { children: ReactNode }) {
  return (
    <Table.Cell>
      <span className="whitespace-nowrap tabular-nums">{children}</span>
    </Table.Cell>
  );
}

export function UsageSection({
  data,
  app,
  isAdmin,
  onTurnOnLogs,
}: {
  data: UsageTabData;
  /** The app's name. */
  app: string;
  isAdmin: boolean;
  onTurnOnLogs: () => Promise<void>;
}) {
  const [range, setRange] = useState<UsageRange>("24h");
  const [picked, setPicked] = useState<ProductKey | null>(null);
  const { status, products } = data;
  const key = picked !== null && products.some((p) => p.key === picked) ? picked : data.headline;
  const product = products.find((p) => p.key === key) ?? null;
  const empty =
    status.kind === "fresh" ? (
      <FreshUsage data={data} isAdmin={isAdmin} onTurnOnLogs={onTurnOnLogs} />
    ) : status.kind === "reconnect" ? (
      <ReconnectUsage isAdmin={isAdmin} via={status.via} />
    ) : product === null ? (
      <SectionEmpty
        icon={<ClockIcon size={48} className="text-kumo-inactive" />}
        title="No usage yet"
        description="Cloudflare has reported no usage for this app in the last 30 days. Appflare reads it every 5 minutes."
      />
    ) : undefined;
  const paid = data.plan === "paid";
  return (
    <Section
      id="usage"
      title="Usage by product"
      description={<StatusLine data={data} />}
      action={empty === undefined ? <RangeTabs range={range} onRange={setRange} /> : undefined}
      empty={empty}
    >
      {product !== null && (
        <>
          <div className="grid gap-1 px-5 pt-4">
            <span className="flex flex-wrap items-baseline justify-between gap-x-4">
              <Text bold>{label(product.key)}</Text>
              <Text variant="secondary">
                {chartHeadline(product)} · {updatedText(data.updatedAt, data.now)}
              </Text>
            </span>
            <Suspense fallback={<div className="h-[260px]" />}>
              <UsageChart
                plan={data.plan}
                product={product}
                range={range}
                app={app}
                events={data.events}
                now={data.now}
                channels={data.spend.channels}
              />
            </Suspense>
          </div>
          <SectionTable label="Usage by product" minWidth="lg">
            <Table.Header>
              <Table.Row>
                <Table.Head>Product</Table.Head>
                <Table.Head>Last 24 hours</Table.Head>
                <Table.Head>Today</Table.Head>
                <Table.Head>This month</Table.Head>
                <Table.Head>Projected</Table.Head>
                <Table.Head>{paid ? "Of included" : "Of free limit"}</Table.Head>
                {paid && <Table.Head>Cost past included</Table.Head>}
              </Table.Row>
            </Table.Header>
            <Table.Body>
              {products.map((p) => {
                const selected = p.key === product.key;
                return (
                  <Table.Row
                    key={p.key}
                    variant={selected ? "selected" : "default"}
                    data-product={p.key}
                    // The whole row picks the chart's product; the button in its first cell is the keyboard's way.
                    onClick={() => setPicked(p.key)}
                    className={cn(
                      "cursor-pointer",
                      !selected &&
                        "hover:[--kumo-table-row-bg:color-mix(in_oklab,var(--color-kumo-tint)_60%,var(--color-kumo-base))]",
                    )}
                  >
                    <Table.Cell>
                      <button
                        type="button"
                        aria-pressed={selected}
                        onClick={(e) => {
                          e.stopPropagation();
                          setPicked(p.key);
                        }}
                        className="flex items-center gap-2 whitespace-nowrap rounded-sm text-left font-medium focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-kumo-brand"
                      >
                        <span
                          aria-hidden
                          className={cn(
                            "size-2 shrink-0 rounded-full",
                            selected ? "bg-kumo-brand" : "bg-kumo-hairline",
                          )}
                        />
                        {label(p.key)}
                      </button>
                    </Table.Cell>
                    <Table.Cell>
                      <span className="flex items-center gap-2 whitespace-nowrap">
                        <Sparkline
                          values={p.hours.slice(-24).map(([, v]) => v)}
                          tone={p.hot ? "alert" : "neutral"}
                        />
                        {p.hot && p.ratio !== null && (
                          <Badge variant="error">{shortTimes(p.ratio)} normal</Badge>
                        )}
                      </span>
                    </Table.Cell>
                    <Cell>
                      <span className={p.hot ? "text-kumo-danger" : undefined}>
                        {amount(p.today, p.key)}
                      </span>
                    </Cell>
                    <Cell>{p.month === null ? "—" : amount(p.month, p.key)}</Cell>
                    <Cell>{p.projectedMonth === null ? "—" : amount(p.projectedMonth, p.key)}</Cell>
                    <Cell>
                      {p.allowance === null
                        ? "—"
                        : `${percent(p.allowance.share)}${p.allowance.daily ? " today" : ""}`}
                    </Cell>
                    {paid && <Cell>{usd(p.overageUsd ?? 0)}</Cell>}
                  </Table.Row>
                );
              })}
            </Table.Body>
          </SectionTable>
        </>
      )}
    </Section>
  );
}
