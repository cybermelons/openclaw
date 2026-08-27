import type { OpenClawAgentDatabase } from "../../state/openclaw-agent-db.js";

/**
 * Phase-4 resumption-ordering marker store (PHASE-4.md §3, §3a).
 *
 * The `session_resume_epoch` table names the current resumption generation of a
 * session. `state` is a stored enum, never inferred from row presence: a missing
 * row is an invariant violation, not a drain-pending signal (the CS-2 migration
 * backfills every session as `epoch=0, state='drained'`).
 *
 * CS-2 is write-only — nothing reads the marker to gate dispatch/reseed yet. The
 * reader that refuses a drain-pending epoch arrives in CS-3/CS-4. `readResumeEpoch`
 * exists only to let CS-2's CRUD test observe writes; do not wire it into the
 * resume/dispatch path.
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
 * drain-pending. Present only for CS-2 test observability.
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
