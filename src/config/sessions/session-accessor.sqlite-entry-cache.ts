import type { DatabaseSync } from "node:sqlite";
import { executeSqliteQuerySync } from "../../infra/kysely-sync.js";
import {
  deferOpenClawAgentPostCommitPublication,
  type OpenClawAgentDatabase,
} from "../../state/openclaw-agent-db.js";
import { hasSqliteSessionOwnerColumns } from "./session-accessor.sqlite-owner-projection.js";
import {
  projectSqliteSessionParticipants,
  projectSqliteSessionParticipantsBatch,
} from "./session-accessor.sqlite-participant-projection.js";
import { getSessionKysely } from "./session-accessor.sqlite-scope.js";
import { projectSessionEntry } from "./session-entry-parse.js";
import { isSessionRowCorruptError } from "./session-row-corrupt-error.js";
import type { SessionEntry } from "./types.js";

type SessionEntryCacheDatabase = Pick<OpenClawAgentDatabase, "agentId" | "db">;

export type SessionEntryCacheSnapshot = {
  entries: Map<string, SessionEntry>;
  keys: string[];
  listEntries: Pick<ReadonlyMap<string, SessionEntry>, "get">;
};

type SqliteSessionEntryCache = SessionEntryCacheSnapshot & {
  listProjections: Map<string, SessionEntry>;
  revisionByKey: Map<string, number>;
  updatedAtByKey: Map<string, number>;
  validityToken: SqliteSessionEntryCacheValidityToken;
};

type LoadedSessionEntrySnapshot = SessionEntryCacheSnapshot & {
  listProjections: Map<string, SessionEntry>;
  revisionByKey: Map<string, number>;
  updatedAtByKey: Map<string, number>;
};

type SqliteSessionEntryCacheValidityToken = {
  dataVersion: number;
  sessionNodesGeneration: number;
};

type SqliteSessionEntryCacheWriteGeneration = {
  after: number;
  before: number;
};

const MAX_INCREMENTAL_ENTRY_READ_KEYS = 500;

// One parsed snapshot per opened agent database bounds memory to the process's database set.
// Weak connection ownership lets closed read-only and evicted database handles release their
// snapshots. The connection-local validity token plus tracked-write invalidation keeps live
// snapshots current; narrow tracked upserts patch one authoritative row after commit, while
// structural/unknown writes invalidate. Without both, every read would re-query and re-parse
// every entry_json document.
const sessionEntryCaches = new WeakMap<DatabaseSync, SqliteSessionEntryCache>();
const sessionNodesGenerationTrackerSchemaVersions = new WeakMap<DatabaseSync, number>();

function readDataVersion(database: DatabaseSync): number {
  const row = database.prepare("PRAGMA data_version").get() as { data_version?: unknown };
  if (typeof row.data_version !== "number") {
    throw new Error("SQLite did not return a numeric PRAGMA data_version");
  }
  return row.data_version;
}

function ensureSessionNodesGenerationTracker(database: DatabaseSync): void {
  const schemaRow = database.prepare("PRAGMA schema_version").get() as {
    schema_version?: unknown;
  };
  if (typeof schemaRow.schema_version !== "number") {
    throw new Error("SQLite did not return a numeric PRAGMA schema_version");
  }
  const trackedSchemaVersion = sessionNodesGenerationTrackerSchemaVersions.get(database);
  if (trackedSchemaVersion === schemaRow.schema_version) {
    return;
  }
  // sqlite-allow-raw -- TEMP triggers are the connection-local ownership boundary: they
  // observe unpublished raw DML. A main-schema change bumps the generation before reinstalling
  // them, so dropping/recreating session_nodes cannot make an old snapshot look current.
  database.exec(`
    CREATE TEMP TABLE IF NOT EXISTS openclaw_session_nodes_cache_generation (id INTEGER NOT NULL PRIMARY KEY CHECK (id = 1), generation INTEGER NOT NULL) STRICT;
    INSERT OR IGNORE INTO openclaw_session_nodes_cache_generation (id, generation) VALUES (1, 0);
    ${trackedSchemaVersion === undefined ? "" : "UPDATE openclaw_session_nodes_cache_generation SET generation = generation + 1 WHERE id = 1;"}
    DROP TRIGGER IF EXISTS openclaw_session_nodes_cache_generation_insert;
    DROP TRIGGER IF EXISTS openclaw_session_nodes_cache_generation_update;
    DROP TRIGGER IF EXISTS openclaw_session_nodes_cache_generation_delete;
    CREATE TEMP TRIGGER openclaw_session_nodes_cache_generation_insert
      AFTER INSERT ON main.session_nodes BEGIN UPDATE openclaw_session_nodes_cache_generation SET generation = generation + 1 WHERE id = 1; END;
    CREATE TEMP TRIGGER openclaw_session_nodes_cache_generation_update
      AFTER UPDATE ON main.session_nodes BEGIN UPDATE openclaw_session_nodes_cache_generation SET generation = generation + 1 WHERE id = 1; END;
    CREATE TEMP TRIGGER openclaw_session_nodes_cache_generation_delete
      AFTER DELETE ON main.session_nodes BEGIN UPDATE openclaw_session_nodes_cache_generation SET generation = generation + 1 WHERE id = 1; END;
  `);
  sessionNodesGenerationTrackerSchemaVersions.set(database, schemaRow.schema_version);
}

