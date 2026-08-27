import type { OpenClawAgentDatabase } from "../../state/openclaw-agent-db.js";

/**
 * Phase-4 resumption-ordering marker store (PHASE-4.md §3, §3a).
 *
 * The `session_resume_epoch` table names the current resumption generation of a
 * session. `state` is a stored enum, never inferred from row presence: a missing
 * row is an invariant violation, not a drain-pending signal (the CS-2 migration
 * backfills every session as `epoch=0, state='drained'`).
 *
 * ## #24 seam (PHASE-4.md §6) — stable exported surface
 *
 * This module is the store-API surface issue #24's read/visibility work builds
 * on. Its contract, re-exported through `session-accessor.ts`:
 *
 * - `readSessionResumeEpoch` returns the marker with its stored `state`. #24
 *   decides resumption durability by this committed state — an epoch is either
 *   `drain_pending` or fully `drained`, decided by commit. #24 must never
 *   re-derive resumption state from row heuristics (`running`/`abortedLastRun`).
 * - `SessionResumeDrainPendingError` (own module) is the typed, retryable refusal
 *   thrown by tail-dependent resume readers; catch it by type, not by message.
 * - The post-commit dispatch boundary in `main-session-restart-dispatch.ts` is the
 *   single point where "resumption is durable" becomes observable (a committed
 *   `drained` marker), not an in-process flag.
 *
 * As of CS-3/CS-4 `readSessionResumeEpoch` IS on the resume/dispatch path (via
 * `readSessionResumeEpochForScope` in the history reader). Writes join the drain
 * transaction in CS-3 so drain + marker commit atomically (§3 boundary).
 */

export type SessionResumeEpochState = "drain_pending" | "drained";

export type SessionResumeEpochRow = {
  sessionKey: string;
  epoch: number;
  state: SessionResumeEpochState;
  updatedAt: number;
};

/**
 * Upsert the resume-epoch marker for one session. Keyed by `session_key`
 * (one live epoch per session). Callers own transaction boundaries — this
 * runs a single statement on the passed database handle so it can join the
 * drain transaction in CS-3.
 */
export function writeSessionResumeEpoch(
  database: OpenClawAgentDatabase,
  params: { sessionKey: string; epoch: number; state: SessionResumeEpochState },
): void {
  database.db
    .prepare(
      `
      INSERT INTO session_resume_epoch (session_key, epoch, state, updated_at)
      VALUES (?, ?, ?, ?)
      ON CONFLICT(session_key) DO UPDATE SET
        epoch = excluded.epoch,
        state = excluded.state,
        updated_at = excluded.updated_at
    `,
    )
    .run(params.sessionKey, params.epoch, params.state, Date.now());
}

/**
 * Read one session's resume-epoch marker, or `null` when absent. A `null`
 * return is an invariant violation for a real session (the migration backfills
 * all sessions); callers must treat absence as an error to surface, never as
 * drain-pending. On the resume path the check runs inside the transcript-read
 * snapshot (`readSessionResumeEpochForScope`); this raw form serves store-API
 * callers and #24.
 */
export function readSessionResumeEpoch(
  database: OpenClawAgentDatabase,
  sessionKey: string,
): SessionResumeEpochRow | null {
  const row = database.db
    .prepare(
      "SELECT session_key, epoch, state, updated_at FROM session_resume_epoch WHERE session_key = ?",
    )
    .get(sessionKey) as
    | { session_key?: unknown; epoch?: unknown; state?: unknown; updated_at?: unknown }
    | undefined;
  if (!row || typeof row.session_key !== "string") {
    return null;
  }
  const state = row.state === "drain_pending" || row.state === "drained" ? row.state : undefined;
  if (state === undefined) {
    return null;
  }
  return {
    sessionKey: row.session_key,
    epoch: typeof row.epoch === "number" ? row.epoch : Number(row.epoch),
    state,
    updatedAt: typeof row.updated_at === "number" ? row.updated_at : Number(row.updated_at),
  };
}
