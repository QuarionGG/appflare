import { AppflareLoader } from "@appflare/brand/loader";
import { useKumoToastManager } from "@cloudflare/kumo";
import { useCallback, useEffect, useRef, useState } from "react";
import { Section } from "../../components/section";
import { createAlertRuleFn, deleteAlertRuleFn, updateAlertRuleFn } from "../alert-rules.functions";
import { setObservabilityFn } from "../observability.functions";
import type { UsageTabData } from "../tab";
import { getUsageTab, setAppSpend } from "../tab.functions";
import { RecentActivity } from "./recent-activity";
import { type SpendActions, SpendProtectionSection } from "./spend-protection";
import { StateBanner } from "./state-banner";
import { UsageSection } from "./usage-section";

/**
 * An installed app's Usage tab: a banner when it needs attention, usage by
 * product with a chart, its spend protection, and recent activity. Read
 * when the tab opens, and again whenever the page's own data is (after a
 * Pause or Resume, say); each change of a setting answers with the tab read
 * again. Changes are sent one after another, in the order they were made.
 */

export const USAGE_TAB_COPY = {
  readFailed: "Usage could not be read just now. Reload the page to try again.",
  noInstall: "There is no such app.",
  saveFailed: "Could not save the change.",
} as const;

function errorText(error: unknown, fallback: string): string {
  return error instanceof Error && error.message !== "" ? error.message : fallback;
}

interface TabState {
  data: UsageTabData | null;
  /** Reading the tab failed. */
  error: string | null;
  loading: boolean;
}

function useUsageTab(installId: string, reloadKey: unknown) {
  const [state, setState] = useState<TabState>({ data: null, error: null, loading: true });
  /** The newest read or answer wins; an older one arriving late is dropped. */
  const latest = useRef(0);
  const load = useCallback(async () => {
    const id = ++latest.current;
    try {
      const data = await getUsageTab({ data: { installId } });
      if (id !== latest.current) return;
      setState({
        data,
        error: data === null ? USAGE_TAB_COPY.noInstall : null,
        loading: false,
      });
    } catch (error) {
      if (id !== latest.current) return;
      setState((s) => ({
        ...s,
        error: errorText(error, USAGE_TAB_COPY.readFailed),
        loading: false,
      }));
    }
  }, [installId]);
  // biome-ignore lint/correctness/useExhaustiveDependencies: read again whenever the page's own data is.
  useEffect(() => {
    void load();
  }, [load, reloadKey]);
  const apply = useCallback((data: UsageTabData | null) => {
    latest.current++;
    if (data !== null) setState({ data, error: null, loading: false });
  }, []);
  return { ...state, load, apply };
}

export function UsageTab({
  installId,
  app,
  isAdmin,
  reloadKey,
}: {
  installId: string;
  /** The app's name. */
  app: string;
  isAdmin: boolean;
  /** Changes whenever the page's own data is read again. */
  reloadKey?: unknown;
}) {
  const toasts = useKumoToastManager();
  const { data, error, loading, load, apply } = useUsageTab(installId, reloadKey);
  const [saveError, setSaveError] = useState<string | null>(null);
  const queue = useRef<Promise<unknown>>(Promise.resolve());

  /** Runs one change after the ones before it; resolves to its error, or null. */
  const run = useCallback(
    (change: () => Promise<UsageTabData | null>): Promise<string | null> => {
      const next = queue.current.then(async () => {
        try {
          apply(await change());
          return null;
        } catch (err) {
          // What was shown before the change comes back with the tab read again.
          void load();
          return errorText(err, USAGE_TAB_COPY.saveFailed);
        }
      });
      queue.current = next;
      return next;
    },
    [apply, load],
  );

  const actions: SpendActions = {
    save: async (patch) => {
      setSaveError(null);
      setSaveError(await run(() => setAppSpend({ data: { installId, patch } })));
    },
    addRule: (rule) => run(() => createAlertRuleFn({ data: { installId, rule } })),
    changeRule: (ruleId, rule) =>
      run(() => updateAlertRuleFn({ data: { installId, ruleId, rule } })),
    removeRule: async (ruleId) => {
      setSaveError(null);
      setSaveError(await run(() => deleteAlertRuleFn({ data: { installId, ruleId } })));
    },
  };

  async function turnOnLogs() {
    try {
      await setObservabilityFn({ data: { installId, enabled: true } });
      toasts.add({
        title: "Workers Logs turned on",
        description: "Usage from logs shows in Cloudflare within a couple of minutes.",
        variant: "info",
      });
      await load();
    } catch (err) {
      toasts.add({ title: errorText(err, "Could not turn on Workers Logs."), variant: "error" });
    }
  }

  if (data === null) {
    return (
      <Section id="usage" title="Usage by product" error={loading ? null : error}>
        {loading && (
          <div className="flex h-40 items-center justify-center">
            <AppflareLoader size={32} aria-label="Reading usage" />
          </div>
        )}
      </Section>
    );
  }
  return (
    <>
      <StateBanner data={data} app={app} isAdmin={isAdmin} />
      <UsageSection data={data} app={app} isAdmin={isAdmin} onTurnOnLogs={turnOnLogs} />
      <SpendProtectionSection
        data={data}
        isAdmin={isAdmin}
        error={saveError ?? error}
        actions={actions}
      />
      <RecentActivity events={data.events} channels={data.spend.channels} />
    </>
  );
}
