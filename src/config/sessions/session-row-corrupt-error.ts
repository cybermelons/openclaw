/**
 * The one typed, `instanceof`-checkable corruption error for an unparseable
 * `entry_json` blob (PHASE-2.md §6). Thrown at the projection pipeline
 * boundary (CS-4) when the single parser reports `{ ok: false }` — never a
 * silent `null`. `retryable: false`: a corrupt blob does not heal, so
 * `withSessionRetry` must not retry it.
 */
export class SessionRowCorruptError extends Error {
  readonly key: string;
  readonly reason: string;
  readonly blobExcerpt: string;
  readonly retryable = false as const;

  constructor(params: { key: string; reason: string; blobExcerpt: string; message?: string }) {
    super(
      params.message ?? `session ${params.key} has a corrupt entry_json blob: ${params.reason}`,
    );
    this.name = "SessionRowCorruptError";
    this.key = params.key;
    this.reason = params.reason;
    this.blobExcerpt = params.blobExcerpt;
  }
}

export function isSessionRowCorruptError(err: unknown): err is SessionRowCorruptError {
  return err instanceof SessionRowCorruptError;
}
