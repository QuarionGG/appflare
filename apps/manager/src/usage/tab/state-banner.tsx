import { Banner } from "@cloudflare/kumo";
import {
  ACTIONS_UNDER_ON_PHONE,
  BANNER_ICON,
  BannerActions,
  bannerRole,
} from "../../components/message-text";
import { PauseAppButton, ResumeAppButton } from "../../home/pause-resume-buttons";
import type { UsageTabData } from "../tab";
import { stateBanner } from "./copy";

/**
 * Above the tab when the app needs attention: far above normal or a free
 * daily limit used up (with Pause app), paused (with Resume), or busier
 * than usual. Pause and Resume behave as on Home; members see the words
 * without the buttons.
 */
export function StateBanner({
  data,
  app,
  isAdmin,
}: {
  data: UsageTabData;
  /** The app's name. */
  app: string;
  isAdmin: boolean;
}) {
  const copy = stateBanner(data.status, data.spend.effective.autoPause.on);
  if (copy === null) return null;
  const action =
    !isAdmin || copy.action === null ? undefined : copy.action === "pause" ? (
      <BannerActions>
        <PauseAppButton installId={data.installId} label={app} />
      </BannerActions>
    ) : (
      <BannerActions>
        <ResumeAppButton
          installId={data.installId}
          label={app}
          stillPastCap={data.pause?.stillPastCap ?? null}
        />
      </BannerActions>
    );
  return (
    <Banner
      variant={copy.variant}
      icon={BANNER_ICON[copy.variant]}
      role={bannerRole(copy.variant)}
      title={copy.title}
      description={copy.description}
      action={action}
      className={action === undefined ? undefined : ACTIONS_UNDER_ON_PHONE}
    />
  );
}
