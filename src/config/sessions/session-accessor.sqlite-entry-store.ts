/* oxlint-disable max-lines -- Phase 1 CS-2 revision bump pushed this grandfathered file over the
   700-line cap by a few lines; split is Phase 2/3 projection-extraction scope, not CS-2. */
import { uniqueStrings } from "@openclaw/normalization-core/string-normalization";
import type { Selectable } from "kysely";
import {
  executeSqliteQuerySync,
  executeSqliteQueryTakeFirstSync,
} from "../../infra/kysely-sync.js";
import type { DB as OpenClawAgentKyselyDatabase } from "../../state/openclaw-agent-db.generated.js";
import type { OpenClawAgentDatabase } from "../../state/openclaw-agent-db.js";
import {
  linkSessionConversation,
  prepareSessionConversation,
  upsertConversationIdentity,
} from "./session-accessor.sqlite-conversation.js";
import {
  publishSessionEntryCacheInvalidation,
  trackSessionEntryCacheWrite,
} from "./session-accessor.sqlite-entry-cache.js";
import { sqliteSessionSnapshotRowsEqual } from "./session-accessor.sqlite-entry-equality.js";
import {
  clearSessionCollaborationForKey,
  deleteSessionDeliveryArtifacts,
  deleteSessionNodeArtifacts,
  rehomeLegacySessionNodeArtifacts,
} from "./session-accessor.sqlite-node-artifacts.js";
import { hasSqliteSessionOwnerColumns } from "./session-accessor.sqlite-owner-projection.js";
import { resolveSessionEntryProvenanceRow } from "./session-accessor.sqlite-provenance.js";
import { collectSessionStateIdsForEntry } from "./session-accessor.sqlite-references.js";
import {
  cloneSessionEntry,
  getSessionKysely,
  normalizeSqliteSessionKey,
} from "./session-accessor.sqlite-scope.js";
import {
  bindSessionNode,
  bindSessionRoot,
  normalizeSessionEntryTimestamp,
} from "./session-accessor.sqlite-session-row.js";
import { readTranscriptMutationStateInTransaction } from "./session-accessor.sqlite-transcript-state.js";
import {
  assertCanonicalSessionEntryLineageWrite,
  assertCanonicalSqliteSessionKeysCurrent,
  assertCanonicalSessionKeyWriteMatchesDatabase,
  canonicalSessionKeyMigrationRequiredError,
  isCanonicalSessionKeyMigrationRequiredError,
} from "./session-canonical-key.js";
import { SessionConflictError } from "./session-conflict-error.js";
import {
  hasValidSessionEntryIdentity,
  projectSessionEntry,
  readCanonicalSqliteSessionEntryRow,
} from "./session-entry-parse.js";
import { isSessionRowCorruptError } from "./session-row-corrupt-error.js";
import {
  collectSessionEntryLookupKeys,
  resolveDeliveryProvenCanonicalSessionKey,
} from "./store-entry.js";
import type { SessionEntry } from "./types.js";
export { collectSessionEntryLookupKeys } from "./store-entry.js";

type OpenClawAgentDatabaseReader = Pick<OpenClawAgentDatabase, "agentId" | "db">;
type SessionEntryRow = Selectable<OpenClawAgentKyselyDatabase["session_nodes"]>;
export type ResolvedSessionEntryRow = {
  entry: SessionEntry;
  legacyKeys: string[];
  row: SessionEntryRow;
};
type SqliteSessionEntrySelectionSnapshot = {
  selected: ResolvedSessionEntryRow | undefined;
  selectedRows: Array<{ entry: SessionEntry; sessionKey: string }>;
};
type SqliteLifecycleTargetSnapshot = {
  primary: { entry: SessionEntry; key: string; revision: number } | undefined;
  rows: Array<{ entry: SessionEntry; sessionKey: string }>;
};

export function readSessionIdentitySnapshot(
  database: OpenClawAgentDatabase,
  sessionKeys: Iterable<string>,
): Map<string, SessionEntry> {
  const snapshot = new Map<string, SessionEntry>();
  for (const sessionKey of uniqueStrings([...sessionKeys].map((key) => key.trim()))) {
    const row = readExactSessionEntryRow(database, sessionKey);
    if (row) {
      snapshot.set(sessionKey, cloneSessionEntry(row.entry));
    }
  }
  return snapshot;
}

