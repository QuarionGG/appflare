import { createFileRoute, useRouter } from "@tanstack/react-router";
import { ImportPage } from "../../../imports/import-page";
import {
  discoverImportWorkers,
  importExistingApp,
  listImportedApps,
  previewImport,
} from "../../../imports/imports.functions";

export const Route = createFileRoute("/_app/imports/")({
  staticData: { title: "Imported apps" },
  loader: () => listImportedApps(),
  component: ImportedAppsPage,
});

function ImportedAppsPage() {
  const apps = Route.useLoaderData();
  const { viewer, accountId } = Route.useRouteContext();
  const router = useRouter();
  return (
    <ImportPage
      apps={apps}
      isAdmin={viewer.role === "admin"}
      accountId={accountId}
      actions={{
        discover: () => discoverImportWorkers(),
        preview: (selection) => previewImport({ data: selection }),
        commit: async (preview) => {
          const app = await importExistingApp({
            data: {
              workerNames: preview.workerNames,
              primaryWorker: preview.primaryWorker,
              displayName: preview.displayName,
              fingerprint: preview.fingerprint,
            },
          });
          await router.invalidate();
          await router.navigate({ href: `/imports/${app.id}` });
        },
      }}
    />
  );
}
