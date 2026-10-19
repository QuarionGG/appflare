import { eq } from "drizzle-orm";
import { createDb } from "../db/client";
import { install_adoptions } from "../db/schema";

export interface InstallAdoption {
  appName: string;
  address: string | null;
  adoptedAt: string;
  routes: Array<{ workerName: string; pattern: string }>;
}

/** Existing routing stays with the original deployment, including its DNS. */
export function adoptionAddress(value: string | null): string | null {
  if (value === null) return null;
  try {
    const url = new URL(value);
    return url.protocol === "https:" && !url.username && !url.password ? url.href : null;
  } catch {
    return null;
  }
}

export async function readInstallAdoption(
  db: D1Database,
  installId: string,
): Promise<InstallAdoption | null> {
  const [row] = await createDb(db)
    .select()
    .from(install_adoptions)
    .where(eq(install_adoptions.install_id, installId))
    .limit(1);
  if (row === undefined) return null;
  const routes: InstallAdoption["routes"] = [];
  try {
    const inventory = JSON.parse(row.inventory_json) as {
      workers?: Array<{ name?: unknown; routes?: Array<{ pattern?: unknown }> }>;
    };
    for (const worker of inventory.workers ?? []) {
      if (typeof worker.name !== "string") continue;
      for (const route of worker.routes ?? []) {
        if (typeof route.pattern === "string") {
          routes.push({ workerName: worker.name, pattern: route.pattern });
        }
      }
    }
  } catch {
    // A damaged inventory must not prevent opening the managed install.
  }
  return {
    appName: row.app_name,
    address: adoptionAddress(row.primary_url),
    adoptedAt: row.adopted_at.toISOString(),
    routes,
  };
}
