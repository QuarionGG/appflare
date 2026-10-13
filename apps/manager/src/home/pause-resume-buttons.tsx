import { Button, Link, Text, useKumoToastManager } from "@cloudflare/kumo";
import { PauseIcon, PlayIcon } from "@phosphor-icons/react";
import { useRouter } from "@tanstack/react-router";
import { useRef, useState } from "react";
import { BusyButton } from "../components/busy-button";
import { ConfirmDialog } from "../components/confirm-dialog";
import { type StillPastCap, stillPastCapCopy } from "../usage/attention";
import { pauseAppFn, resumeAppFn } from "../usage/pause.functions";
import { appSpendHref } from "../usage/ui/format";
import { readerClock } from "./attention-copy";

/**
 * Pause and Resume, for admins. Pausing takes the app offline for visitors,
 * so it asks first. Resuming is one click, unless the app is still past its
 * spending cap: auto-pause would pause it again on its next check, so Resume
 * asks to set the cap aside until it resets.
 *
 * A dialog changes the page only once it has finished closing
 * (`onOpenChangeComplete`): the reload that follows removes the button that
 * owns the dialog, and a dialog must not unmount while it animates.
 */

const dayAndTime = new Intl.DateTimeFormat(undefined, {
  weekday: "short",
  hour: "numeric",
  minute: "2-digit",
});

function errorText(error: unknown, fallback: string): string {
  return error instanceof Error && error.message !== "" ? error.message : fallback;
}

export function PauseAppButton({
  installId,
  label,
  size = "base",
  text = "Pause app",
  calm = false,
}: {
  installId: string;
  /** What Home calls the app. */
  label: string;
  size?: "sm" | "base";
  /** The button's words: "Pause app" in a row, "Pause" on an app's card. */
  text?: string;
  /**
   * The app is running as usual: a secondary button, for pausing it by
   * choice. Filled and destructive (the default) while it runs away.
   */
  calm?: boolean;
}) {
  const router = useRouter();
  const toasts = useKumoToastManager();
  const started = useRef(false);
  return (
    <ConfirmDialog
      size="sm"
      trigger={(props) => (
        <Button
          {...props}
          size={size}
          variant={calm ? "secondary" : "destructive"}
          icon={<PauseIcon />}
          aria-label={`Pause ${label}`}
        >
          {text}
        </Button>
      )}
      title={`Pause ${label}`}
      description="It stops using Cloudflare until you resume it."
      actionLabel={`Pause ${label}`}
      onConfirm={async () => {
        await pauseAppFn({ data: { installId } });
        started.current = true;
      }}
      onOpenChangeComplete={(open) => {
        if (open || !started.current) return;
        started.current = false;
        toasts.add({
          title: `Pausing ${label}`,
          description: "It stops within a few seconds. Resume it when the cause is fixed.",
          variant: "info",
        });
        void router.invalidate();
      }}
    >
      <Text>
        Visitors see a “paused” page and its scheduled work stops. Its data stays as it is. Resume
        it from Home or its Usage tab.
      </Text>
    </ConfirmDialog>
  );
}

export function ResumeAppButton({
  installId,
  label,
  stillPastCap,
  size = "base",
  prominent = true,
}: {
  installId: string;
  label: string;
  /** Set while the app is still past its cap: Resume then asks first. */
  stillPastCap: StillPastCap | null;
  size?: "sm" | "base";
  /** Filled, as a row's main action; outlined beside a card's own Open. */
  prominent?: boolean;
}) {
  const variant = prominent ? "primary" : "secondary";
  const router = useRouter();
  const toasts = useKumoToastManager();
  const [pending, setPending] = useState(false);
  const started = useRef(false);

  function resumed(capSetAside: boolean) {
    toasts.add({
      title: `Resuming ${label}`,
      description: capSetAside
        ? "Its cap is set aside until it resets. The loop check still runs."
        : "The loop check still runs: if it loops again, Appflare pauses it again.",
      variant: "info",
    });
    void router.invalidate();
  }

  if (stillPastCap === null) {
    return (
      <BusyButton
        pending={pending}
        size={size}
        variant={variant}
        icon={<PlayIcon />}
        aria-label={`Resume ${label}`}
        onClick={async () => {
          setPending(true);
          try {
            await resumeAppFn({ data: { installId } });
            resumed(false);
          } catch (error) {
            toasts.add({ title: errorText(error, "Could not resume the app."), variant: "error" });
          }
          setPending(false);
        }}
      >
        Resume
      </BusyButton>
    );
  }

  const copy = stillPastCapCopy(stillPastCap, {
    clock: readerClock,
    dayAndTime: (t) => dayAndTime.format(new Date(t)),
  });
  return (
    <ConfirmDialog
      size="sm"
      destructive={false}
      trigger={(props) => (
        <Button
          {...props}
          size={size}
          variant={variant}
          icon={<PlayIcon />}
          aria-label={`Resume ${label}`}
        >
          Resume
        </Button>
      )}
      title={`Resume ${label}`}
      description={copy.description}
      actionLabel="Resume until the cap resets"
      onConfirm={async () => {
        await resumeAppFn({ data: { installId, untilCapResets: true } });
        started.current = true;
      }}
      onOpenChangeComplete={(open) => {
        if (open || !started.current) return;
        started.current = false;
        resumed(true);
      }}
    >
      <Text>
        {copy.body} To keep a cap, <Link href={appSpendHref(installId)}>change it</Link> instead.
      </Text>
    </ConfirmDialog>
  );
}