export function createSessionIdentitySnapshot(
  rows: readonly { entry: SessionEntry; sessionKey: string }[],
): Map<string, SessionEntry> {
  return new Map(rows.map((row) => [row.sessionKey, cloneSessionEntry(row.entry)]));
}

export function readSessionEntryRow(
  database: OpenClawAgentDatabaseReader,
  sessionKey: string,
): ResolvedSessionEntryRow | undefined {
  assertCanonicalSqliteSessionKeysCurrent(database);
  return readSessionEntryRowUnchecked(database, sessionKey);
}

function readSessionEntryRowUnchecked(
  database: OpenClawAgentDatabaseReader,
  sessionKey: string,
): ResolvedSessionEntryRow | undefined {
  const db = getSessionKysely(database.db);
  const lookupKeys = collectSessionEntryLookupKeys(database, sessionKey);
  if (lookupKeys.length === 0) {
    return undefined;
  }
  const rows = executeSqliteQuerySync(
    database.db,
    db
      .selectFrom("session_nodes")
      .selectAll()
      .where("session_key", "in", lookupKeys)
      .orderBy("session_key", "asc"),
  ).rows;
  let selected: ResolvedSessionEntryRow | undefined;
  for (const row of rows) {
    let entry: SessionEntry | null;
    try {
      entry = readCanonicalSqliteSessionEntryRow(database, row);
    } catch (error) {
      if (!isCanonicalSessionKeyMigrationRequiredError(error)) {
        throw error;
      }
      continue;
    }
    if (!entry || row.session_key !== sessionKey.trim()) {
      continue;
    }
    selected = { entry, legacyKeys: [], row };
  }
  return selected;
}

// Async updaters prepare against this complete selection. Capturing alias rows
// prevents the commit phase from deleting a concurrently changed legacy key.
export function readSessionEntrySelectionSnapshot(
  database: OpenClawAgentDatabase,
  sessionKey: string,
  exact: boolean,
): SqliteSessionEntrySelectionSnapshot {
  const selected = exact
    ? readExactSessionEntryRow(database, sessionKey)
    : readSessionEntryRow(database, sessionKey);
  const selectedKeys = collectSessionEntryLookupKeys(database, sessionKey).toSorted();
  return {
    selected,
    selectedRows: selectedKeys.flatMap((candidateKey) => {
      const row = readExactSessionEntryRow(database, candidateKey);
      return row ? [{ entry: cloneSessionEntry(row.entry), sessionKey: candidateKey }] : [];
    }),
  };
}

/**
 * Conflict predicate for `assertSessionEntrySelectionUnchanged`. Integer
 * revision compare — a key change, an existence flip (one side selected,
 * the other not), or a differing `row.revision` is a conflict.
 */
function sessionEntrySelectionPrimaryConflicted(
  expected: SqliteSessionEntrySelectionSnapshot,
  current: SqliteSessionEntrySelectionSnapshot,
): boolean {
  const expectedKey = expected.selected?.row.session_key;
  const currentKey = current.selected?.row.session_key;
  const expectedRevision = expected.selected?.row.revision;
  const currentRevision = current.selected?.row.revision;
  if (expectedKey === undefined && currentKey === undefined) {
    return false;
  }
  return expectedKey !== currentKey || expectedRevision !== currentRevision;
}

export function assertSessionEntrySelectionUnchanged(
  expected: SqliteSessionEntrySelectionSnapshot,
  current: SqliteSessionEntrySelectionSnapshot,
  operationLabel: string,
): void {
  // The alias/selected-rows key-set guard is orthogonal to the primary
  // revision/value compare and stays as a structural check
  // (PHASE-1.md CS-3a scope note: not deleted, not converted).
  if (
    sessionEntrySelectionPrimaryConflicted(expected, current) ||
    !sqliteSessionSnapshotRowsEqual(expected.selectedRows, current.selectedRows)
  ) {
    const key =
      expected.selected?.row.session_key ?? current.selected?.row.session_key ?? operationLabel;
    throw new SessionConflictError({
      actualRevision: current.selected?.row.revision ?? -1,
      expectedRevision: expected.selected?.row.revision ?? -1,
      key,
    });
  }
}

