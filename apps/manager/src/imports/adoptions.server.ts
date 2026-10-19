import type { CloudflareClient } from "@appflare/cf-api";
import { parseRepositoryInput, repositoryUrl } from "@appflare/schema";
import { eq, isNull } from "drizzle-orm";
import { ulid } from "ulidx";
import { createDb } from "../db/client";
import { installs, resources } from "../db/schema";
import { repositoryAppSlug } from "../installs/source-review";
import type { AdoptionPreview, AdoptionResource } from "./adoption-types";
import { type AdoptionInput, adoptionCommitInput, adoptionInput } from "./adoptions-input";
import {
  type ImportApi,
  listImportedAppsCore,
  readImportedAppInventoryCore,
} from "./imports.server";
import type { ImportedApp, ImportedBinding } from "./types";

/** Adoption reads Cloudflare; only the manager's own D1 receives writes. */
export interface AdoptionDeps {
  db: D1Database;
  api: ImportApi & {
    d1: Pick<CloudflareClient["d1"], "listDatabases" | "bookmark">;
    kv: Pick<CloudflareClient["kv"], "listNamespaces">;
  };
  now?: () => number;
  newId?: () => string;
}

export class AdoptionError extends Error {
  override name = "AdoptionError";
}

function fail(message: string): never {
  throw new AdoptionError(message);
}

const INTRINSIC_BINDINGS = new Set(["plain_text", "json", "assets", "images", "worker_loader"]);

function bindingIdentity(binding: ImportedBinding): string | null {
  if (binding.type === "d1" || binding.type === "kv_namespace") return binding.resourceId;
  if (binding.type === "r2_bucket") return binding.resourceName;
  return null;
}

function dataKind(binding: ImportedBinding): "d1" | "kv" | "r2" | null {
  if (binding.type === "d1") return "d1";
  if (binding.type === "kv_namespace") return "kv";
  if (binding.type === "r2_bucket") return "r2";
  return null;
}

/** Values are held as ordinary install settings, never copied into the adoption inventory or log. */
function varsOf(bindings: unknown[]): Record<string, string> {
  const vars: Record<string, string> = Object.create(null);
  for (const raw of bindings) {
    if (raw === null || typeof raw !== "object") continue;
    const binding = raw as Record<string, unknown>;
    if (typeof binding.name !== "string") continue;
    if (binding.type === "plain_text" && typeof binding.text === "string") {
      vars[binding.name] = binding.text;
    } else if (binding.type === "json" && Object.hasOwn(binding, "json")) {
      const value = JSON.stringify(binding.json);
      if (value !== undefined) vars[binding.name] = value;
    }
  }
  return vars;
}

async function fingerprint(value: unknown): Promise<string> {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(JSON.stringify(value)),
  );
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

interface AdoptionPlan {
  preview: AdoptionPreview;
  appSlug: string;
  inventory: ImportedApp;
  vars: Record<string, string>;
}

