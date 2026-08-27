// Phase 2 CS-3/CS-4 (PHASE-2.md §3/§4): the ONE parser plus the ONE pipeline
// for a `session_nodes.entry_json` blob. Replaces the two parsers/functions
// they unify:
//   - parseSessionEntryJson (session-accessor.sqlite-status.ts) — participant-less, silent-null.
//   - parseReadableSqliteSessionEntryRow (session-accessor.sqlite-entry-store.ts) — participant-full, throwing.
//
// Contract: `parseSessionEntryBlob` is a discriminated Result, never a throw
// (Delta A, §14). The parser receives the blob (+ row key for error
// identity) and whatever columns/satellite records the caller already
// resolved — no second query, no cross-row reference happens inside this
// function. Row-not-found stays the caller's job (return null/undefined
// BEFORE calling this parser); this parser only judges a found-but-unparseable
// blob.
//
// `projectSessionEntry` (CS-4, §4) is the one pipeline boundary: it always
// resolves participants (shape -> owner -> participants), and on
// `{ ok: false }` it quarantines the row (§6) then throws the
// `SessionRowCorruptError` — the ONLY place a corrupt Result becomes a throw.
import { executeSqliteQueryTakeFirstSync } from "../../infra/kysely-sync.js";
import type { OpenClawAgentDatabase } from "../../state/openclaw-agent-db.js";
import { recordOpenClawSessionRowQuarantine } from "../../state/openclaw-quarantine-store.js";
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
import { isSessionRowCorruptError, SessionRowCorruptError } from "./session-row-corrupt-error.js";
import { projectCanonicalSessionEntryShape } from "./store-entry-shape.js";
import { resolveDeliveryProvenCanonicalSessionKey } from "./store-entry.js";
import type { SessionEntry } from "./types.js";

export { hasValidSessionEntryIdentity, isSessionRowCorruptError };

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
 * The one pipeline boundary (Phase 2 CS-4, §4): shape -> owner -> participants,
 * always resolved. On a corrupt blob, quarantines the row (§6) and throws the
 * `SessionRowCorruptError` — the ONLY place a corrupt Result becomes a throw.
 *
 * `participants` is always a required array in the returned shape (`[]` when
 * none), never absent — callers that formerly received no `participants` key
 * at all now receive `participants: []`.
 */
export function projectSessionEntry(
  key: string,
  row: SessionEntryBlobRow,
  participants: readonly SessionParticipantRecord[] = [],
): CanonicalSessionEntryShape {
  const result = parseSessionEntryBlob(key, row, participants);
  if (!result.ok) {
    recordOpenClawSessionRowQuarantine({ sessionKey: key, reason: result.corrupt.reason });
    throw result.corrupt;
  }
  return { participants: [], participantCount: 0, ...result.entry };
}

/**
 * Multi-row, silent-skip adapter over `projectSessionEntry` (Fable rule D):
 * for a loop/map/reduce iterating many rows, a corrupt row must not abort
 * the whole scan — quarantine happens (inside `projectSessionEntry`) and the
 * corrupt row is skipped by returning `null`, matching the exact null-return
 * contract every former `parseSessionEntryJson` multi-row call site already
 * depended on. Any non-corrupt error still propagates.
 */
export function readSessionEntryOrNull(
  key: string,
  row: SessionEntryBlobRow,
  participants?: readonly SessionParticipantRecord[],
): SessionEntry | null {
  try {
    return projectSessionEntry(key, row, participants);
  } catch (error) {
    if (!isSessionRowCorruptError(error)) {
      throw error;
    }
    return null;
  }
}

/**
 * Former participant-full, throwing call sites (formerly
 * `parseReadableSqliteSessionEntryRow`) route through this helper. It calls
 * the one parser directly (not `projectSessionEntry`) so the `"{}"` blob +
 * matching retained-window special case can be checked BEFORE deciding to
 * quarantine — a retained window is a legitimate, non-corrupt state (the
 * entry was cleared but the transcript generation survives), so it must
 * stay a silent `null`, never a quarantine record. Every other corrupt case
 * quarantines (§6) and throws the same `SessionCanonicalKeyMigrationRequiredError`
 * message this call site always produced. On success, participants are
 * layered on top exactly as the deleted function did (a second pass, not
 * part of the parse), then the same post-parse canonical-key check runs.
 */
export function readCanonicalSqliteSessionEntryRow(
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
  recordOpenClawSessionRowQuarantine({
    sessionKey: row.session_key,
    reason: result.corrupt.reason,
  });
  throw canonicalSessionKeyMigrationRequiredError(
    `invalid persisted session row requires repair for ${row.session_key}`,
  );
}
