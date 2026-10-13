import { Text } from "@cloudflare/kumo";
import type { StillPastCap } from "../usage/attention";
import type { CardUsage } from "../usage/home";
import { CardUsageChart } from "../usage/home-charts";
import { PRODUCTS } from "../usage/math";
import { PauseAppButton, ResumeAppButton } from "./pause-resume-buttons";

/** What a brand-new app's card says where its chart will be. */
export const FRESH_CARD_NOTE = "Usage shows up about an hour after install";

/**
 * Usage on an app card, above its buttons: 7 days of its most telling
 * product in its colour (red while it runs away, grey while paused), and one
 * line about it. A brand-new app says when usage shows up instead.
 */
export function AppCardUsage({ card, name }: { card: CardUsage; name: string }) {
  if (card.state === "fresh") {
    return (
      <div className="grid gap-1.5">
        <div className="flex h-12 items-center justify-center rounded-md bg-kumo-recessed px-3 text-center">
          <span className="text-sm text-kumo-subtle">{FRESH_CARD_NOTE}</span>
        </div>
        <Text as="span" variant="secondary" size="sm">
          {card.line}
        </Text>
      </div>
    );
  }
  const label = PRODUCTS[card.product].label;
  const alert = card.tone.kind === "alert";
  return (
    <div className="grid gap-1.5">
      <div role="img" aria-label={`${name}: ${label}, last 7 days. ${card.line}.`}>
        <CardUsageChart product={card.product} points={card.points} tone={card.tone} />
      </div>
      <Text as="span" variant="secondary" size="sm">
        <span className={alert ? "text-kumo-danger" : undefined}>{card.line}</span>
        <span className="sr-only"> ({label}, last 7 days)</span>
      </Text>
    </div>
  );
}

/**
 * What leads the card's buttons, for admins: Pause while the app runs away
 * or used up a free limit, Resume once paused (asking first while it is
 * still past its cap). The same buttons and dialogs as "Needs attention".
 */
export function AppCardUsageAction({
  card,
  installId,
  label,
  stillPastCap,
}: {
  card: CardUsage;
  installId: string;
  label: string;
  stillPastCap: StillPastCap | null;
}) {
  if (card.action === "pause") {
    return <PauseAppButton installId={installId} label={label} size="sm" text="Pause" />;
  }
  if (card.action === "resume") {
    return (
      <ResumeAppButton
        installId={installId}
        label={label}
        stillPastCap={stillPastCap}
        size="sm"
        prominent={false}
      />
    );
  }
  return null;
}