function readSessionNodesGeneration(database: DatabaseSync): number {
  ensureSessionNodesGenerationTracker(database);
  const row = database
    .prepare("SELECT generation FROM temp.openclaw_session_nodes_cache_generation WHERE id = 1")
    .get() as { generation?: unknown };
  if (typeof row.generation !== "number") {
    throw new Error("SQLite session_nodes cache generation is unavailable");
  }
  return row.generation;
}

function readCacheValidityToken(database: DatabaseSync): SqliteSessionEntryCacheValidityToken {
  return {
    dataVersion: readDataVersion(database),
    sessionNodesGeneration: readSessionNodesGeneration(database),
  };
}

function cacheValidityTokensEqual(
  left: SqliteSessionEntryCacheValidityToken,
  right: SqliteSessionEntryCacheValidityToken,
): boolean {
  return (
    left.dataVersion === right.dataVersion &&
    left.sessionNodesGeneration === right.sessionNodesGeneration
  );
}

/** Bracket one accessor-owned row write so its publication cannot hide earlier raw DML. */
export function trackSessionEntryCacheWrite(
  database: OpenClawAgentDatabase,
  write: () => void,
): SqliteSessionEntryCacheWriteGeneration | undefined {
  const before = sessionEntryCaches.has(database.db)
    ? readSessionNodesGeneration(database.db)
    : undefined;
  write();
  return before === undefined
    ? undefined
    : { before, after: readSessionNodesGeneration(database.db) };
}

function createListProjection(entry: SessionEntry): SessionEntry {
  // clone:false list consumers treat entries and their nested values as immutable.
  // Share those nested values instead of deep-cloning large snapshots only to discard them.
  const projected = { ...entry };
  delete projected.skillsSnapshot;
  delete projected.systemPromptReport;
  return projected;
}

function createLazyListProjections(
  entries: ReadonlyMap<string, SessionEntry>,
  projectedByKey: Map<string, SessionEntry>,
): Pick<ReadonlyMap<string, SessionEntry>, "get"> {
  return {
    get: (sessionKey) => {
      const cached = projectedByKey.get(sessionKey);
      if (cached) {
        return cached;
      }
      const entry = entries.get(sessionKey);
      if (!entry) {
        return undefined;
      }
      // A snapshot projects each key once. clone:false readers share this immutable
      // value, so replacing it would break identity and reintroduce store-wide cloning.
      const projected = createListProjection(entry);
      projectedByKey.set(sessionKey, projected);
      return projected;
    },
  };
}

function loadSessionEntrySnapshot(database: SessionEntryCacheDatabase): LoadedSessionEntrySnapshot {
  const db = getSessionKysely(database.db);
  const rows = hasSqliteSessionOwnerColumns(database.db)
    ? executeSqliteQuerySync(
        database.db,
        db
          .selectFrom("session_nodes")
          .select([
            "session_key",
            "entry_json",
            "updated_at",
            "revision",
            "owner_actor_type",
            "owner_actor_id",
            "owner_assigned_by_type",
            "owner_assigned_by_id",
            "owner_assigned_at",
          ])
          .orderBy("session_key"),
      ).rows
    : executeSqliteQuerySync(
        database.db,
        db
          .selectFrom("session_nodes")
          .select(["session_key", "entry_json", "updated_at", "revision"])
          .orderBy("session_key"),
      ).rows;
  const parsedEntries = new Map<string, SessionEntry>();
  for (const row of rows) {
    try {
      parsedEntries.set(row.session_key, projectSessionEntry(row.session_key, row));
    } catch (error) {
      if (!isSessionRowCorruptError(error)) {
        throw error;
      }
    }
  }
  const entries = projectSqliteSessionParticipantsBatch(database.db, parsedEntries);
  const listProjections = new Map<string, SessionEntry>();
  return {
    entries,
    keys: rows.map((row) => row.session_key),
    listEntries: createLazyListProjections(entries, listProjections),
    listProjections,
    revisionByKey: new Map(rows.map((row) => [row.session_key, row.revision])),
    updatedAtByKey: new Map(rows.map((row) => [row.session_key, row.updated_at])),
  };
}

