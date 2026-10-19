import { Empty, LinkButton } from "@cloudflare/kumo";
import { CloudArrowDownIcon } from "@phosphor-icons/react";
import { createFileRoute, redirect, useRouter } from "@tanstack/react-router";
import {
  adoptImportedApp,
  getAdoptedInstall,
  previewAdoption,
} from "../../../imports/adoptions.functions";
import { ImportedAppDetail } from "../../../imports/imported-app-detail";
import {
  forgetImportedApp,
  getImportedApp,
  refreshImportedApp,
} from "../../../imports/imports.functions";

export const Route = createFileRoute("/_app/imports/$appId")({
  loader: async ({ params }) => {
    const app = await getImportedApp({ data: { appId: params.appId } });
    if (app !== null) return app;
    const adopted = await getAdoptedInstall({ data: { appId: params.appId } });
    if (adopted !== null) throw redirect({ href: `/apps/${adopted.installId}` });
    return null;
  },
  head: ({ loaderData }) => ({
    meta: [{ title: `${loaderData?.displayName ?? "Imported app"} · Appflare` }],
  }),
  component: ImportedAppPage,
});

function ImportedAppPage() {
  const app = Route.useLoaderData();
  const { viewer, accountId } = Route.useRouteContext();
  const router = useRouter();
  if (app === null)
    return (
      <Empty
        icon={<CloudArrowDownIcon size={48} className="text-kumo-inactive" />}
        title="Imported app not found"
        description="The imported record may have been forgotten. Its Cloudflare resources are separate from this record."
        contents={
          <LinkButton href="/imports" variant="secondary">
            Imported apps
          </LinkButton>
        }
      />
    );
  return (
    <ImportedAppDetail
      app={app}
      accountId={accountId}
      isAdmin={viewer.role === "admin"}
      adoption={{
        actions: {
          preview: (selection) => previewAdoption({ data: selection }),
          commit: (selection) => adoptImportedApp({ data: selection }),
        },
        onAdopted: async (installId) => {
          await router.invalidate();
          await router.navigate({ href: `/apps/${installId}` });
        },
      }}
      onRefresh={async () => {
        await refreshImportedApp({ data: { appId: app.id } });
        await router.invalidate();
      }}
      onForget={async () => {
        await forgetImportedApp({ data: { appId: app.id } });
        await router.invalidate();
        await router.navigate({ href: "/imports" });
      }}
    />
  );
}
