// Phase 2 CS-3 (PHASE-2.md §3): the ONE parser for a `session_nodes.entry_json`
// blob. Replaces the two parsers it unifies:
//   - parseSessionEntryJson (session-accessor.sqlite-status.ts) — participant-less, silent-null.
//   - parseReadableSqliteSessionEntryRow (session-accessor.sqlite-entry-store.ts) — participant-full, throwing.
//
// Contract: a discriminated Result, never a throw (Delta A, §14). The parser
// receives the blob (+ row key for error identity) and whatever columns/
// satellite records the caller already resolved — no second query, no
// cross-row reference happens inside this function. Row-not-found stays the
// caller's job (return null/undefined BEFORE calling this parser); this
// parser only judges a found-but-unparseable blob.
import { executeSqliteQueryTakeFirstSync } from "../../infra/kysely-sync.js";
import type { OpenClawAgentDatabase } from "../../state/openclaw-agent-db.js";
import {
  projectSqliteSessionOwner,
  type SqliteSessionOwnerRow,
} from "./session-accessor.sqlite-owner-projection.js";
import {
  projectSqliteSessionParticipants,
  withProjectedParticipants,
  type SessionParticipantRecord,
} from "./session-accessor.sqlite-participant-projection.js";
import { getSessionKysely } from "./session-accessor.sqlite-scope.js";
import { canonicalSessionKeyMigrationRequiredError } from "./session-canonical-key.js";
import {
  hasValidSessionEntryIdentity,
  parseSqliteSessionEntryRecord,
} from "./session-entry-json.js";
import { SessionRowCorruptError } from "./session-row-corrupt-error.js";
import { projectCanonicalSessionEntryShape } from "./store-entry-shape.js";
import { resolveDeliveryProvenCanonicalSessionKey } from "./store-entry.js";
import type { SessionEntry } from "./types.js";

export { hasValidSessionEntryIdentity };

/** The one canonical session-entry shape a parse produces. */
export type CanonicalSessionEntryShape = SessionEntry;

export type SessionEntryParseResult =
  | { ok: true; entry: CanonicalSessionEntryShape }
  | { ok: false; corrupt: SessionRowCorruptError };

export type SessionEntryBlobRow = {
  current_session_id?: string;
  entry_json: string;
  updated_at?: number;
} & SqliteSessionOwnerRow;

function boundedBlobExcerpt(blob: string): string {
  return blob.length > 200 ? `${blob.slice(0, 200)}…` : blob;
}

/**
 * Parses one `entry_json` blob into the canonical session-entry shape.
 *
 * Input is the blob alone (via `row`) plus an optional, already-resolved
 * `participants` list. No sibling row is read here — any second query
 * (canonical-key resolution, retained-window lookback) is the caller's
 * responsibility, performed before or after this call.
 */
export function parseSessionEntryBlob(
  key: string,
  row: SessionEntryBlobRow,
  participants?: readonly SessionParticipantRecord[],
): SessionEntryParseResult {
  const record = parseSqliteSessionEntryRecord(row);
  if (!record) {
    return {
      ok: false,
      corrupt: new SessionRowCorruptError({
        key,
        reason: "entry_json failed to parse or diverges from row identity",
        blobExcerpt: boundedBlobExcerpt(row.entry_json),
      }),
    };
  }
  const entry = projectSqliteSessionOwner(projectCanonicalSessionEntryShape(record), row);
  return {
    ok: true,
    entry: participants ? withProjectedParticipants(entry, participants) : entry,
  };
}

/**
 * Interim compatibility wrapper (Delta A, §14) for every participant-less,
 * silent-null-on-corrupt call site that used to call the now-deleted
 * `parseSessionEntryJson` (formerly session-accessor.sqlite-status.ts).
 * Maps `{ ok: false }` to `null`, matching that function's current behavior
 * exactly — no observable change in CS-3.
 *
 * // PHASE2-INTERIM: removed in CS-4 — callers route through the pipeline
 * // (`projectSessionEntry`) instead once it lands.
 */
export function parseSessionEntryJson(
  row: { session_key?: string } & SessionEntryBlobRow,
): SessionEntry | null {
  const result = parseSessionEntryBlob(row.session_key ?? "unknown", row);
  return result.ok ? result.entry : null;
}

/**
 * Interim compatibility wrapper (Delta A, §14) for the participant-full,
 * throwing call sites that used to call the now-deleted
 * `parseReadableSqliteSessionEntryRow` (formerly
 * session-accessor.sqlite-entry-store.ts). On `{ ok: false }` it throws the
 * same `SessionCanonicalKeyMigrationRequiredError` as before, except the
 * `"{}"` blob + matching retained-window special case, which stays a silent
 * `null` — both branches preserved exactly from the deleted function.
 *
 * // PHASE2-INTERIM: removed in CS-4 — callers route through the pipeline
 * // (`projectSessionEntry`), which quarantines and throws
 * // `SessionRowCorruptError` at the boundary instead.
 */
export function parseReadableSqliteSessionEntryRow(
  database: Pick<OpenClawAgentDatabase, "db">,
  row: { current_session_id: string; session_key: string } & SessionEntryBlobRow,
): SessionEntry | null {
  const result = parseSessionEntryBlob(row.session_key, row);
  if (result.ok) {
    const entry = projectSqliteSessionParticipants(database.db, row.session_key, result.entry);
    if (resolveDeliveryProvenCanonicalSessionKey(row.session_key, entry) !== row.session_key) {
      throw canonicalSessionKeyMigrationRequiredError(
        `non-canonical persisted row resolves to session key ${row.session_key}`,
      );
    }
    return entry;
  }
  const retainedWindow =
    row.entry_json === "{}"
      ? executeSqliteQueryTakeFirstSync(
          database.db,
          getSessionKysely(database.db)
            .selectFrom("session_windows")
            .select("session_id")
            .where("session_id", "=", row.current_session_id)
            .where("session_key", "=", row.session_key),
        )
      : undefined;
  if (retainedWindow) {
    return null;
  }
  throw canonicalSessionKeyMigrationRequiredError(
    `invalid persisted session row requires repair for ${row.session_key}`,
  );
}
