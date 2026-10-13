/**
 * What every job that deploys an app's code checks first: a paused app
 * serves its stand-in, and a new version deployed over it would run the app
 * again without anyone resuming it, and leave its pause to put back a
 * version that no longer applies. So an update, a rollback, a settings
 * change or "Install again" is refused until the app is resumed. Uninstall
 * is not: it removes the app and closes its pause.
 */

export const PAUSED_REFUSAL = "This app is paused. Resume the app first, then try again.";

/**
 * A condition for a claim's `INSERT ... SELECT`: the install bound to
 * `param` has no open pause.
 */
export function notPausedSql(param: string): string {
  return `NOT EXISTS (SELECT 1 FROM app_pauses WHERE install_id = ${param} AND resumed_at IS NULL)`;
}

/** Why a job that deploys the app's code cannot start: it is paused; null when it is not. */
export async function pausedRefusal(db: D1Database, installId: string): Promise<string | null> {
  const row = await db
    .prepare("SELECT 1 AS paused FROM app_pauses WHERE install_id = ?1 AND resumed_at IS NULL")
    .bind(installId)
    .first<{ paused: number }>();
  return row === null ? null : PAUSED_REFUSAL;
}