export function readExactSessionEntryRow(
  database: OpenClawAgentDatabaseReader,
  sessionKey: string,
): ResolvedSessionEntryRow | undefined {
  const db = getSessionKysely(database.db);
  const row = executeSqliteQueryTakeFirstSync(
    database.db,
    db.selectFrom("session_nodes").selectAll().where("session_key", "=", sessionKey),
  );
  if (!row) {
    return undefined;
  }
  const entry = readCanonicalSqliteSessionEntryRow(database, row);
  return entry ? { entry, legacyKeys: [], row } : undefined;
}

export function readExactSessionEntryJsonForCanonicalRepair(
  database: Pick<OpenClawAgentDatabase, "db">,
  sessionKey: string,
): string | undefined {
  const db = getSessionKysely(database.db);
  return executeSqliteQueryTakeFirstSync(
    database.db,
    db.selectFrom("session_nodes").select("entry_json").where("session_key", "=", sessionKey),
  )?.entry_json;
}

export function readExactSessionEntryRowValidated(
  database: OpenClawAgentDatabaseReader,
  sessionKey: string,
): ResolvedSessionEntryRow | undefined {
  assertCanonicalSqliteSessionKeysCurrent(database);
  return readExactSessionEntryRow(database, sessionKey);
}

export function readSessionEntryStore(
  database: OpenClawAgentDatabase,
  options: { allowCanonicalRepair?: boolean } = {},
): Record<string, SessionEntry> {
  if (options.allowCanonicalRepair !== true) {
    assertCanonicalSqliteSessionKeysCurrent(database);
  }
  const db = getSessionKysely(database.db);
  const rows = executeSqliteQuerySync(
    database.db,
    db
      .selectFrom("session_nodes")
      .select(["current_session_id", "entry_json", "session_key", "updated_at"])
      .orderBy("session_key"),
  ).rows;
  const store: Record<string, SessionEntry> = {};
  for (const row of rows) {
    // Doctor lifecycle projection supplies its separately hydrated expected entry for rejected
    // raw rows; ordinary exact reads still fail loud before a write can replace one.
    try {
      store[row.session_key] = projectSessionEntry(row.session_key, row);
    } catch (error) {
      if (!isSessionRowCorruptError(error)) {
        throw error;
      }
    }
  }
  return store;
}

export function readSessionEntryCount(database: OpenClawAgentDatabase): number {
  const db = getSessionKysely(database.db);
  const rows = executeSqliteQuerySync(
    database.db,
    db.selectFrom("session_nodes").select(["entry_json", "session_key"]),
  ).rows;
  return rows.reduce((count, row) => {
    try {
      projectSessionEntry(row.session_key, row);
      return count + 1;
    } catch (error) {
      if (!isSessionRowCorruptError(error)) {
        throw error;
      }
      return count;
    }
  }, 0);
}

export function readSessionEntryKeys(database: OpenClawAgentDatabaseReader): string[] {
  const db = getSessionKysely(database.db);
  return executeSqliteQuerySync(
    database.db,
    db
      .selectFrom("session_nodes")
      .select(["entry_json", "session_key"])
      .orderBy("session_key", "asc"),
  ).rows.flatMap((row) => {
    try {
      projectSessionEntry(row.session_key, row);
      return [row.session_key];
    } catch (error) {
      if (!isSessionRowCorruptError(error)) {
        throw error;
      }
      return [];
    }
  });
}

export function resolveLifecyclePrimaryEntry(
  database: OpenClawAgentDatabase,
  target: { canonicalKey: string; storeKeys: string[] },
  options: { allowCanonicalMove?: boolean } = {},
): { key: string; entry: SessionEntry; revision: number } | undefined {
  const rows = target.storeKeys.flatMap((key) => {
    const sessionKey = key.trim();
    const row = readExactSessionEntryRow(database, sessionKey);
    return row ? [{ key: sessionKey, entry: row.entry, revision: row.row.revision }] : [];
  });
  if (rows.length > 1) {
    throw canonicalSessionKeyMigrationRequiredError(
      `duplicate rows resolve to canonical session key ${target.canonicalKey}`,
    );
  }
  const [row] = rows;
  if (row && row.key !== target.canonicalKey && options.allowCanonicalMove !== true) {
    throw canonicalSessionKeyMigrationRequiredError(
      `non-canonical persisted row resolves to session key ${target.canonicalKey}`,
    );
  }
  return row;
}

