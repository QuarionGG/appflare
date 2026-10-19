/** Safe metadata only. Imported apps keep their existing deployment and resources. */
/** Keeps discovery and the five reads per Worker below Workers Free's subrequest budget. */
export const MAX_IMPORTED_WORKERS = 6;

export interface ImportRoute {
  id: string;
  pattern: string;
}

export interface ImportCandidate {
  name: string;
  modifiedAt: string | null;
  handlers: string[];
  routes: ImportRoute[];
}

export interface ImportDiscovery {
  workers: ImportCandidate[];
  warnings: string[];
}

/** Values of variables and secrets are deliberately never inventoried. */
export interface ImportedBinding {
  name: string;
  type: string;
  resourceId: string | null;
  resourceName: string | null;
  scriptName: string | null;
  className: string | null;
}

export interface ImportedDomain {
  id: string;
  hostname: string;
  zoneName: string;
}

export interface ImportedDeployment {
  id: string;
  createdAt: string | null;
  source: string | null;
  versions: Array<{ versionId: string; percentage: number }>;
}

export interface ImportedWorker {
  name: string;
  createdAt: string | null;
  modifiedAt: string | null;
  handlers: string[];
  bindings: ImportedBinding[];
  domains: ImportedDomain[];
  routes: ImportRoute[];
  schedules: Array<{ cron: string }>;
  deployments: ImportedDeployment[];
  workersDevEnabled: boolean | null;
  warnings: string[];
  missing: boolean;
}

export interface ImportSelection {
  workerNames: string[];
  primaryWorker: string;
  displayName: string;
}

export interface ImportPreview extends ImportSelection {
  workers: ImportedWorker[];
  warnings: string[];
  fingerprint: string;
  address: string | null;
}

export interface ImportedApp extends ImportSelection {
  id: string;
  importedAt: string;
  refreshedAt: string;
  workers: ImportedWorker[];
  warnings: string[];
  address: string | null;
}
