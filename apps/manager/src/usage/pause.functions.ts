import { env } from "cloudflare:workers";
import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import { requireRole } from "../server/auth.server";
import { PauseActionError, startPause, startResume } from "./pause.server";

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

/** A refusal reads as the sentence it carries; anything else as it is. */
async function asUserError<T>(start: () => Promise<T>): Promise<T> {
  try {
    return await start();
  } catch (error) {
    if (error instanceof PauseActionError) throw new Error(error.message);
    throw error;
  }
}

export const pauseAppFn = createServerFn({ method: "POST" })
  .validator(pauseAppInput)
  .handler(async ({ data }): Promise<PauseJobStarted> => {
    const session = await requireRole("admin");
    return asUserError(() =>
      startPause(
        { DB: env.DB, JOBS: env.JOBS },
        { installId: data.installId, reason: "manual", by: session.user.id },
      ),
    );
  });

export const resumeAppFn = createServerFn({ method: "POST" })
  .validator(resumeAppInput)
  .handler(async ({ data }): Promise<PauseJobStarted> => {
    const session = await requireRole("admin");
    return asUserError(() =>
      startResume(
        { DB: env.DB, JOBS: env.JOBS },
        {
          installId: data.installId,
          by: session.user.id,
          untilCapResets: data.untilCapResets === true,
        },
      ),
    );
  });