export function readLifecycleTargetSnapshot(
  database: OpenClawAgentDatabase,
  target: { canonicalKey: string; storeKeys: string[] },
  options: { allowCanonicalMove?: boolean } = {},
): SqliteLifecycleTargetSnapshot {
  assertCanonicalSqliteSessionKeysCurrent(database);
  const normalized = normalizeLifecycleTarget(target);
  return {
    primary: resolveLifecyclePrimaryEntry(database, normalized, options),
    rows: normalized.storeKeys.flatMap((sessionKey) => {
      const row = readExactSessionEntryRow(database, sessionKey);
      return row ? [{ entry: cloneSessionEntry(row.entry), sessionKey }] : [];
    }),
  };
}

/**
 * Conflict predicate for `assertLifecycleTargetSnapshotUnchanged`. Integer
 * revision compare on the primary row plus the same alias-row structural
 * guard `sqliteLifecycleTargetSnapshotsEqual` already performs on `.rows`.
 */
function lifecycleTargetPrimaryConflicted(
  expected: SqliteLifecycleTargetSnapshot,
  current: SqliteLifecycleTargetSnapshot,
): boolean {
  if (expected.primary === undefined && current.primary === undefined) {
    return false;
  }
  return (
    expected.primary?.key !== current.primary?.key ||
    expected.primary?.revision !== current.primary?.revision
  );
}

export function assertLifecycleTargetSnapshotUnchanged(
  expected: SqliteLifecycleTargetSnapshot,
  current: SqliteLifecycleTargetSnapshot,
  operationLabel: string,
): void {
  // The alias-row structural guard stays exactly as sqliteLifecycleTargetSnapshotsEqual
  // performs it today (key-set + value compare on `.rows`), independent of mode.
  if (
    lifecycleTargetPrimaryConflicted(expected, current) ||
    !sqliteSessionSnapshotRowsEqual(expected.rows, current.rows)
  ) {
    const key = expected.primary?.key ?? current.primary?.key ?? operationLabel;
    throw new SessionConflictError({
      actualRevision: current.primary?.revision ?? -1,
      expectedRevision: expected.primary?.revision ?? -1,
      key,
    });
  }
}

export function normalizeLifecycleTarget(target: { canonicalKey: string; storeKeys: string[] }): {
  canonicalKey: string;
  storeKeys: string[];
} {
  const canonicalKey = normalizeSqliteSessionKey(target.canonicalKey);
  return {
    canonicalKey,
    storeKeys: uniqueStrings([canonicalKey, ...target.storeKeys.map(normalizeSqliteSessionKey)]),
  };
}

export function deleteSessionEntryRows(
  database: OpenClawAgentDatabase,
  sessionKey: string,
  options: { deleteOwnedWindows?: boolean; deliveryCleanupKeys?: readonly string[] } = {},
): void {
  const db = getSessionKysely(database.db);
  const windows = executeSqliteQuerySync(
    database.db,
    db.selectFrom("session_windows").select("session_id").where("session_key", "=", sessionKey),
  ).rows;
  const survivingNodes = executeSqliteQuerySync(
    database.db,
    db
      .selectFrom("session_nodes")
      .select(["current_session_id", "entry_json", "session_key"])
      .where("session_key", "!=", sessionKey)
      .orderBy("session_key", "asc"),
  ).rows;
  for (const window of windows) {
    const survivingNode = survivingNodes.find((node) => {
      if (node.current_session_id === window.session_id) {
        return true;
      }
      try {
        const entry = projectSessionEntry(node.session_key, node);
        return collectSessionStateIdsForEntry(entry).includes(window.session_id);
      } catch (error) {
        if (!isSessionRowCorruptError(error)) {
          throw error;
        }
        return false;
      }
    });
    if (survivingNode) {
      executeSqliteQuerySync(
        database.db,
        db
          .updateTable("session_windows")
          .set({ session_key: survivingNode.session_key })
          .where("session_id", "=", window.session_id),
      );
    }
  }
  if (options.deleteOwnedWindows) {
    deleteSessionDeliveryArtifacts(database, sessionKey, options.deliveryCleanupKeys);
    deleteSessionNodeArtifacts(database, sessionKey);
    executeSqliteQuerySync(
      database.db,
      db.deleteFrom("session_nodes").where("session_key", "=", sessionKey),
    );
    publishSessionEntryCacheInvalidation(database);
    return;
  }
  const remainingWindow = executeSqliteQueryTakeFirstSync(
    database.db,
    db
      .selectFrom("session_windows")
      .select(["session_id", "updated_at"])
      .where("session_key", "=", sessionKey)
      .orderBy("updated_at", "desc")
      .orderBy("session_id", "asc")
      .limit(1),
  );
  if (remainingWindow) {
    deleteSessionNodeArtifacts(database, sessionKey);
    clearSqliteSessionEntryPreservingWindows(database, {
      sessionId: remainingWindow.session_id,
      sessionKey,
      updatedAt: remainingWindow.updated_at,
    });
    publishSessionEntryCacheInvalidation(database);
    return;
  }
  executeSqliteQuerySync(
    database.db,
    db.deleteFrom("session_nodes").where("session_key", "=", sessionKey),
  );
  publishSessionEntryCacheInvalidation(database);
}