function incrementallyRevalidateSessionEntrySnapshot(
  database: SessionEntryCacheDatabase,
  cached: SqliteSessionEntryCache,
  validityToken: SqliteSessionEntryCacheValidityToken,
): SqliteSessionEntryCache {
  const db = getSessionKysely(database.db);
  const versions = executeSqliteQuerySync(
    database.db,
    db.selectFrom("session_nodes").select(["session_key", "updated_at", "revision"]),
  ).rows;
  const updatedAtByKey = new Map(versions.map((row) => [row.session_key, row.updated_at]));
  const revisionByKey = new Map(versions.map((row) => [row.session_key, row.revision]));
  // updated_at is entry-controlled and can repeat across writes; the Phase-1 revision
  // column is bumped on every session_nodes write, so it catches a same-millisecond
  // rewrite updated_at alone would miss. Either signal changing marks the row stale.
  const changedKeys = versions
    .filter(
      (row) =>
        cached.updatedAtByKey.get(row.session_key) !== row.updated_at ||
        cached.revisionByKey.get(row.session_key) !== row.revision,
    )
    .map((row) => row.session_key);
  const removedKeys = cached.keys.filter((sessionKey) => !updatedAtByKey.has(sessionKey));

  if (changedKeys.length === 0 && removedKeys.length === 0) {
    cached.validityToken = validityToken;
    return cached;
  }

  // Keep the parameterized IN probe below SQLite variable limits. A bulk change is
  // already cheaper to reload than to preserve individual parsed identities.
  if (changedKeys.length > MAX_INCREMENTAL_ENTRY_READ_KEYS) {
    const loaded = loadSessionEntrySnapshot(database);
    return { ...loaded, validityToken };
  }

  const entries = new Map(cached.entries);
  const listProjections = new Map(cached.listProjections);
  for (const sessionKey of [...changedKeys, ...removedKeys]) {
    entries.delete(sessionKey);
    listProjections.delete(sessionKey);
  }
  if (changedKeys.length > 0) {
    const changedRows = hasSqliteSessionOwnerColumns(database.db)
      ? executeSqliteQuerySync(
          database.db,
          db
            .selectFrom("session_nodes")
            .select([
              "session_key",
              "entry_json",
              "owner_actor_type",
              "owner_actor_id",
              "owner_assigned_by_type",
              "owner_assigned_by_id",
              "owner_assigned_at",
            ])
            .where("session_key", "in", changedKeys),
        ).rows
      : executeSqliteQuerySync(
          database.db,
          db
            .selectFrom("session_nodes")
            .select(["session_key", "entry_json"])
            .where("session_key", "in", changedKeys),
        ).rows;
    for (const row of changedRows) {
      try {
        const entry = projectSessionEntry(row.session_key, row);
        entries.set(
          row.session_key,
          projectSqliteSessionParticipants(database.db, row.session_key, entry),
        );
      } catch (error) {
        if (!isSessionRowCorruptError(error)) {
          throw error;
        }
      }
    }
  }
  return {
    entries,
    keys: versions.map((row) => row.session_key).toSorted(),
    listEntries: createLazyListProjections(entries, listProjections),
    listProjections,
    revisionByKey,
    updatedAtByKey,
    validityToken,
  };
}

export function readSessionEntryCache(
  database: SessionEntryCacheDatabase,
  options: { cache: boolean; latest?: boolean },
): SessionEntryCacheSnapshot {
  if (!options.cache || options.latest || database.db.isTransaction) {
    return loadSessionEntrySnapshot(database);
  }
  const validityToken = readCacheValidityToken(database.db);
  const cached = sessionEntryCaches.get(database.db);
  if (cached && cacheValidityTokensEqual(cached.validityToken, validityToken)) {
    return cached;
  }
  if (cached && cached.validityToken.dataVersion === validityToken.dataVersion) {
    // updated_at is entry-controlled, not a rowversion. Other connections can rewrite entry_json
    // without advancing it, so data_version changes must fully reload or same-ms rewrites go stale.
    // The TEMP generation changes only for session_nodes DML, including raw same-connection
    // writers. Unrelated transcript-table writes therefore stay on the O(1) cache-hit path.
    const revalidated = incrementallyRevalidateSessionEntrySnapshot(
      database,
      cached,
      validityToken,
    );
    if (readDataVersion(database.db) !== validityToken.dataVersion) {
      // An external commit raced the two incremental reads. Reload from one row snapshot;
      // publishing their mixed result could temporarily omit or retain the wrong keys.
      const reloadToken = readCacheValidityToken(database.db);
      const loaded = loadSessionEntrySnapshot(database);
      const next = { ...loaded, validityToken: reloadToken };
      sessionEntryCaches.set(database.db, next);
      return next;
    }
    sessionEntryCaches.set(database.db, revalidated);
    return revalidated;
  }
  const loaded = loadSessionEntrySnapshot(database);
  const next = { ...loaded, validityToken };
  sessionEntryCaches.set(database.db, next);
  return next;
}

