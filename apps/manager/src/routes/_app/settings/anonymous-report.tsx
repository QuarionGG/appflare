import { createFileRoute } from "@tanstack/react-router";
import { SETTINGS_PAGES } from "../../../components/navigation";
import { UsageDataSettingsView } from "../../../components/settings-pages";
import { getTelemetryStatus } from "../../../telemetry/telemetry.functions";

/** `/settings/anonymous-report`: the anonymous daily report, its switch, and a preview of it. */
export const Route = createFileRoute("/_app/settings/anonymous-report")({
  staticData: { title: SETTINGS_PAGES.usageData.label },
  loader: () => getTelemetryStatus(),
  component: UsageDataPage,
});

function UsageDataPage() {
  const telemetry = Route.useLoaderData();
  const { viewer } = Route.useRouteContext();
  return <UsageDataSettingsView telemetry={telemetry} isAdmin={viewer.role === "admin"} />;
}