/** Remove the logical entry while retaining its node-owned transcript windows. */
function clearSqliteSessionEntryPreservingWindows(
  database: OpenClawAgentDatabase,
  params: { sessionId: string; sessionKey: string; updatedAt: number },
): void {
  const db = getSessionKysely(database.db);
  const cleared = {
    current_session_id: params.sessionId,
    entry_json: "{}",
    entry_valid: -1,
    updated_at: params.updatedAt,
    status: null,
    created_at: null,
    created_via: null,
    created_actor_type: null,
    created_actor_id: null,
    project_id: null,
    parent_session_key: null,
    spawned_by: null,
    fork_source_session_key: null,
    fork_source_session_id: null,
    fork_source_entry_id: null,
    label: null,
    display_name: null,
    category: null,
    icon: null,
    pinned_at: null,
    archived_at: null,
    last_read_at: null,
    last_interaction_at: null,
    last_activity_at: null,
    ...(hasSqliteSessionOwnerColumns(database.db)
      ? {
          owner_actor_type: null,
          owner_actor_id: null,
          owner_assigned_by_type: null,
          owner_assigned_by_id: null,
          owner_assigned_at: null,
        }
      : {}),
  } as const;
  executeSqliteQuerySync(
    database.db,
    db
      .insertInto("session_nodes")
      .values({ session_key: params.sessionKey, ...cleared, revision: 1 })
      .onConflict((conflict) =>
        conflict
          .column("session_key")
          .doUpdateSet((eb) => ({ ...cleared, revision: eb("session_nodes.revision", "+", 1) })),
      ),
  );
  executeSqliteQuerySync(
    database.db,
    db
      .updateTable("session_nodes")
      .set((eb) => ({ entry_valid: -1, revision: eb("session_nodes.revision", "+", 1) }))
      .where("session_key", "=", params.sessionKey),
  );
}

export function deleteLifecycleTargetRows(
  database: OpenClawAgentDatabase,
  target: { canonicalKey: string; storeKeys: string[] },
): void {
  for (const sessionKey of uniqueStrings([target.canonicalKey, ...target.storeKeys])) {
    const trimmed = sessionKey.trim();
    if (trimmed) {
      deleteSessionEntryRows(database, trimmed);
    }
  }
}

/**
 * Integer revision compare (issue #81): `expectedRevision` is the sibling
 * `.revision` already resolved alongside the caller's `expectedEntry`
 * snapshot (`resolveLifecyclePrimaryEntry`'s return / `targetSnapshot.primary`),
 * not a fresh read. `-1` means the caller had no persisted row to compare
 * against (matches the `SessionConflictError` sentinel convention elsewhere).
 */
export function assertLifecycleTargetUnchanged(
  database: OpenClawAgentDatabase,
  target: { canonicalKey: string; storeKeys: string[] },
  expected: { entry: SessionEntry; revision: number } | undefined,
  operation: "deleted" | "reset",
): void {
  const current = resolveLifecyclePrimaryEntry(database, target);
  const expectedRevision = expected?.revision ?? -1;
  const actualRevision = current?.revision ?? -1;
  if (expectedRevision === actualRevision) {
    return;
  }
  throw new SessionConflictError({
    actualRevision,
    expectedRevision,
    key: target.canonicalKey,
    message: `SQLite session entry changed before ${operation} lifecycle mutation`,
  });
}

