import { getSessionKysely } from "./src/config/sessions/session-accessor.sqlite-scope.js";
import {
  projectSessionEntry,
  type SessionEntryBlobRow,
} from "./src/config/sessions/session-entry-parse.js";
import { isSessionRowCorruptError } from "./src/config/sessions/session-row-corrupt-error.js";
import type { SessionEntry } from "./src/config/sessions/types.js";
import { executeSqliteQuerySync } from "./src/infra/kysely-sync.js";
// PHASE-3 CS-1 divergence census (throwaway, one-shot tool — PHASE-3.md §2.5).
//
// For every row in a session store DB: parse `entry_json` via
// `parseSessionEntryBlob`, project every field via `projectSessionEntry`
// (Phase 2 pipeline), then compare each projected field against the matching
// projected COLUMN value read raw from SQL. Corrupt rows are caught via
// `isSessionRowCorruptError` and tallied separately — one poison row must not
// abort the census.
//
// Usage: node --experimental-strip-types tmp_phase3-divergence-census.ts <path-to-sqlite-db>
//
// This is a read-only tool. It never writes to the target database.
import { openNodeSqliteDatabase } from "./src/infra/node-sqlite.js";

const MAX_SAMPLE_KEYS = 10;

// Column -> projected SessionEntry field mapping for session_nodes.
// One-shot mapping table for the census; not shared production code.
const SESSION_NODES_FIELD_MAP: Array<{
  column: string;
  field: (entry: SessionEntry) => unknown;
}> = [
  { column: "status", field: (e) => (e as { status?: unknown }).status },
  { column: "created_at", field: (e) => (e as { createdAt?: unknown }).createdAt },
  { column: "created_via", field: (e) => (e as { createdVia?: unknown }).createdVia },
  {
    column: "created_actor_type",
    field: (e) => (e as { createdActor?: { type?: unknown } }).createdActor?.type,
  },
  {
    column: "created_actor_id",
    field: (e) => (e as { createdActor?: { id?: unknown } }).createdActor?.id,
  },
  {
    column: "parent_session_key",
    field: (e) => (e as { parentSessionKey?: unknown }).parentSessionKey,
  },
  { column: "spawned_by", field: (e) => (e as { spawnedBy?: unknown }).spawnedBy },
  {
    column: "fork_source_session_key",
    field: (e) => (e as { forkSource?: { sessionKey?: unknown } }).forkSource?.sessionKey,
  },
  {
    column: "fork_source_session_id",
    field: (e) => (e as { forkSource?: { sessionId?: unknown } }).forkSource?.sessionId,
  },
  {
    column: "fork_source_entry_id",
    field: (e) => (e as { forkSource?: { entryId?: unknown } }).forkSource?.entryId,
  },
  { column: "label", field: (e) => (e as { label?: unknown }).label },
  { column: "display_name", field: (e) => (e as { displayName?: unknown }).displayName },
  { column: "category", field: (e) => (e as { category?: unknown }).category },
  { column: "icon", field: (e) => (e as { icon?: unknown }).icon },
  { column: "pinned_at", field: (e) => (e as { pinnedAt?: unknown }).pinnedAt },
  { column: "archived_at", field: (e) => (e as { archivedAt?: unknown }).archivedAt },
  { column: "last_read_at", field: (e) => (e as { lastReadAt?: unknown }).lastReadAt },
  {
    column: "last_interaction_at",
    field: (e) => (e as { lastInteractionAt?: unknown }).lastInteractionAt,
  },
  { column: "last_activity_at", field: (e) => (e as { lastActivityAt?: unknown }).lastActivityAt },
  {
    column: "owner_actor_type",
    field: (e) => (e as { owner?: { actor?: { type?: unknown } } }).owner?.actor?.type,
  },
  {
    column: "owner_actor_id",
    field: (e) => (e as { owner?: { actor?: { id?: unknown } } }).owner?.actor?.id,
  },
  {
    column: "owner_assigned_by_type",
    field: (e) => (e as { owner?: { assignedBy?: { type?: unknown } } }).owner?.assignedBy?.type,
  },
  {
    column: "owner_assigned_by_id",
    field: (e) => (e as { owner?: { assignedBy?: { id?: unknown } } }).owner?.assignedBy?.id,
  },
  {
    column: "owner_assigned_at",
    field: (e) => (e as { owner?: { assignedAt?: unknown } }).owner?.assignedAt,
  },
];

// session_windows carries no `entry_json` of its own — it is keyed by
// `session_id`, owned by a `session_key` whose `session_nodes.entry_json`
// is the blob of record. The census projects the OWNING node's blob and
// compares session_windows' duplicated status/model/etc columns against it,
// per PHASE-3.md §4 ("~10 duplicated session_windows columns").
const SESSION_WINDOWS_FIELD_MAP: Array<{
  column: string;
  field: (entry: SessionEntry) => unknown;
}> = [
  { column: "status", field: (e) => (e as { status?: unknown }).status },
  {
    column: "parent_session_key",
    field: (e) => (e as { parentSessionKey?: unknown }).parentSessionKey,
  },
  { column: "spawned_by", field: (e) => (e as { spawnedBy?: unknown }).spawnedBy },
  { column: "display_name", field: (e) => (e as { displayName?: unknown }).displayName },
];

