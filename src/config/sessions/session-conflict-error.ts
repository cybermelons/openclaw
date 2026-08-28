/**
 * The one typed, `instanceof`-checkable conflict error for `session_nodes` CAS
 * failures (PHASE-1.md §4). Every entry-CAS write site throws this — never a
 * bare-string "changed before" `Error` — so callers can retry on `retryable`
 * rather than substring-matching a message.
 */
export class SessionConflictError extends Error {
  readonly key: string;
  readonly expectedRevision: number;
  readonly actualRevision: number;
  readonly retryable = true as const;

  constructor(params: {
    key: string;
    expectedRevision: number;
    actualRevision: number;
    message?: string;
  }) {
    super(
      params.message ??
        `session ${params.key} changed: expected revision ${params.expectedRevision}, found ${params.actualRevision}`,
    );
    this.name = "SessionConflictError";
    this.key = params.key;
    this.expectedRevision = params.expectedRevision;
    this.actualRevision = params.actualRevision;
  }
}

export function isSessionConflictError(err: unknown): err is SessionConflictError {
  return err instanceof SessionConflictError;
}
