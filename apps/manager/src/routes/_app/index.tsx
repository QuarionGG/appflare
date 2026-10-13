import { createFileRoute, redirect } from "@tanstack/react-router";
import { useState } from "react";
import { useStartUpdate } from "../../components/update-banner";
import { homeLanding } from "../../home/home-landing";
import { HomeView } from "../../home/home-view";
import { useAttention } from "../../home/use-attention";
import type { HomeUsageData } from "../../usage/home";
import { getHomeUsage } from "../../usage/home.functions";

/**
 * `/` (Home): what needs attention, the account's usage, then the installed
 * apps as cards, from the signed-in layout's data (`getLayoutData`), which
 * the sidebar's count and dots read too, and Home's usage (`getHomeUsage`),
 * read beside it. With nothing installed, arriving here goes on to the
 * catalog; a click on Home stays and says so (`home-landing.ts`).
 */
export const Route = createFileRoute("/_app/")({
  staticData: { title: "Home" },
  loader: async ({ location, parentMatchPromise }): Promise<{ usage: HomeUsageData | null }> => {
    // Read at once, beside the layout's data; Home still shows when it fails.
    const usage = getHomeUsage().catch(() => null);
    const layout = await parentMatchPromise;
    const installed = layout.loaderData?.apps.length;
    if (installed !== undefined && homeLanding(installed, location.state) === "catalog") {
      throw redirect({ to: "/catalog", replace: true });
    }
    return { usage: await usage };
  },
  component: HomePage,
});

function HomePage() {
  const [leftForAdmin, setLeftForAdmin] = useState<ReadonlyMap<string, string>>();
  const { data, isAdmin, items, dismissAccountRow } = useAttention(leftForAdmin);
  const { usage } = Route.useLoaderData();
  const update = useStartUpdate();
  return (
    <HomeView
      apps={data.apps}
      items={items}
      isAdmin={isAdmin}
      update={update}
      onDismissAccountRow={dismissAccountRow}
      onUpdateAllOutcome={(outcome) =>
        setLeftForAdmin(new Map(outcome.needsInput.map((i) => [i.installId, i.reason])))
      }
      now={new Date()}
      usage={usage}
    />
  );
}