async function readPlan(deps: AdoptionDeps, input: AdoptionInput): Promise<AdoptionPlan> {
  const request = adoptionInput.parse(input);
  const repository = parseRepositoryInput(request.repository);
  if (!repository.ok) fail(repository.error);
  const normalized = { ...request, repository: repositoryUrl(repository.repo) };
  const inventory = await readImportedAppInventoryCore(deps, request.appId);
  if (inventory.workers.length !== 1 || inventory.workerNames.length !== 1) {
    fail(
      "Managing an existing deployment currently supports one Worker. Keep this group imported.",
    );
  }
  const worker = inventory.workers[0];
  if (worker === undefined || worker.missing) fail("The imported Worker no longer exists.");
  if (inventory.warnings.length > 0) {
    fail("The current deployment inventory is incomplete. Resolve its warnings and preview again.");
  }
  const serving = worker.deployments[0]?.versions ?? [];
  const version = serving[0];
  if (serving.length !== 1 || version?.percentage !== 100 || !version.versionId) {
    fail("The Worker must have one version serving 100% of traffic before it can be managed.");
  }
  if (worker.workersDevEnabled === null) fail("The Worker's workers.dev status could not be read.");
  const unsupported = worker.bindings.filter(
    (binding) =>
      !INTRINSIC_BINDINGS.has(binding.type) &&
      binding.type !== "secret_text" &&
      dataKind(binding) === null,
  );
  if (unsupported.length > 0) {
    fail(
      `This deployment has bindings whose lifecycle adoption does not support yet: ${unsupported
        .map((binding) => `${binding.name} (${binding.type})`)
        .join(", ")}. Keep it imported until they are supported.`,
    );
  }
  const bindings = worker.bindings.filter((binding) => dataKind(binding) !== null);
  for (const binding of bindings) {
    if (bindingIdentity(binding) === null) {
      fail(`The existing resource ID of ${binding.name} could not be read. Preview again.`);
    }
  }
  const [databases, namespaces, rawBindings, managed, otherImports] = await Promise.all([
    bindings.some((binding) => binding.type === "d1")
      ? deps.api.d1.listDatabases()
      : Promise.resolve([]),
    bindings.some((binding) => binding.type === "kv_namespace")
      ? deps.api.kv.listNamespaces()
      : Promise.resolve([]),
    deps.api.workers.getBindings(worker.name),
    createDb(deps.db)
      .select({
        installId: resources.install_id,
        kind: resources.kind,
        cfId: resources.cf_id,
        name: resources.name,
      })
      .from(resources)
      .innerJoin(installs, eq(installs.id, resources.install_id))
      .where(isNull(resources.deleted_at)),
    listImportedAppsCore(deps.db),
  ]);
  const adopted: AdoptionResource[] = [
    { kind: "worker", binding: null, name: worker.name, cfId: worker.name, managedBy: "appflare" },
  ];
  for (const binding of bindings) {
    const kind = dataKind(binding);
    const cfId = bindingIdentity(binding);
    if (kind === null || cfId === null) continue;
    const name =
      kind === "d1"
        ? databases.find((database) => database.uuid === cfId)?.name
        : kind === "kv"
          ? namespaces.find((namespace) => namespace.id === cfId)?.title
          : cfId;
    if (!name) fail(`The existing ${kind} resource for ${binding.name} was not found.`);
    if (
      managed.some((resource) => resource.kind === kind && resource.cfId === cfId) ||
      otherImports.some(
        (app) =>
          app.id !== inventory.id &&
          app.workers.some((other) =>
            other.bindings.some(
              (candidate) => dataKind(candidate) === kind && bindingIdentity(candidate) === cfId,
            ),
          ),
      )
    ) {
      fail(`The ${kind} resource "${name}" is already recorded for another app.`);
    }
    adopted.push({ kind, binding: binding.name, name, cfId, managedBy: "appflare" });
  }
  for (const binding of worker.bindings.filter((binding) => binding.type === "secret_text")) {
    adopted.push({
      kind: "secret",
      binding: binding.name,
      name: binding.name,
      cfId: null,
      managedBy: "appflare",
    });
  }
  for (const schedule of worker.schedules) {
    adopted.push({
      kind: "cron",
      binding: null,
      name: schedule.cron,
      cfId: null,
      managedBy: "appflare",
    });
  }
  for (const domain of worker.domains) {
    if (
      managed.some((resource) => resource.kind === "domain" && resource.name === domain.hostname)
    ) {
      fail(`The custom domain "${domain.hostname}" is already recorded for another app.`);
    }
    adopted.push({
      kind: "domain",
      binding: null,
      name: domain.hostname,
      cfId: domain.id,
      managedBy: "appflare",
    });
  }
  for (const route of worker.routes) {
    adopted.push({
      kind: "worker_route",
      binding: null,
      name: route.pattern,
      cfId: null,
      managedBy: "app",
    });
  }
  const vars = varsOf(rawBindings);
  const warnings = [
    "Adoption records the existing deployment without redeploying it or changing its data, secrets or addresses.",
    "Appflare will manage its lifecycle. Uninstall removes the Worker and its custom domains; you choose which data resources to keep.",
    "Settings changes require the first reviewed build of the custom source. Catalog releases never replace this deployment.",
  ];
  return {
    inventory,
    vars,
    appSlug: repositoryAppSlug(repository.repo),
    preview: {
      ...normalized,
      fingerprint: await fingerprint({ input: normalized, inventory, resources: adopted, vars }),
      workerName: worker.name,
      currentVersionId: version.versionId,
      address: inventory.address,
      resources: adopted,
      resourceCount: adopted.length,
      warnings,
    },
  };
}

