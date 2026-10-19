import { gitRefSchema } from "@appflare/schema";
import { z } from "zod";
import { displayNameSchema } from "../installs/display-name";

/** The source describes future builds; it does not claim to have produced the live Worker. */
export const adoptionInput = z.object({
  appId: z.string().min(1).max(64),
  displayName: displayNameSchema,
  appName: displayNameSchema,
  repository: z.string().trim().min(1, "Enter the custom source repository.").max(400),
  ref: gitRefSchema,
});

export const adoptionCommitInput = adoptionInput.extend({
  fingerprint: z.string().regex(/^[a-f0-9]{64}$/),
});

export type AdoptionInput = z.infer<typeof adoptionInput>;