function invalidateTrackedCache(database: OpenClawAgentDatabase): void {
  const invalidate = () => {
    sessionEntryCaches.delete(database.db);
  };
  if (deferOpenClawAgentPostCommitPublication(database, invalidate)) {
    return;
  }
  if (database.db.isTransaction) {
    throw new Error(
      "SQLite session entry writes must use runOpenClawAgentWriteTransaction for cache publication",
    );
  }
  invalidate();
}

function publishTrackedCacheUpdate(database: OpenClawAgentDatabase, publish: () => void): void {
  if (deferOpenClawAgentPostCommitPublication(database, publish)) {
    return;
  }
  if (database.db.isTransaction) {
    throw new Error(
      "SQLite session entry writes must use runOpenClawAgentWriteTransaction for cache publication",
    );
  }
  publish();
}

function publishSqliteSessionEntryCacheUpsert(
  database: OpenClawAgentDatabase,
  row: {
    current_session_id: string;
    entry_json: string;
    session_key: string;
    updated_at: number;
  },
  writeGeneration?: SqliteSessionEntryCacheWriteGeneration,
): void {
  const ownerRow = hasSqliteSessionOwnerColumns(database.db)
    ? executeSqliteQuerySync(
        database.db,
        getSessionKysely(database.db)
          .selectFrom("session_nodes")
          .select([
            "owner_actor_type",
            "owner_actor_id",
            "owner_assigned_by_type",
            "owner_assigned_by_id",
            "owner_assigned_at",
          ])
          .where("session_key", "=", row.session_key)
          .limit(1),
      ).rows[0]
    : undefined;
  // The write path bumps `revision` server-side (eb("session_nodes.revision", "+", 1)),
  // so the pre-write `sessionNode` the caller holds cannot supply its post-write value;
  // read it back once here to key the write-through cache entry.
  const revisionRow = executeSqliteQuerySync(
    database.db,
    getSessionKysely(database.db)
      .selectFrom("session_nodes")
      .select("revision")
      .where("session_key", "=", row.session_key)
      .limit(1),
  ).rows[0];
  let parsedEntry: SessionEntry;
  try {
    parsedEntry = projectSessionEntry(row.session_key, {
      current_session_id: row.current_session_id,
      entry_json: row.entry_json,
      updated_at: row.updated_at,
      ...ownerRow,
    });
  } catch (error) {
    if (!isSessionRowCorruptError(error)) {
      throw error;
    }
    // Write-adjacent read of a row just written by this same operation; a corrupt
    // read here should be near-impossible. Fail open to full invalidation rather
    // than letting a post-write cache-publish throw destabilize the write caller.
    invalidateTrackedCache(database);
    return;
  }
  const entry = projectSqliteSessionParticipants(database.db, row.session_key, parsedEntry);
  if (!writeGeneration) {
    invalidateTrackedCache(database);
    return;
  }
  publishTrackedCacheUpdate(database, () => {
    const cached = sessionEntryCaches.get(database.db);
    if (!cached) {
      return;
    }
    const generationIsContinuous =
      cached.validityToken.sessionNodesGeneration === writeGeneration.before;
    const entries = new Map(cached.entries);
    entries.set(row.session_key, entry);
    const listProjections = new Map(cached.listProjections);
    listProjections.delete(row.session_key);
    const updatedAtByKey = new Map(cached.updatedAtByKey);
    const knownKey = updatedAtByKey.has(row.session_key);
    updatedAtByKey.set(row.session_key, row.updated_at);
    const revisionByKey = new Map(cached.revisionByKey);
    if (revisionRow) {
      revisionByKey.set(row.session_key, revisionRow.revision);
    } else {
      revisionByKey.delete(row.session_key);
    }
    // Advance only across the bracketed row write. A raw write before/after this bracket leaves
    // a generation gap, while the retained data_version still exposes external commits.
    sessionEntryCaches.set(database.db, {
      entries,
      keys: knownKey ? cached.keys : [...cached.keys, row.session_key].toSorted(),
      listEntries: createLazyListProjections(entries, listProjections),
      listProjections,
      revisionByKey,
      updatedAtByKey,
      validityToken: generationIsContinuous
        ? {
            ...cached.validityToken,
            sessionNodesGeneration: writeGeneration.after,
          }
        : cached.validityToken,
    });
  });
}

export function publishSessionEntryCacheInvalidation(
  database: OpenClawAgentDatabase,
  row?: {
    current_session_id: string;
    entry_json: string;
    session_key: string;
    updated_at: number;
  },
  writeGeneration?: SqliteSessionEntryCacheWriteGeneration,
): void {
  if (row) {
    publishSqliteSessionEntryCacheUpsert(database, row, writeGeneration);
    return;
  }
  invalidateTrackedCache(database);
}
