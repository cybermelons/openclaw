import { executeSqliteQuerySync, getNodeSqliteKysely } from "../../infra/kysely-sync.js";
import type { DB as OpenClawAgentKyselyDatabase } from "../../state/openclaw-agent-db.generated.js";
import type { OpenClawAgentDatabase } from "../../state/openclaw-agent-db.js";
import type {
  SessionEntryStatus,
  SessionEntrySummary,
} from "./session-accessor.sqlite-contract.js";
import { hasValidSessionEntryIdentity, projectSessionEntry } from "./session-entry-parse.js";
import { isSessionRowCorruptError } from "./session-row-corrupt-error.js";

type SessionStatusDatabase = Pick<OpenClawAgentKyselyDatabase, "session_nodes">;

export function normalizeStatus(value: unknown): SessionEntryStatus | null {
  return value === "running" ||
    value === "done" ||
    value === "failed" ||
    value === "killed" ||
    value === "timeout"
    ? value
    : null;
}

export { hasValidSessionEntryIdentity };

export function readSessionEntriesByStatus(
  database: OpenClawAgentDatabase,
  statuses: readonly SessionEntryStatus[],
  sessionKeys?: readonly string[],
): SessionEntrySummary[] {
  const selectedStatuses = [...new Set(statuses)];
  const selectedStatusSet = new Set(selectedStatuses);
  const selectedSessionKeys = sessionKeys ? [...new Set(sessionKeys)] : undefined;
  if (selectedStatuses.length === 0 || selectedSessionKeys?.length === 0) {
    return [];
  }
  const db = getNodeSqliteKysely<SessionStatusDatabase>(database.db);
  let query = db
    .selectFrom("session_nodes")
    .select(["session_key", "entry_json", "current_session_id", "updated_at"])
    // Cheap pre-narrow only (index job): membership is decided below against
    // the blob-sourced `entry.status`, since the projected VALUES are already
    // blob-sourced (Phase 3 §8c — a SQL filter gating a side effect must
    // re-verify against the blob).
    .where("status", "in", selectedStatuses);
  if (selectedSessionKeys) {
    query = query.where("session_key", "in", selectedSessionKeys);
  }
  return executeSqliteQuerySync(database.db, query)
    .rows.flatMap((row) => {
      try {
        const entry = projectSessionEntry(row.session_key, row);
        if (!entry.status || !selectedStatusSet.has(entry.status)) {
          return [];
        }
        return [{ entry, sessionKey: row.session_key }];
      } catch (error) {
        if (!isSessionRowCorruptError(error)) {
          throw error;
        }
        return [];
      }
    })
    .toSorted((a, b) => a.sessionKey.localeCompare(b.sessionKey));
}
