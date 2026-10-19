import type { CloudflareClient, WorkerScript } from "@appflare/cf-api";
import { SANDBOX_WORKER_NAME } from "@appflare/schema";
import { and, desc, eq, isNull, ne } from "drizzle-orm";
import { ulid } from "ulidx";
import { createDb } from "../db/client";
import { imported_app_workers, imported_apps, installs, resources } from "../db/schema";
import { readSettings, SETTING } from "../db/settings";
import { GATEWAY_WORKER_NAME } from "../gateway/gateway";
import { importCommitInput, importSelectionInput } from "./input";
import type {
  ImportCandidate,
  ImportDiscovery,
  ImportedApp,
  ImportedBinding,
  ImportedDeployment,
  ImportedDomain,
  ImportedWorker,
  ImportPreview,
  ImportRoute,
  ImportSelection,
} from "./types";

/** The import implementation has no access to Cloudflare mutation methods. */
export interface ImportApi {
  accountId: string;
  workers: Pick<
    CloudflareClient["workers"],
    "listScripts" | "getBindings" | "getSubdomain" | "getSchedules"
  >;
  versions: Pick<CloudflareClient["versions"], "listDeployments">;
  workerDomains: Pick<CloudflareClient["workerDomains"], "listDomains">;
}

export interface ImportDeps {
  db: D1Database;
  api: ImportApi;
  now?: () => number;
}

export class ImportError extends Error {
  override name = "ImportError";
}

type Inventory = Pick<ImportedApp, "workers" | "warnings" | "address">;

const text = (value: unknown): string | null =>
  typeof value === "string" && value.length > 0 ? value : null;

function routesOf(script: WorkerScript): ImportRoute[] {
  return (script.routes ?? [])
    .filter((route) => typeof route.id === "string" && typeof route.pattern === "string")
    .map(({ id, pattern }) => ({ id, pattern }))
    .sort((a, b) => a.id.localeCompare(b.id));
}

function candidateOf(script: WorkerScript): ImportCandidate {
  return {
    name: script.id,
    modifiedAt: text(script.modified_on),
    handlers: (script.handlers ?? []).filter((value) => typeof value === "string").sort(),
    routes: routesOf(script),
  };
}

/** Allowlisted references only; plain text, JSON and secret values never leave this function. */
function bindingsOf(raw: unknown[]): ImportedBinding[] {
  return raw
    .filter(
      (value): value is Record<string, unknown> => typeof value === "object" && value !== null,
    )
    .filter((value) => typeof value.name === "string" && typeof value.type === "string")
    .map((value): ImportedBinding => {
      const type = value.type as string;
      const idFields: Record<string, string[]> = {
        kv_namespace: ["namespace_id"],
        d1: ["id", "database_id"],
        durable_object_namespace: ["namespace_id"],
        hyperdrive: ["id"],
        ratelimit: ["namespace_id"],
      };
      const nameFields: Record<string, string[]> = {
        r2_bucket: ["bucket_name"],
        queue: ["queue_name"],
        workflow: ["workflow_name"],
        vectorize: ["index_name"],
      };
      const first = (fields: string[]) =>
        fields.map((field) => text(value[field])).find((field) => field !== null) ?? null;
      const scriptReference = ["durable_object_namespace", "service", "workflow"].includes(type);
      return {
        name: value.name as string,
        type,
        resourceId: first(idFields[type] ?? []),
        resourceName: first(nameFields[type] ?? []),
        scriptName: scriptReference ? (text(value.script_name) ?? text(value.service)) : null,
        className: ["durable_object_namespace", "workflow"].includes(type)
          ? text(value.class_name)
          : null,
      };
    })
    .sort((a, b) => a.name.localeCompare(b.name));
}

async function accountState(deps: ImportDeps, ownAppId?: string) {
  const db = createDb(deps.db);
  const [settings, managed, owned, imported] = await Promise.all([
    readSettings(db, [SETTING.accountId, SETTING.workerName, SETTING.accountSubdomain]),
    db
      .select({ name: installs.worker_name })
      .from(installs)
      .where(ne(installs.status, "uninstalled")),
    db
      .select({ name: resources.name })
      .from(resources)
      .innerJoin(installs, eq(installs.id, resources.install_id))
      .where(
        and(
          eq(resources.kind, "worker"),
          isNull(resources.deleted_at),
          ne(installs.status, "uninstalled"),
        ),
      ),
    db
      .select()
      .from(imported_app_workers)
      .where(eq(imported_app_workers.account_id, deps.api.accountId)),
  ]);
  if (settings.account_id !== deps.api.accountId || !settings.worker_name) {
    throw new ImportError(
      "Appflare's Cloudflare account and Worker identity must be configured before importing.",
    );
  }
  return {
    subdomain: settings.account_subdomain ?? null,
    blocked: new Set([
      settings.worker_name,
      SANDBOX_WORKER_NAME,
      GATEWAY_WORKER_NAME,
      ...managed.map((row) => row.name),
      ...owned.map((row) => row.name),
      ...imported.filter((row) => row.app_id !== ownAppId).map((row) => row.worker_name),
    ]),
  };
}

