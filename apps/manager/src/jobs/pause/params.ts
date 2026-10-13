import { z } from "zod";
import { PAUSE_REASONS } from "../../db/usage-schema";

/** The Workflow payload of a `pause` job (`startPause` creates it). */
export const pauseJobParams = z.object({
  kind: z.literal("pause"),
  jobId: z.string().min(1),
  installId: z.string().min(1),
  reason: z.enum(PAUSE_REASONS),
  /** Why, beyond the reason (`pauseCauseSchema` without `reason`); null for a manual pause. */
  detail: z.record(z.string(), z.unknown()).nullable(),
  /** The user id of who paused it; null when a trigger did. */
  by: z.string().min(1).nullable(),
});
export type PauseJobParams = z.infer<typeof pauseJobParams>;

/** The Workflow payload of a `resume` job (`startResume` creates it). */
export const resumeJobParams = z.object({
  kind: z.literal("resume"),
  jobId: z.string().min(1),
  installId: z.string().min(1),
  /** The user id of who resumed it. */
  by: z.string().min(1),
  /** Set the spending cap aside until its period resets. */
  untilCapResets: z.boolean(),
});
export type ResumeJobParams = z.infer<typeof resumeJobParams>;

/** How a pause records a trigger as its pauser (`app_pauses.paused_by`). */
export const PAUSED_BY_TRIGGER = "auto";
