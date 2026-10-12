import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import { requireRole } from "../server/auth.server";

/**
 * Pause and Resume an app from Home and its Usage tab. Admin only. Each
 * starts a job (one at a time per install, with its log), so the answer is
 * the job's id; the page reloads to show the app paused or running.
 */

export const pauseAppInput = z.object({ installId: z.string().min(1).max(64) });

export const resumeAppInput = pauseAppInput.extend({
  /**
   * The app is still past its spending cap: set the cap aside until its
   * period resets, so auto-pause does not pause it again at once. The loop
   * check still runs.
   */
  untilCapResets: z.boolean().optional(),
});

export interface PauseJobStarted {
  jobId: string;
}

const NOT_AVAILABLE = "Pausing and resuming apps is not available in this version yet.";

export const pauseAppFn = createServerFn({ method: "POST" })
  .validator(pauseAppInput)
  .handler(async (): Promise<PauseJobStarted> => {
    await requireRole("admin");
    // TODO: start the pause job; the pause and resume jobs are not part of this version yet.
    throw new Error(NOT_AVAILABLE);
  });

export const resumeAppFn = createServerFn({ method: "POST" })
  .validator(resumeAppInput)
  .handler(async (): Promise<PauseJobStarted> => {
    await requireRole("admin");
    // TODO: start the resume job; the pause and resume jobs are not part of this version yet.
    throw new Error(NOT_AVAILABLE);
  });