export async function previewAdoptionCore(
  deps: AdoptionDeps,
  input: AdoptionInput,
): Promise<AdoptionPreview> {
  return (await readPlan(deps, input)).preview;
}

/** Moves one inventory into the normal install model in one manager D1 transaction. */
export async function adoptImportedAppCore(
  deps: AdoptionDeps,
  input: AdoptionInput & { fingerprint: string },
): Promise<{ installId: string; jobId: string }> {
  const checked = adoptionCommitInput.parse(input);
  const { preview, inventory, vars, appSlug } = await readPlan(deps, checked);
  if (preview.fingerprint !== checked.fingerprint) {
    fail("The deployment or adoption choices changed since the preview. Review a fresh preview.");
  }
  const bookmarks = Object.fromEntries(
    await Promise.all(
      [
        ...new Set(
          preview.resources
            .filter((resource) => resource.kind === "d1")
            .map((resource) => resource.cfId),
        ),
      ]
        .filter((id): id is string => id !== null)
        .map(async (id) => {
          const bookmark = (await deps.api.d1.bookmark(id)).bookmark;
          if (typeof bookmark !== "string" || bookmark.length === 0) {
            fail(`The D1 recovery bookmark for ${id} could not be read. Adoption has not started.`);
          }
          return [id, bookmark];
        }),
    ),
  );
  const now = deps.now?.() ?? Date.now();
  const jobId = (deps.newId ?? ulid)();
  const snapshotId = (deps.newId ?? ulid)();
  const installId = preview.appId;
  const worker = inventory.workers[0];
  if (worker === undefined) fail("The Worker inventory is missing.");
  const knownData = preview.resources.filter((resource) =>
    ["d1", "r2", "kv"].includes(resource.kind),
  );
  const ownershipGuard = knownData
    .map(
      (_, index) =>
        `NOT EXISTS (SELECT 1 FROM resources r JOIN installs i ON i.id = r.install_id
          WHERE r.kind = ?${index * 2 + 13} AND r.cf_id = ?${index * 2 + 14}
            AND r.deleted_at IS NULL)`,
    )
    .join(" AND ");
  const guard = `EXISTS (SELECT 1 FROM jobs WHERE id = ?1 AND install_id = ?2 AND kind = 'adopt')`;
  const statements: D1PreparedStatement[] = [
    deps.db
      .prepare(
        `INSERT INTO installs
       (id, app_slug, worker_name, instance_name, display_name, catalog_version, artifact_url,
        status, current_version_id, config_json, build_kind, origin, source_url, source_ref,
        auto_update, workers_dev_enabled, workers_dev_choice, served_domain, installed_at, updated_at)
       SELECT ?1, ?12, ?2, ?3, ?3, 'Existing deployment', '', 'installed', ?4, ?5, 'adopted',
         'repository', ?6, ?7, 'off', ?8, 'manual', ?9, ?10, ?10
       WHERE EXISTS (SELECT 1 FROM imported_apps WHERE id = ?1 AND account_id = ?11)
         AND NOT EXISTS (SELECT 1 FROM installs WHERE id = ?1 OR (worker_name = ?2 AND status != 'uninstalled'))
         AND NOT EXISTS (SELECT 1 FROM resources r JOIN installs i ON i.id = r.install_id
           WHERE r.kind = 'worker' AND r.name = ?2 AND r.deleted_at IS NULL AND i.status != 'uninstalled')
         AND NOT EXISTS (SELECT 1 FROM imported_app_workers WHERE worker_name = ?2 AND account_id = ?11 AND app_id != ?1)
         ${ownershipGuard.length > 0 ? `AND ${ownershipGuard}` : ""}`,
      )
      .bind(
        installId,
        preview.workerName,
        preview.displayName,
        preview.currentVersionId,
        JSON.stringify(vars),
        preview.repository,
        preview.ref,
        worker.workersDevEnabled ? 1 : 0,
        !worker.workersDevEnabled ? (worker.domains[0]?.hostname ?? null) : null,
        now,
        deps.api.accountId,
        appSlug,
        ...knownData.flatMap((resource) => [resource.kind, resource.cfId]),
      ),
    deps.db
      .prepare(
        `INSERT INTO install_adoptions (install_id, imported_app_id, app_name, primary_url, inventory_json, adopted_at)
       SELECT ?1, ?1, ?2, ?3, ?4, ?5 WHERE changes() = 1`,
      )
      .bind(installId, preview.appName, preview.address, JSON.stringify(inventory), now),
    deps.db
      .prepare(
        `INSERT INTO jobs (id, install_id, kind, status, input_json, worker_version_id, started_at, finished_at)
       SELECT ?1, ?2, 'adopt', 'succeeded', ?3, ?4, ?5, ?5 WHERE changes() = 1`,
      )
      .bind(
        jobId,
        installId,
        JSON.stringify({
          installId,
          importedAppId: installId,
          workerName: preview.workerName,
          appName: preview.appName,
        }),
        preview.currentVersionId,
        now,
      ),
    ...preview.resources.map((resource) =>
      deps.db
        .prepare(
          `INSERT INTO resources (id, install_id, kind, binding, name, cf_id, managed_by, created_at)
         SELECT ?3, ?2, ?4, ?5, ?6, ?7, ?8, ?9 WHERE ${guard}`,
        )
        .bind(
          jobId,
          installId,
          `${installId}:${resource.kind}:${resource.binding ?? resource.name}`,
          resource.kind,
          resource.binding,
          resource.name,
          resource.cfId,
          resource.managedBy,
          now,
        ),
    ),
    deps.db
      .prepare(
        `INSERT INTO snapshots
       (id, install_id, job_id, worker_version_id, d1_bookmarks_json, taken_at, catalog_version,
        artifact_url, build_kind, origin, source_url, source_ref, config_json)
       SELECT ?3, ?2, ?1, ?4, ?5, ?6, 'Existing deployment', '', 'adopted', 'repository', ?7, ?8, ?9
       WHERE ${guard}`,
      )
      .bind(
        jobId,
        installId,
        snapshotId,
        preview.currentVersionId,
        JSON.stringify(bookmarks),
        now,
        preview.repository,
        preview.ref,
        JSON.stringify(vars),
      ),
    deps.db
      .prepare(`DELETE FROM imported_app_workers WHERE app_id = ?2 AND ${guard}`)
      .bind(jobId, installId),
    deps.db.prepare(`DELETE FROM imported_apps WHERE id = ?2 AND ${guard}`).bind(jobId, installId),
  ];
  try {
    const [claim] = await deps.db.batch(statements);
    if (claim?.meta.changes !== 1)
      fail("This deployment became managed or its ownership changed. Preview again.");
  } catch (error) {
    if (error instanceof Error && /UNIQUE constraint failed/.test(error.message)) {
      fail("This deployment or one of its resources became managed meanwhile. Preview again.");
    }
    throw error;
  }
  return { installId, jobId };
}
