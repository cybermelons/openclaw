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
 *
 * The row also carries `sessionId` + `drainedThroughSeq`, folding in the
 * transcript identity `(session_id, seq)`: `drainedThroughSeq` is the
 * watermark `MAX(seq) FROM transcript_events WHERE session_id = sessionId`
 * as of this epoch. Both are nullable (pre-fold-in rows, and phase-1
 * `drain_pending` writes before the watermark is known) and are never
 * consulted for the CS-4 refusal decision — that decision is `state` alone.
 */

export type SessionResumeEpochState = "drain_pending" | "drained";

export type SessionResumeEpochRow = {
  sessionKey: string;
  epoch: number;
  state: SessionResumeEpochState;
  updatedAt: number;
  /** Transcript session this epoch's marker names (part of the `(session_id, seq)` transcript key). Null on rows never written under the two-column fold-in. */
  sessionId: string | null;
  /** Watermark `seq` (MAX(seq) FROM transcript_events for `sessionId`) drained as of this epoch. Null when unknown/never drained under the fold-in. */
  drainedThroughSeq: number | null;
};

/**
 * Upsert the resume-epoch marker for one session. Keyed by `session_key`
 * (one live epoch per session). Callers own transaction boundaries — this
 * runs a single statement on the passed database handle so it can join the
 * drain transaction in CS-3.
 */
export function writeSessionResumeEpoch(
  database: OpenClawAgentDatabase,
  params: {
    sessionKey: string;
    epoch: number;
    state: SessionResumeEpochState;
    sessionId: string | null;
    drainedThroughSeq: number | null;
  },
): void {
  database.db
    .prepare(
      `
      INSERT INTO session_resume_epoch (session_key, epoch, state, session_id, drained_through_seq, updated_at)
      VALUES (?, ?, ?, ?, ?, ?)
      ON CONFLICT(session_key) DO UPDATE SET
        epoch = excluded.epoch,
        state = excluded.state,
        session_id = excluded.session_id,
        drained_through_seq = excluded.drained_through_seq,
        updated_at = excluded.updated_at
    `,
    )
    .run(
      params.sessionKey,
      params.epoch,
      params.state,
      params.sessionId,
      params.drainedThroughSeq,
      Date.now(),
    );
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
      "SELECT session_key, epoch, state, session_id, drained_through_seq, updated_at FROM session_resume_epoch WHERE session_key = ?",
    )
    .get(sessionKey) as
    | {
        session_key?: unknown;
        epoch?: unknown;
        state?: unknown;
        session_id?: unknown;
        drained_through_seq?: unknown;
        updated_at?: unknown;
      }
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
    sessionId: typeof row.session_id === "string" ? row.session_id : null,
    drainedThroughSeq:
      typeof row.drained_through_seq === "number"
        ? row.drained_through_seq
        : row.drained_through_seq === null || row.drained_through_seq === undefined
          ? null
          : Number(row.drained_through_seq),
    updatedAt: typeof row.updated_at === "number" ? row.updated_at : Number(row.updated_at),
  };
}
