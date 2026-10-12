import { createFileRoute } from "@tanstack/react-router";
import { redirectMovedSettings } from "../../../components/settings-redirect";

/**
 * `/settings/usage-data`, the anonymous report's page under its earlier
 * name: it opens the Anonymous report page, and the anchor it carried
 * (`#usage-data`) opens the same section there.
 */
export const Route = createFileRoute("/_app/settings/usage-data")({
  beforeLoad: ({ location }) => redirectMovedSettings(location),
});
