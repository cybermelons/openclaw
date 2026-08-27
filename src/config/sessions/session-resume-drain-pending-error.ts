/**
 * Thrown by resume/reseed transcript readers (PHASE-4.md §4 CS-4) when the
 * session_resume_epoch marker for a session is still `drain_pending`: the
 * resume-ordering drain transaction has not committed yet, so the transcript
 * tail is not guaranteed complete.
 *
 * `retryable=true` is a SEMANTIC contract for callers, not a behavior this
 * class implements: the correct response is to retry after the resume
 * transaction that flips the marker to `drained` commits (event/caller
 * driven). This class carries no retry logic — nothing here sleeps or loops.
 */
export class SessionResumeDrainPendingError extends Error {
  constructor(
    readonly sessionId: string,
    readonly pendingEpoch: number,
  ) {
    super(`Session resume is drain-pending: ${sessionId} (epoch ${pendingEpoch})`);
    this.name = "SessionResumeDrainPendingError";
  }
}

export function isSessionResumeDrainPendingError(
  error: unknown,
): error is SessionResumeDrainPendingError {
  return error instanceof SessionResumeDrainPendingError;
}
