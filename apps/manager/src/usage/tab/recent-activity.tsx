import { cn, Text } from "@cloudflare/kumo";
import { Section } from "../../components/section";
import type { UsageEvent } from "../tab";
import { clock } from "../ui/format";
import { eventCopy } from "./copy";

/** How many of the newest events the list shows. */
export const RECENT_EVENTS = 5;

const DAY = new Intl.DateTimeFormat("en", { month: "short", day: "numeric" });

/** Updates, settings changes, alerts, pauses and resumes, newest first. */
export function RecentActivity({
  events,
  channels,
}: {
  events: readonly UsageEvent[];
  /** The channels usage alerts go to; null when the viewer may not see them. */
  channels: readonly string[] | null;
}) {
  const shown = events.slice(0, RECENT_EVENTS);
  return (
    <Section id="activity" title="Recent activity">
      <ol className="grid divide-y divide-kumo-hairline">
        {shown.length === 0 && (
          <li className="px-5 py-4">
            <Text variant="secondary">Nothing yet. Updates, alerts and pauses show up here.</Text>
          </li>
        )}
        {shown.map((e) => {
          const copy = eventCopy(e, channels);
          return (
            <li key={e.id} className="grid gap-x-4 gap-y-1 px-5 py-3 sm:grid-cols-[8rem_1fr]">
              <Text variant="secondary">
                <time dateTime={new Date(e.at).toISOString()}>
                  {DAY.format(e.at)}, {clock(e.at)}
                </time>
              </Text>
              <span className="flex flex-wrap items-baseline gap-x-2">
                <span
                  aria-hidden
                  className={cn(
                    "size-2 shrink-0 self-center rounded-full",
                    copy.alert ? "bg-kumo-danger" : "bg-kumo-hairline",
                  )}
                />
                <Text bold as="span">
                  {copy.label}
                </Text>
                <Text variant="secondary" as="span">
                  {copy.description}
                </Text>
              </span>
            </li>
          );
        })}
      </ol>
    </Section>
  );
}