type DivergenceTally = {
  count: number;
  sampleKeys: string[];
};

function record(map: Map<string, DivergenceTally>, column: string, key: string): void {
  const existing = map.get(column) ?? { count: 0, sampleKeys: [] };
  existing.count += 1;
  if (existing.sampleKeys.length < MAX_SAMPLE_KEYS) {
    existing.sampleKeys.push(key);
  }
  map.set(column, existing);
}

function valuesDiverge(columnValue: unknown, blobValue: unknown): boolean {
  // Column is untyped SQLite storage (numbers may come back as bigint/number,
  // nulls as null/undefined). Normalize null/undefined together; otherwise
  // require strict equality — the whole point of the census is to catch even
  // small divergences before they are declared unobservable dead code.
  const normalizedColumn = columnValue === null ? undefined : columnValue;
  const normalizedBlob = blobValue === null ? undefined : blobValue;
  if (normalizedColumn === undefined && normalizedBlob === undefined) {
    return false;
  }
  return normalizedColumn !== normalizedBlob;
}

function main(): void {
  const dbPath = process.argv[2];
  if (!dbPath) {
    console.error(
      "usage: tmp_phase3-divergence-census.ts <path-to-sqlite-db>\n" +
        "UNEXECUTED: no DB path was provided. Census run 1 did not run. See phase-3-reader-audit.md.",
    );
    process.exitCode = 1;
    return;
  }

  const database = openNodeSqliteDatabase(dbPath, { readOnly: true });
  const db = getSessionKysely(database);

  const nodeDivergence = new Map<string, DivergenceTally>();
  const windowDivergence = new Map<string, DivergenceTally>();
  let nodesScanned = 0;
  let nodesCorrupt = 0;
  let windowsScanned = 0;
  let windowsCorrupt = 0;
  let windowsMissingOwner = 0;

  // --- session_nodes census ---
  const nodeRows = executeSqliteQuerySync(database, db.selectFrom("session_nodes").selectAll())
    .rows as Array<Record<string, unknown>>;

  const nodeEntryByKey = new Map<string, SessionEntry>();

  for (const row of nodeRows) {
    nodesScanned += 1;
    const sessionKey = String(row.session_key);
    const blobRow: SessionEntryBlobRow = {
      current_session_id: row.current_session_id as string | undefined,
      entry_json: row.entry_json as string,
      updated_at: row.updated_at as number | undefined,
      owner_actor_type: row.owner_actor_type as string | null | undefined,
      owner_actor_id: row.owner_actor_id as string | null | undefined,
      owner_assigned_by_type: row.owner_assigned_by_type as string | null | undefined,
      owner_assigned_by_id: row.owner_assigned_by_id as string | null | undefined,
      owner_assigned_at: row.owner_assigned_at as number | null | undefined,
    };
    let entry: SessionEntry;
    try {
      entry = projectSessionEntry(sessionKey, blobRow);
    } catch (error) {
      if (isSessionRowCorruptError(error)) {
        nodesCorrupt += 1;
        continue;
      }
      throw error;
    }
    nodeEntryByKey.set(sessionKey, entry);
    for (const { column, field } of SESSION_NODES_FIELD_MAP) {
      const columnValue = row[column];
      const blobValue = field(entry);
      if (valuesDiverge(columnValue, blobValue)) {
        record(nodeDivergence, column, sessionKey);
      }
    }
  }

  // --- session_windows census ---
  // session_windows rows carry a `session_key` FK back to the owning
  // session_nodes row; the owning node's projected entry is the blob of
  // record for the duplicated status/model/etc columns.
  const windowRows = executeSqliteQuerySync(database, db.selectFrom("session_windows").selectAll())
    .rows as Array<Record<string, unknown>>;

  for (const row of windowRows) {
    windowsScanned += 1;
    const sessionId = String(row.session_id);
    const ownerKey = row.session_key as string | undefined;
    if (!ownerKey) {
      windowsMissingOwner += 1;
      continue;
    }
    const entry = nodeEntryByKey.get(ownerKey);
    if (!entry) {
      // Owner row was corrupt (already tallied above) or absent. Either way
      // this window's divergence is unobservable without its node's blob.
      windowsCorrupt += 1;
      continue;
    }
    for (const { column, field } of SESSION_WINDOWS_FIELD_MAP) {
      const columnValue = row[column];
      const blobValue = field(entry);
      if (valuesDiverge(columnValue, blobValue)) {
        record(windowDivergence, column, sessionId);
      }
    }
  }

  const report = {
    dbPath,
    sessionNodes: {
      scanned: nodesScanned,
      corrupt: nodesCorrupt,
      divergence: Object.fromEntries(nodeDivergence),
    },
    sessionWindows: {
      scanned: windowsScanned,
      corrupt: windowsCorrupt,
      missingOwner: windowsMissingOwner,
      divergence: Object.fromEntries(windowDivergence),
    },
  };

  console.log(JSON.stringify(report, null, 2));
}

main();
