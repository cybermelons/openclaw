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

/**
 * @deprecated subsumed by SessionConflictError; removed with OPENCLAW_SESSION_CAS_VALUE_COMPARE flag
 *
 * One-release alias for the module-private `SqliteSessionMutationConflictError`
 * defined at `session-accessor.sqlite-entry-store.ts:121`. UNUSED until CS-3
 * switches that file's throw sites to `SessionConflictError` (or this alias).
 * Maps the old single-arg `(operationLabel: string)` constructor onto the new
 * params shape with `expectedRevision`/`actualRevision` sentinel `-1` — the old
 * class carried no revision data to preserve.
 */
export class SqliteSessionMutationConflictError extends SessionConflictError {
  constructor(operationLabel: string) {
    super({
      key: operationLabel,
      expectedRevision: -1,
      actualRevision: -1,
      message: `SQLite session state changed while preparing ${operationLabel}`,
    });
    this.name = "SqliteSessionMutationConflictError";
  }
}

/**
 * @deprecated subsumed by SessionConflictError; removed with OPENCLAW_SESSION_CAS_VALUE_COMPARE flag
 *
 * One-release alias for the module-private `SqliteTranscriptMutationConflictError`
 * defined at `session-accessor.sqlite-transcript-write.ts:74`. UNUSED until CS-3
 * switches that file's throw sites to `SessionConflictError` (or this alias).
 * Maps the old single-arg `(sessionId: string)` constructor onto the new params
 * shape with `expectedRevision`/`actualRevision` sentinel `-1` — the old class
 * carried no revision data to preserve.
 */
export class SqliteTranscriptMutationConflictError extends SessionConflictError {
  constructor(sessionId: string) {
    super({
      key: sessionId,
      expectedRevision: -1,
      actualRevision: -1,
      message: `SQLite transcript changed while preparing rewrite for ${sessionId}`,
    });
    this.name = "SqliteTranscriptMutationConflictError";
  }
}
