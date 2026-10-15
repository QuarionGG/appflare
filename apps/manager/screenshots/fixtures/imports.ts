import type {
  ImportCandidate,
  ImportedApp,
  ImportedWorker,
  ImportSelection,
} from "../../src/imports/types";

const now = "2026-10-15T12:00:00.000Z";
const names = [
  "quariongg-emdash-demo",
  "quariongg-calendar",
  "quariongg-transfer",
  "mailflare",
  "mailflare-email",
] as const;

function worker(name: string): ImportedWorker {
  const domain =
    name === "quariongg-emdash-demo"
      ? "quariongg.com"
      : name === "quariongg-calendar"
        ? "cal.quariongg.com"
        : name === "quariongg-transfer"
          ? "transfer.quariongg.com"
          : name === "mailflare"
            ? "mail.example.com"
            : null;
  return {
    name,
    createdAt: "2026-09-01T12:00:00.000Z",
    modifiedAt: now,
    handlers: name.endsWith("-email") ? ["email"] : ["fetch", "scheduled"],
    bindings:
      name === "quariongg-transfer"
        ? [
            {
              name: "TRANSFERS",
              type: "r2_bucket",
              resourceId: null,
              resourceName: "quariongg-transfer",
              scriptName: null,
              className: null,
            },
            {
              name: "ROOMS",
              type: "durable_object_namespace",
              resourceId: "existing-room-namespace",
              resourceName: null,
              scriptName: null,
              className: "Room",
            },
            {
              name: "OWNER_USER_ID",
              type: "secret_text",
              resourceId: null,
              resourceName: null,
              scriptName: null,
              className: null,
            },
          ]
        : [
            {
              name: "DB",
              type: "d1",
              resourceId: "existing-database",
              resourceName: null,
              scriptName: null,
              className: null,
            },
            {
              name: "AUTH_SECRET",
              type: "secret_text",
              resourceId: null,
              resourceName: null,
              scriptName: null,
              className: null,
            },
          ],
    domains:
      domain === null
        ? []
        : [
            {
              id: `domain-${name}`,
              hostname: domain,
              zoneName: domain === "mail.example.com" ? "example.com" : "quariongg.com",
            },
          ],
    routes: [],
    schedules: name.endsWith("-email") ? [] : [{ cron: "*/5 * * * *" }],
    deployments: [
      {
        id: `deployment-${name}`,
        createdAt: now,
        source: "wrangler",
        versions: [{ versionId: "current-worker-version", percentage: 100 }],
      },
    ],
    workersDevEnabled: false,
    warnings: [],
    missing: false,
  };
}

export const importedAppFixtures: ImportedApp[] = [
  {
    id: "existing-website",
    displayName: "QuarionGG website",
    primaryWorker: names[0],
    workerNames: [names[0]],
    importedAt: now,
    refreshedAt: now,
    address: "https://quariongg.com",
    workers: [worker(names[0])],
    warnings: [],
  },
];

function selection(args: unknown[]): ImportSelection {
  return (args[0] as { data: ImportSelection }).data;
}

function preview(args: unknown[]) {
  const input = selection(args);
  const workers = input.workerNames.map(worker);
  const primary = workers.find((item) => item.name === input.primaryWorker);
  return {
    ...input,
    workers,
    warnings: [],
    fingerprint: "fixture-reviewed-inventory",
    address: primary?.domains[0] ? `https://${primary.domains[0].hostname}` : null,
  };
}

export const importedFunctionFixtures: Record<string, (args: unknown[]) => unknown> = {
  listImportedApps: () => [...importedAppFixtures],
  getImportedApp: (args) =>
    importedAppFixtures.find(
      (app) => app.id === (args[0] as { data: { appId: string } }).data.appId,
    ) ?? null,
  discoverImportWorkers: () => ({
    workers: names
      .filter((name) => !importedAppFixtures.some((app) => app.workerNames.includes(name)))
      .map(
        (name): ImportCandidate => ({
          name,
          modifiedAt: now,
          handlers: worker(name).handlers,
          routes: [],
        }),
      ),
    warnings: [],
  }),
  previewImport: preview,
  importExistingApp: (args) => {
    const { fingerprint: _fingerprint, ...inventory } = preview(args);
    const app: ImportedApp = {
      ...inventory,
      id: `imported-${importedAppFixtures.length + 1}`,
      importedAt: now,
      refreshedAt: now,
    };
    importedAppFixtures.push(app);
    return app;
  },
  refreshImportedApp: (args) => importedFunctionFixtures.getImportedApp?.(args),
  forgetImportedApp: (args) => {
    const index = importedAppFixtures.findIndex(
      (app) => app.id === (args[0] as { data: { appId: string } }).data.appId,
    );
    if (index >= 0) importedAppFixtures.splice(index, 1);
    return { ok: true };
  },
};