export async function discoverImportWorkersCore(deps: ImportDeps): Promise<ImportDiscovery> {
  const [state, scripts] = await Promise.all([accountState(deps), deps.api.workers.listScripts()]);
  return {
    workers: scripts
      .filter((script) => !state.blocked.has(script.id))
      .map(candidateOf)
      .sort((a, b) => a.name.localeCompare(b.name)),
    warnings: [],
  };
}

function openAddress(worker: ImportedWorker | undefined, subdomain: string | null): string | null {
  if (worker === undefined || worker.missing) return null;
  if (worker.domains[0]) return `https://${worker.domains[0].hostname}`;
  for (const route of worker.routes) {
    const match = /^(?:https?:\/\/)?([a-zA-Z0-9.-]+)(\/[^?#]*)?$/.exec(route.pattern);
    if (match?.[1]?.includes(".")) {
      return `https://${match[1]}${(match[2] ?? "/").replace(/\*$/, "")}`;
    }
  }
  return worker.workersDevEnabled && subdomain
    ? `https://${worker.name}.${subdomain}.workers.dev`
    : null;
}

async function readInventory(
  deps: ImportDeps,
  selection: ImportSelection,
  previous?: ImportedApp,
): Promise<Inventory> {
  const [state, scripts] = await Promise.all([
    accountState(deps, previous?.id),
    deps.api.workers.listScripts(),
  ]);
  const byName = new Map(scripts.map((script) => [script.id, script]));
  for (const name of selection.workerNames) {
    if (state.blocked.has(name)) {
      throw new ImportError(
        `Worker "${name}" is managed by Appflare, internal, or already imported.`,
      );
    }
    if (!byName.has(name) && previous === undefined) {
      throw new ImportError(`Worker "${name}" no longer exists. Discover Workers again.`);
    }
  }
  const workers = await Promise.all(
    [...selection.workerNames].sort().map(async (name): Promise<ImportedWorker> => {
      const old = previous?.workers.find((worker) => worker.name === name);
      const script = byName.get(name);
      if (script === undefined) {
        if (old === undefined) throw new ImportError(`Worker "${name}" no longer exists.`);
        return {
          ...old,
          missing: true,
          warnings: [`Worker "${name}" was not found. Its last inventory is preserved.`],
        };
      }
      const warnings: string[] = [];
      const read = async <T>(section: string, fetch: () => Promise<T>, fallback: T): Promise<T> => {
        try {
          return await fetch();
        } catch {
          warnings.push(
            `Could not read ${section} for "${name}".${old ? " The last inventory for this section is preserved." : " This section is incomplete."}`,
          );
          return fallback;
        }
      };
      const [bindings, domains, schedules, deployments, workersDevEnabled] = await Promise.all([
        read(
          "bindings",
          async () => bindingsOf(await deps.api.workers.getBindings(name)),
          old?.bindings ?? [],
        ),
        read(
          "custom domains",
          async (): Promise<ImportedDomain[]> =>
            (await deps.api.workerDomains.listDomains({ service: name }))
              .map(({ id, hostname, zone_name }) => ({ id, hostname, zoneName: zone_name }))
              .sort((a, b) => a.hostname.localeCompare(b.hostname)),
          old?.domains ?? [],
        ),
        read(
          "cron schedules",
          async () =>
            (await deps.api.workers.getSchedules(name)).schedules
              .map(({ cron }) => ({ cron }))
              .sort((a, b) => a.cron.localeCompare(b.cron)),
          old?.schedules ?? [],
        ),
        read(
          "deployments",
          async (): Promise<ImportedDeployment[]> =>
            (await deps.api.versions.listDeployments(name)).map((deployment) => ({
              id: deployment.id,
              createdAt: text(deployment.created_on),
              source: text(deployment.source),
              versions: (deployment.versions ?? [])
                .map(({ version_id, percentage }) => ({ versionId: version_id, percentage }))
                .sort((a, b) => a.versionId.localeCompare(b.versionId)),
            })),
          old?.deployments ?? [],
        ),
        read(
          "workers.dev status",
          async () => (await deps.api.workers.getSubdomain(name)).enabled,
          old?.workersDevEnabled ?? null,
        ),
      ]);
      return {
        ...candidateOf(script),
        createdAt: text(script.created_on),
        bindings,
        domains,
        schedules,
        deployments,
        workersDevEnabled,
        missing: false,
        warnings: warnings.sort(),
      };
    }),
  );
  return {
    workers,
    warnings: workers.flatMap((worker) => worker.warnings),
    address: openAddress(
      workers.find((worker) => worker.name === selection.primaryWorker),
      state.subdomain,
    ),
  };
}

async function fingerprintOf(value: unknown): Promise<string> {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(JSON.stringify(value)),
  );
  return [...new Uint8Array(digest)].map((part) => part.toString(16).padStart(2, "0")).join("");
}

export async function previewImportCore(
  deps: ImportDeps,
  input: ImportSelection,
): Promise<ImportPreview> {
  const selection = importSelectionInput.parse(input);
  selection.workerNames.sort();
  const inventory = await readInventory(deps, selection);
  return {
    ...selection,
    ...inventory,
    fingerprint: await fingerprintOf({ accountId: deps.api.accountId, ...selection, ...inventory }),
  };
}

function appOf(row: typeof imported_apps.$inferSelect): ImportedApp {
  const inventory = JSON.parse(row.inventory_json) as Inventory & { workerNames: string[] };
  return {
    ...inventory,
    id: row.id,
    displayName: row.display_name,
    primaryWorker: row.primary_worker,
    importedAt: row.imported_at.toISOString(),
    refreshedAt: row.refreshed_at.toISOString(),
  };
}

export async function listImportedAppsCore(db: D1Database): Promise<ImportedApp[]> {
  const rows = await createDb(db)
    .select()
    .from(imported_apps)
    .orderBy(desc(imported_apps.imported_at));
  return rows.map(appOf);
}

export async function getImportedAppCore(
  db: D1Database,
  appId: string,
): Promise<ImportedApp | null> {
  const [row] = await createDb(db)
    .select()
    .from(imported_apps)
    .where(eq(imported_apps.id, appId))
    .limit(1);
  return row ? appOf(row) : null;
}

/** Reads a saved import's current inventory without changing its metadata or deployment. */
export async function readImportedAppInventoryCore(
  deps: ImportDeps,
  appId: string,
): Promise<ImportedApp> {
  const previous = await getImportedAppCore(deps.db, appId);
  if (previous === null) throw new ImportError("This imported app no longer exists.");
  const [row] = await createDb(deps.db)
    .select({ accountId: imported_apps.account_id })
    .from(imported_apps)
    .where(eq(imported_apps.id, appId))
    .limit(1);
  if (row?.accountId !== deps.api.accountId) {
    throw new ImportError("This imported app does not belong to the connected account.");
  }
  return { ...previous, ...(await readInventory(deps, previous, previous)) };
}

export async function importExistingAppCore(
  deps: ImportDeps,
  input: ImportSelection & { fingerprint: string },
): Promise<ImportedApp> {
  const checked = importCommitInput.parse(input);
  // Client metadata is never accepted. Inventory is read again before the atomic D1 write.
  const preview = await previewImportCore(deps, checked);
  if (preview.fingerprint !== checked.fingerprint) {
    throw new ImportError(
      "The deployment changed since the preview. Review a fresh preview before importing.",
    );
  }
  const id = ulid();
  const now = deps.now?.() ?? Date.now();
  const { fingerprint: _fingerprint, displayName, primaryWorker, ...inventory } = preview;
  try {
    await deps.db.batch([
      deps.db
        .prepare(`INSERT INTO imported_apps
        (id, account_id, display_name, primary_worker, inventory_json, imported_at, refreshed_at)
        VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?6)`)
        .bind(id, deps.api.accountId, displayName, primaryWorker, JSON.stringify(inventory), now),
      ...preview.workerNames.map((name) =>
        deps.db
          .prepare(
            "INSERT INTO imported_app_workers (account_id, worker_name, app_id) VALUES (?1, ?2, ?3)",
          )
          .bind(deps.api.accountId, name, id),
      ),
    ]);
  } catch (error) {
    if (error instanceof Error && /UNIQUE constraint failed/.test(error.message)) {
      throw new ImportError("A selected Worker was already imported. Discover Workers again.");
    }
    throw error;
  }
  return {
    ...inventory,
    id,
    displayName,
    primaryWorker,
    importedAt: new Date(now).toISOString(),
    refreshedAt: new Date(now).toISOString(),
  };
}

export async function refreshImportedAppCore(
  deps: ImportDeps,
  appId: string,
): Promise<ImportedApp> {
  const previous = await getImportedAppCore(deps.db, appId);
  if (previous === null) throw new ImportError("This imported app no longer exists.");
  const inventory = await readInventory(deps, previous, previous);
  const now = deps.now?.() ?? Date.now();
  const updated = await createDb(deps.db)
    .update(imported_apps)
    .set({
      inventory_json: JSON.stringify({ ...inventory, workerNames: previous.workerNames }),
      refreshed_at: new Date(now),
    })
    .where(and(eq(imported_apps.id, appId), eq(imported_apps.account_id, deps.api.accountId)))
    .returning();
  if (updated.length === 0)
    throw new ImportError("This imported app no longer exists in the connected account.");
  return appOf(updated[0] as typeof imported_apps.$inferSelect);
}

/** Deletes manager metadata only. This function intentionally has no Cloudflare client. */
export async function forgetImportedAppCore(
  db: D1Database,
  appId: string,
): Promise<{ id: string }> {
  await db.batch([
    db.prepare("DELETE FROM imported_app_workers WHERE app_id = ?1").bind(appId),
    db.prepare("DELETE FROM imported_apps WHERE id = ?1").bind(appId),
  ]);
  return { id: appId };
}