export function deleteLegacySessionEntryRows(
  database: OpenClawAgentDatabase,
  legacyKeys: string[],
  sessionKey: string,
  options: { rehomeMembers?: boolean } = {},
): void {
  if (legacyKeys.length === 0) {
    return;
  }
  const db = getSessionKysely(database.db);
  for (const legacyKey of legacyKeys) {
    if (legacyKey === sessionKey) {
      continue;
    }
    rehomeSessionWindows(database, sessionKey, [legacyKey]);
    rehomeLegacySessionNodeArtifacts(database, legacyKey, sessionKey, options);
    executeSqliteQuerySync(
      database.db,
      db.deleteFrom("session_nodes").where("session_key", "=", legacyKey),
    );
    publishSessionEntryCacheInvalidation(database);
  }
}

/** Move retained generations to the canonical node before removing key aliases. */
export function rehomeSessionWindows(
  database: OpenClawAgentDatabase,
  canonicalKey: string,
  previousKeys: Iterable<string>,
): void {
  const legacyKeys = uniqueStrings([...previousKeys].map((key) => key.trim())).filter(
    (key) => key && key !== canonicalKey,
  );
  if (legacyKeys.length === 0) {
    return;
  }
  const db = getSessionKysely(database.db);
  executeSqliteQuerySync(
    database.db,
    db
      .updateTable("session_windows")
      .set({ session_key: canonicalKey })
      .where("session_key", "in", legacyKeys),
  );
}

