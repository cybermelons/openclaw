import { SessionConflictError } from "./session-conflict-error.js";

/**
 * Sleeps a small exponential backoff with jitter, capped, between retry
 * attempts: `min(base * attempt, cap) + random(0, jitterMax)`.
 */
function sleepWithBackoffJitter(attempt: number): Promise<void> {
  const baseMs = 5;
  const capMs = 100;
  const jitterMaxMs = 5;
  const delayMs = Math.min(baseMs * attempt, capMs) + Math.random() * jitterMaxMs;
  return new Promise((resolve) => {
    setTimeout(resolve, delayMs);
  });
}

/**
 * Retries `fn` on `SessionConflictError` up to `budget` attempts.
 *
 * HARD RULE: `fn` MUST perform its own fresh read (row + current revision)
 * inside its body on EVERY attempt, then apply the caller's intended mutation
 * to that fresh state. This helper passes `fn` only the 1-indexed attempt
 * number — it holds no snapshot, no expectedRevision, no entry; there is
 * nothing stale it *can* pass back to `fn`. A `fn` that closes over a
 * pre-read snapshot/expectedRevision instead of re-reading is a review-reject
 * (PHASE-1.md §5).
 *
 * Retries ONLY `err instanceof SessionConflictError && err.retryable === true`;
 * any other error rethrows immediately — including `SessionRowCorruptError`
 * (`retryable: false`, PHASE-2.md §6): a corrupt blob does not heal, so it
 * rethrows on attempt 1 with no retry. On budget exhaustion, rethrows the
 * last `SessionConflictError`.
 *
 * Stale-closure tripwire: if two CONSECUTIVE conflicts arrive with the same
 * `expectedRevision`, `fn` did not re-read between attempts, so continuing to
 * retry cannot converge. The helper stops immediately (without spending the
 * remaining budget) and throws a new non-retryable `Error` (NOT a
 * `SessionConflictError`, so ordinary retry callers won't retry it) wrapping
 * the last conflict via `{ cause }`.
 */
export async function withSessionRetry<T>(
  fn: (attempt: number) => Promise<T>,
  budget: number,
): Promise<T> {
  let lastConflict: SessionConflictError | undefined;

  for (let attempt = 1; attempt <= budget; attempt += 1) {
    try {
      return await fn(attempt);
    } catch (err) {
      if (!(err instanceof SessionConflictError) || !err.retryable) {
        throw err;
      }

      if (lastConflict && lastConflict.expectedRevision === err.expectedRevision) {
        throw new Error("stale closure — fn must re-read row + revision per attempt", {
          cause: err,
        });
      }

      lastConflict = err;

      if (attempt >= budget) {
        throw lastConflict;
      }

      await sleepWithBackoffJitter(attempt);
    }
  }

  // Unreachable: budget >= 1 guarantees the loop above either returns or
  // throws. Kept only to satisfy the return type without a non-null assertion.
  throw lastConflict ?? new Error("withSessionRetry: budget must be >= 1");
}
