import type { AdoptionInput } from "./adoptions-input";

export interface AdoptionResource {
  kind: "worker" | "d1" | "r2" | "kv" | "secret" | "cron" | "domain" | "worker_route";
  binding: string | null;
  name: string;
  cfId: string | null;
  managedBy: "appflare" | "app";
}

/** A fresh deployment inventory and the lifecycle ownership the admin is about to accept. */
export interface AdoptionPreview extends AdoptionInput {
  fingerprint: string;
  workerName: string;
  currentVersionId: string;
  address: string | null;
  resources: AdoptionResource[];
  resourceCount: number;
  warnings: string[];
}