export function writeSessionEntry(
  database: OpenClawAgentDatabase,
  sessionKey: string,
  entry: SessionEntry,
  options: {
    allowStoredAliases?: boolean;
    preserveNodeSuggestions?: boolean;
    previousEntry?: SessionEntry | null;
  } = {},
): void {
  const db = getSessionKysely(database.db);
  if (!options.allowStoredAliases) {
    assertCanonicalSessionKeyWriteMatchesDatabase(database, sessionKey);
    assertCanonicalSessionEntryLineageWrite(database, entry);
    if (resolveDeliveryProvenCanonicalSessionKey(sessionKey, entry) !== sessionKey) {
      throw canonicalSessionKeyMigrationRequiredError(
        `refusing non-canonical session key write ${sessionKey}`,
      );
    }
  }
  const normalizedEntry = normalizeSessionEntryTimestamp(entry);
  if (!hasValidSessionEntryIdentity(normalizedEntry)) {
    throw new Error("Refusing invalid SQLite session entry identity");
  }
  const updatedAt = normalizedEntry.updatedAt;
  // Doctor validated the raw rejected row before entering the transaction and passes its
  // hydrated snapshot explicitly; re-reading it through the runtime parser must stay fail-closed.
  const canonicalPreviousRow =
    options.allowStoredAliases && options.previousEntry !== undefined
      ? undefined
      : readExactSessionEntryRow(database, sessionKey);
  const canonicalPreviousEntry =
    canonicalPreviousRow?.entry ??
    (options.allowStoredAliases && options.previousEntry !== undefined
      ? (options.previousEntry ?? undefined)
      : undefined);
  const previousEntry =
    options.previousEntry === undefined
      ? canonicalPreviousEntry
      : (options.previousEntry ?? undefined);
  // The lifecycle-selected entry owns visibility copy-forward semantics.
  if (previousEntry && previousEntry.sessionId !== normalizedEntry.sessionId) {
    delete normalizedEntry.visibility;
  }
  // Collaboration rows belong to the exact canonical node being overwritten,
  // which can differ from the selected alias during canonicalization.
  if (canonicalPreviousEntry && canonicalPreviousEntry.sessionId !== normalizedEntry.sessionId) {
    // Doctor merges duplicate logical nodes; suggestions are owned by session_key,
    // not by the transcript generation being replaced. Membership remains winner-only.
    clearSessionCollaborationForKey(database, sessionKey, {
      clearSuggestions: options.preserveNodeSuggestions !== true,
    });
  }
  // Registry writes snapshot the current transcript watermark so recovery can
  // distinguish same-millisecond transcript writes before and after this row.
  const transcriptObservedAt =
    readTranscriptMutationStateInTransaction(database, normalizedEntry.sessionId).updatedAt ??
    updatedAt;
  const boundSessionRoot = bindSessionRoot({ entry: normalizedEntry, sessionKey, updatedAt });
  const conversation = prepareSessionConversation({
    entry: normalizedEntry,
    sessionScope: boundSessionRoot.session_scope,
  });
  if (conversation) {
    upsertConversationIdentity(database, conversation.identity, updatedAt);
  }
  const boundSessionRow = {
    ...boundSessionRoot,
    primary_conversation_id:
      conversation?.role === "primary" ? conversation.identity.conversationRef : null,
    transcript_observed_at: transcriptObservedAt,
  };
  const sessionRow = resolveSessionEntryProvenanceRow({
    boundSessionRow,
    database,
    entry: normalizedEntry,
    previousEntry,
  });
  const sessionNode = bindSessionNode({ entry: normalizedEntry, sessionKey, updatedAt });
  const writeGeneration = trackSessionEntryCacheWrite(database, () => {
    executeSqliteQuerySync(
      database.db,
      db
        .insertInto("session_nodes")
        .values({ ...sessionNode, revision: 1 })
        .onConflict((conflict) =>
          conflict.column("session_key").doUpdateSet((eb) => ({
            current_session_id: sessionNode.current_session_id,
            entry_json: sessionNode.entry_json,
            entry_valid: sessionNode.entry_valid,
            updated_at: sessionNode.updated_at,
            status: sessionNode.status,
            created_at: sessionNode.created_at,
            created_via: sessionNode.created_via,
            created_actor_type: sessionNode.created_actor_type,
            created_actor_id: sessionNode.created_actor_id,
            project_id: sessionNode.project_id,
            parent_session_key: sessionNode.parent_session_key,
            spawned_by: sessionNode.spawned_by,
            fork_source_session_key: sessionNode.fork_source_session_key,
            fork_source_session_id: sessionNode.fork_source_session_id,
            fork_source_entry_id: sessionNode.fork_source_entry_id,
            label: sessionNode.label,
            display_name: sessionNode.display_name,
            category: sessionNode.category,
            icon: sessionNode.icon,
            pinned_at: sessionNode.pinned_at,
            archived_at: sessionNode.archived_at,
            last_read_at: sessionNode.last_read_at,
            last_interaction_at: sessionNode.last_interaction_at,
            last_activity_at: sessionNode.last_activity_at,
            revision: eb("session_nodes.revision", "+", 1),
          })),
        ),
    );
    executeSqliteQuerySync(
      database.db,
      db
        .updateTable("session_nodes")
        .set((eb) => ({ entry_valid: 1, revision: eb("session_nodes.revision", "+", 1) }))
        .where("session_key", "=", sessionKey),
    );
  });
  executeSqliteQuerySync(
    database.db,
    db
      .insertInto("session_windows")
      .values(sessionRow)
      .onConflict((conflict) =>
        conflict.column("session_id").doUpdateSet({
          session_key: sessionKey,
          previous_session_id: sessionRow.previous_session_id,
          reason: sessionRow.reason,
          session_scope: sessionRow.session_scope,
          transcript_observed_at: transcriptObservedAt,
          session_entry_provenance: sessionRow.session_entry_provenance,
          acp_owned: sessionRow.acp_owned,
          plugin_owner_id: sessionRow.plugin_owner_id,
          hook_external_content_source: sessionRow.hook_external_content_source,
          updated_at: updatedAt,
          started_at: sessionRow.started_at,
          ended_at: sessionRow.ended_at,
          status: sessionRow.status,
          chat_type: sessionRow.chat_type,
          channel: sessionRow.channel,
          account_id: sessionRow.account_id,
          primary_conversation_id: sessionRow.primary_conversation_id,
          model_provider: sessionRow.model_provider,
          model: sessionRow.model,
          agent_harness_id: sessionRow.agent_harness_id,
          parent_session_key: sessionRow.parent_session_key,
          spawned_by: sessionRow.spawned_by,
          display_name: sessionRow.display_name,
        }),
      ),
  );
  if (conversation) {
    linkSessionConversation({
      database,
      sessionId: sessionRow.session_id,
      conversation,
      updatedAt,
    });
  }
  publishSessionEntryCacheInvalidation(database, sessionNode, writeGeneration);
}

/** Resolves the parent fork decision using SQLite transcript rows when totals are stale. */
