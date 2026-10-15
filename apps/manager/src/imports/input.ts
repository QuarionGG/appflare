import { z } from "zod";
import { displayNameSchema } from "../installs/display-name";
import { MAX_IMPORTED_WORKERS } from "./types";

const workerName = z
  .string()
  .min(1)
  .max(128)
  .regex(/^[a-zA-Z0-9_-]+$/);

export const importSelectionInput = z
  .object({
    workerNames: z.array(workerName).min(1).max(MAX_IMPORTED_WORKERS),
    primaryWorker: workerName,
    displayName: displayNameSchema,
  })
  .refine((value) => new Set(value.workerNames).size === value.workerNames.length, {
    message: "Choose each Worker only once.",
  })
  .refine((value) => value.workerNames.includes(value.primaryWorker), {
    message: "The primary Worker must be one of the selected Workers.",
  });

export const importCommitInput = importSelectionInput.safeExtend({
  fingerprint: z.string().regex(/^[a-f0-9]{64}$/),
});

export const importAppIdInput = z.object({ appId: z.string().min(1).max(64) });
