import { uniqueStrings } from "@openclaw/normalization-core/string-normalization";
import {
  executeSqliteQuerySync,
  executeSqliteQueryTakeFirstSync,
} from "../../infra/kysely-sync.js";
import { normalizeAgentId, parseAgentSessionKey } from "../../routing/session-key.js";
import {
  isIncognitoOpenClawAgentDatabase,
  type OpenClawAgentDatabase,
} from "../../state/openclaw-agent-db.js";
import { persistSessionTranscriptArchive } from "./session-accessor.sqlite-archive-store.js";
import type {
  MaterializedSessionStateDeletePlan,
  SessionStateDeletePlan,
} from "./session-accessor.sqlite-archive.js";
import { readExactSessionEntryRowForCanonicalRepair } from "./session-accessor.sqlite-canonical-repair.js";
import type {
  SessionEntryLifecycleRemoval,
  SessionEntryLifecycleUpsert,
  SessionLifecycleArchivedTranscript,
} from "./session-accessor.sqlite-contract.js";
import {
  readSessionStateDeleteSnapshot,
  sqliteSessionStateDeleteSnapshotsEqual,
} from "./session-accessor.sqlite-delete-snapshot.js";
import { sqliteSessionEntriesEqual } from "./session-accessor.sqlite-entry-equality.js";
import {
  deleteSessionEntryRows,
  readExactSessionEntryJsonForCanonicalRepair,
  readExactSessionEntryRow,
  readSessionEntryStore,
} from "./session-accessor.sqlite-entry-store.js";
import type {
  LifecycleArtifactCleanupPlan,
  ProjectedLifecycleMutation,
  SessionEntryRemovalPlan,
} from "./session-accessor.sqlite-lifecycle-types.js";
import { coerceSqliteNumber } from "./session-accessor.sqlite-normalize.js";
import { loadTranscriptEventsFromDatabase } from "./session-accessor.sqlite-read.js";
import { collectSessionStateIdsForEntry } from "./session-accessor.sqlite-references.js";
import { cloneSessionEntry, getSessionKysely } from "./session-accessor.sqlite-scope.js";
import { SessionConflictError } from "./session-conflict-error.js";
import { readSessionEntryOrNull } from "./session-entry-parse.js";
import { buildSessionResetBoundaryPlan } from "./session-reset-boundary-event.js";
import { deleteSessionTranscriptIndexInTransaction } from "./session-transcript-index.js";
import type { SessionEntry } from "./types.js";

// Transcript-state reclamation owner. Planning stays async-free; transactions revalidate before delete.

export function shouldRemoveSessionEntry(
  entry: SessionEntry | undefined,
  removal: SessionEntryLifecycleRemoval,
): entry is SessionEntry {
  if (!entry) {
    return false;
  }
  // sqliteSessionEntriesEqual, not raw JSON.stringify: plan-time (projectSessionEntry)
  // and commit-time (readCanonicalSqliteSessionEntryRow) reads intentionally differ on
  // participants/participantCount when empty (Phase 2 CS-4, §4); raw JSON would treat
  // that shape-only gap as a conflict and drop every removal.
  // Not converted to revision-compare (issue #81): every caller of
  // `shouldRemoveSessionEntry` already passed a `session_nodes.revision`
  // CAS check (`removal.expectedRevision` in sqlite-projection.ts) before
  // reaching here, so this call is a shape/value invariant on the
  // already-revision-matched entry, not a second concurrency guard.
  if (
    removal.expectedEntry !== undefined &&
    !sqliteSessionEntriesEqual(entry, removal.expectedEntry)
  ) {
    return false;
  }
  if (removal.expectedSessionId !== undefined && entry.sessionId !== removal.expectedSessionId) {
    return false;
  }
  if (
    removal.expectedLifecycleRevision !== undefined &&
    entry.lifecycleRevision !== removal.expectedLifecycleRevision
  ) {
    return false;
  }
  if (removal.expectedUpdatedAt !== undefined && entry.updatedAt !== removal.expectedUpdatedAt) {
    return false;
  }
  return true;
}

function sessionKeySegmentStartsWith(sessionKey: string, prefix: string): boolean {
  const firstSeparator = sessionKey.indexOf(":");
  if (firstSeparator < 0) {
    return sessionKey.startsWith(prefix);
  }
  const secondSeparator = sessionKey.indexOf(":", firstSeparator + 1);
  const sessionSegment = secondSeparator < 0 ? sessionKey : sessionKey.slice(secondSeparator + 1);
  return sessionSegment.startsWith(prefix);
}

function sessionKeyBelongsToAgent(sessionKey: string, agentId: string | undefined): boolean {
  if (agentId === undefined) {
    return true;
  }
  const parsed = parseAgentSessionKey(sessionKey);
  return parsed !== null && normalizeAgentId(parsed.agentId) === normalizeAgentId(agentId);
}

function readSessionTranscriptUpdatedAt(
  database: OpenClawAgentDatabase,
  sessionId: string,
): number | undefined {
  const db = getSessionKysely(database.db);
  const row = executeSqliteQueryTakeFirstSync(
    database.db,
    db
      .selectFrom("transcript_events")
      .select((eb) => eb.fn.max<number | bigint>("created_at").as("updated_at"))
      .where("session_id", "=", sessionId),
  );
  if (row?.updated_at === null || row?.updated_at === undefined) {
    return undefined;
  }
  return coerceSqliteNumber(row.updated_at);
}

function sqliteTranscriptStateIsReclaimable(params: {
  database: OpenClawAgentDatabase;
  sessionUpdatedAt?: number;
  sessionId: string;
  nowMs: number;
  orphanTranscriptMinAgeMs: number;
}): boolean {
  const transcriptUpdatedAt = readSessionTranscriptUpdatedAt(params.database, params.sessionId);
  const updatedAt =
    params.sessionUpdatedAt === undefined
      ? transcriptUpdatedAt
      : Math.max(params.sessionUpdatedAt, transcriptUpdatedAt ?? params.sessionUpdatedAt);
  return updatedAt === undefined || params.nowMs - updatedAt >= params.orphanTranscriptMinAgeMs;
}

function sqliteTranscriptStateHasMarker(params: {
  database: OpenClawAgentDatabase;
  sessionId: string;
  transcriptContentMarker: string;
}): boolean {
  const db = getSessionKysely(params.database.db);
  const rows = executeSqliteQuerySync(
    params.database.db,
    db
      .selectFrom("transcript_events")
      .select("event_json")
      .where("session_id", "=", params.sessionId)
      .orderBy("seq", "asc"),
  ).rows;
  return rows.some((row) => row.event_json.includes(params.transcriptContentMarker));
}

/** Session ids protected by live node state. */
export function readReferencedSessionIds(
  database: OpenClawAgentDatabase,
  excludedSessionKeys: ReadonlySet<string> = new Set(),
): Set<string> {
  const db = getSessionKysely(database.db);
  const rows = executeSqliteQuerySync(
    database.db,
    db.selectFrom("session_nodes").select(["entry_json", "current_session_id", "session_key"]),
  ).rows;
  const sessionIds = new Set<string>();
  for (const row of rows) {
    if (excludedSessionKeys.has(row.session_key)) {
      continue;
    }
    sessionIds.add(row.current_session_id);
    const entry = readSessionEntryOrNull(row.session_key, row);
    if (!entry) {
      continue;
    }
    for (const sessionId of collectSessionStateIdsForEntry(entry)) {
      sessionIds.add(sessionId);
    }
  }
  return sessionIds;
}

// Projects references after a lifecycle mutation so reset/delete can archive
// before removing entry rows while still preserving shared session ids.
export function readReferencedSessionIdsAfterTargetMutation(
  database: OpenClawAgentDatabase,
  target: { canonicalKey: string; storeKeys: string[] },
  nextEntry?: SessionEntry,
): Set<string> {
  const removedKeys = new Set(
    uniqueStrings([target.canonicalKey, ...target.storeKeys].map((key) => key.trim())),
  );
  const db = getSessionKysely(database.db);
  const rows = executeSqliteQuerySync(
    database.db,
    db.selectFrom("session_nodes").select(["entry_json", "session_key", "current_session_id"]),
  ).rows;
  const sessionIds = new Set<string>();
  for (const row of rows) {
    if (removedKeys.has(row.session_key)) {
      continue;
    }
    sessionIds.add(row.current_session_id);
    const entry = readSessionEntryOrNull(row.session_key, row);
    if (!entry) {
      continue;
    }
    for (const sessionId of collectSessionStateIdsForEntry(entry)) {
      sessionIds.add(sessionId);
    }
  }
  if (nextEntry) {
    for (const sessionId of collectSessionStateIdsForEntry(nextEntry)) {
      sessionIds.add(sessionId);
    }
  }
  return sessionIds;
}

export function planSessionStateDeleteIfUnreferenced(params: {
  archiveTranscript?: boolean;
  archiveDirectory: string;
  database: OpenClawAgentDatabase;
  reason?: "deleted" | "reset";
  referencedSessionIds: ReadonlySet<string>;
  sessionId: string;
}): SessionStateDeletePlan | null {
  if (params.referencedSessionIds.has(params.sessionId)) {
    return null;
  }
  return {
    agentId: params.database.agentId,
    archiveDirectory: params.archiveDirectory,
    archiveTranscript:
      params.archiveTranscript !== false && !isIncognitoOpenClawAgentDatabase(params.database),
    databasePath: params.database.path,
    reason: params.reason ?? "deleted",
    sessionId: params.sessionId,
    snapshot: readSessionStateDeleteSnapshot(params.database.db, params.sessionId),
  };
}

export function deleteMaterializedSessionStatePlans(
  database: OpenClawAgentDatabase,
  plans: readonly MaterializedSessionStateDeletePlan[],
  protectedSessionIds?: ReadonlySet<string>,
  excludedSessionKeys?: ReadonlySet<string>,
): SessionLifecycleArchivedTranscript[] {
  const archivedTranscripts: SessionLifecycleArchivedTranscript[] = [];
  const referencedSessionIds = readReferencedSessionIds(database, excludedSessionKeys);
  for (const sessionId of protectedSessionIds ?? []) {
    referencedSessionIds.add(sessionId);
  }
  for (const plan of plans) {
    if (referencedSessionIds.has(plan.sessionId)) {
      continue;
    }
    const currentSnapshot = readSessionStateDeleteSnapshot(database.db, plan.sessionId);
    // Entry-CAS-snapshot-structural (PHASE-1.md §4 escape hatch): this
    // snapshot spans multiple tables, not one session_nodes row, so it
    // carries no `revision` — value-compare only; shape parity
    // via always throwing SessionConflictError.
    if (!sqliteSessionStateDeleteSnapshotsEqual(currentSnapshot, plan.snapshot)) {
      throw new SessionConflictError({
        actualRevision: -1,
        expectedRevision: -1,
        key: plan.sessionId,
        message: `SQLite session state changed before deletion for ${plan.sessionId}`,
      });
    }
    if (plan.archive) {
      persistSessionTranscriptArchive(database, plan);
    }
    deleteSqliteSessionStateRows(database, plan.sessionId);
    if (plan.snapshot.lastSeq !== null && plan.archivedTranscript) {
      archivedTranscripts.push(plan.archivedTranscript);
    }
  }
  return archivedTranscripts;
}

// Builds delete plans from the session ids owned by an entry after callers
// have projected which ids remain referenced.
export function planSessionStateAfterEntryRemoval(params: {
  archiveDirectory: string;
  archiveTranscript?: boolean;
  database: OpenClawAgentDatabase;
  entry: SessionEntry;
  reason: "deleted" | "reset";
  referencedSessionIds?: ReadonlySet<string>;
}): SessionStateDeletePlan[] {
  const referencedSessionIds =
    params.referencedSessionIds ?? readReferencedSessionIds(params.database);
  const plans: SessionStateDeletePlan[] = [];
  for (const sessionId of collectSessionStateIdsForEntry(params.entry)) {
    const plan = planSessionStateDeleteIfUnreferenced({
      archiveTranscript: params.archiveTranscript,
      archiveDirectory: params.archiveDirectory,
      database: params.database,
      reason: params.reason,
      referencedSessionIds,
      sessionId,
    });
    if (plan) {
      plans.push(plan);
    }
  }
  return plans;
}

/** Ids of every persisted generation owned by the given logical session keys. */
export function readSessionGenerationIdsForKeys(
  database: OpenClawAgentDatabase,
  keys: Iterable<string>,
  options: { exactStoredKeys?: boolean } = {},
): string[] {
  const sessionKeys = uniqueStrings(
    [...keys].map((key) => (options.exactStoredKeys ? key : key.trim())),
  );
  if (sessionKeys.length === 0) {
    return [];
  }
  const db = getSessionKysely(database.db);
  return executeSqliteQuerySync(
    database.db,
    db.selectFrom("session_windows").select("session_id").where("session_key", "in", sessionKeys),
  ).rows.map((row) => row.session_id);
}

// Projects removals and upserts before archive materialization so same-call
// upserts can keep a transcript live without producing a spurious archive.
export async function projectSessionEntryLifecycleMutation(
  database: OpenClawAgentDatabase,
  params: {
    allowCanonicalRepair?: boolean;
    archiveDirectory: string;
    removals: readonly SessionEntryLifecycleRemoval[];
    upserts: readonly SessionEntryLifecycleUpsert[];
  },
): Promise<ProjectedLifecycleMutation> {
  const store = readSessionEntryStore(database, {
    allowCanonicalRepair: params.allowCanonicalRepair === true,
  });
  // Snapshot the DB-row revision for every key this mutation may touch, before
  // `store` is locally mutated below (removals delete keys, upserts overwrite
  // them). Revision lives on the row, not the in-memory projected entry, so it
  // must be read once here and threaded alongside `expectedEntry` for the
  // write-transaction recompare (PHASE-1.md §3).
  const revisionAtSnapshot = new Map<string, number>();
  for (const key of uniqueStrings([
    ...params.removals.map((removal) =>
      removal.exactStoredKey ? removal.sessionKey : removal.sessionKey.trim(),
    ),
    ...params.upserts.map((upsert) => upsert.sessionKey.trim()),
  ])) {
    if (!key) {
      continue;
    }
    const revision = (
      params.allowCanonicalRepair === true
        ? readExactSessionEntryRowForCanonicalRepair(database, key, {
            allowMalformedRowRepair: true,
          })
        : readExactSessionEntryRow(database, key)
    )?.row.revision;
    if (revision !== undefined) {
      revisionAtSnapshot.set(key, revision);
    }
  }
  const removedEntries: Array<{ archiveTranscript: boolean; entry: SessionEntry }> = [];
  const removedKeysToArchive = new Set<string>();
  const changedSessionKeys = new Set<string>();
  const projectedRemovals: ProjectedLifecycleMutation["removals"] = [];
  for (const removal of params.removals) {
    const sessionKey = removal.exactStoredKey ? removal.sessionKey : removal.sessionKey.trim();
    let entry = removal.exactStoredKey || sessionKey ? store[sessionKey] : undefined;
    if (removal.expectedRawEntryJson !== undefined) {
      const currentRawEntryJson = readExactSessionEntryJsonForCanonicalRepair(database, sessionKey);
      if (currentRawEntryJson !== removal.expectedRawEntryJson) {
        // Doctor-repair-only raw-JSON compare (see session-accessor.sqlite-projection.ts
        // readProjectedRemovalEntry for the identical justification): the caller's
        // snapshot is an unparseable raw blob with no correlated row revision at
        // capture time. Kept on raw-value compare, shape-parity only.
        throw new SessionConflictError({
          actualRevision: -1,
          expectedRevision: -1,
          key: sessionKey,
          message: `SQLite session entry changed before raw lifecycle removal for ${sessionKey}`,
        });
      }
      entry = removal.expectedEntry ? cloneSessionEntry(removal.expectedEntry) : undefined;
    }
    if (!shouldRemoveSessionEntry(entry, removal)) {
      continue;
    }
    if (removal.expectedTranscriptSnapshot) {
      const sessionId = entry.sessionId;
      if (
        !sessionId ||
        !sqliteSessionStateDeleteSnapshotsEqual(
          readSessionStateDeleteSnapshot(database.db, sessionId),
          removal.expectedTranscriptSnapshot,
        )
      ) {
        // Classification happens before the lifecycle writer lane. A stale fact
        // must become a no-op so newly live state is never archived and deleted.
        continue;
      }
    }
    projectedRemovals.push({
      expectedEntry: cloneSessionEntry(entry),
      // Raw-JSON-doctor-path removals are validated by the doctor-repair
      // JSON string compare above; the commit-phase re-read
      // (`readProjectedRemovalCurrentRevision`) always reports the sentinel
      // -1 for these, so the snapshot side must match that sentinel rather
      // than the row's real revision, or a legitimate repair removal
      // false-conflicts (0 !== -1) even though nothing raced it.
      expectedRevision:
        removal.expectedRawEntryJson !== undefined
          ? -1
          : (revisionAtSnapshot.get(sessionKey) ?? -1),
      removal,
      sessionKey,
    });
    removedEntries.push({
      archiveTranscript: removal.archiveRemovedTranscript === true,
      entry,
    });
    if (removal.archiveRemovedTranscript === true) {
      removedKeysToArchive.add(sessionKey);
    }
    changedSessionKeys.add(sessionKey);
    delete store[sessionKey];
  }
  // Session keys with a raw-JSON-doctor-path removal targeting them (see the
  // `expectedRevision` comment below): needed so a same-key upsert (rewriting
  // a malformed row in place) also compares against the commit-phase sentinel
  // instead of the row's real revision.
  const rawEntryJsonRemovalKeys = new Set(
    params.removals
      .filter((removal) => removal.expectedRawEntryJson !== undefined)
      .map((removal) => (removal.exactStoredKey ? removal.sessionKey : removal.sessionKey.trim())),
  );
  const upsertedEntries: ProjectedLifecycleMutation["upsertedEntries"] = [];
  for (const upsert of params.upserts) {
    const sessionKey = upsert.sessionKey.trim();
    if (!sessionKey) {
      continue;
    }
    const expectedEntry = store[sessionKey] ? cloneSessionEntry(store[sessionKey]) : undefined;
    if (upsert.resetBoundaryReason && !expectedEntry) {
      throw new Error(
        `Cannot append reset boundary without an existing session row: ${sessionKey}`,
      );
    }
    const entry =
      upsert.buildEntry === undefined
        ? upsert.entry
        : await upsert.buildEntry({
            currentEntry: expectedEntry ? cloneSessionEntry(expectedEntry) : undefined,
            sessionKey,
            store,
          });
    if (!entry) {
      continue;
    }
    const cloned = cloneSessionEntry(entry);
    store[sessionKey] = cloned;
    changedSessionKeys.add(sessionKey);
    const resetBoundaryPlan =
      upsert.resetBoundaryReason && expectedEntry?.sessionId
        ? await buildSessionResetBoundaryPlan({
            events: loadTranscriptEventsFromDatabase(database, expectedEntry.sessionId),
            reason: upsert.resetBoundaryReason,
          })
        : undefined;
    upsertedEntries.push({
      expectedEntry,
      // Same-key raw-JSON-doctor-path rewrite (removal + upsert target the
      // same malformed row): the commit-phase compare treats this upsert as
      // the paired removal's `sameKeyRemoval` and re-reads its current
      // revision via the removal's sentinel path (always -1 for raw-JSON),
      // so this upsert's expected value must match that same sentinel.
      expectedRevision: rawEntryJsonRemovalKeys.has(sessionKey)
        ? -1
        : (revisionAtSnapshot.get(sessionKey) ?? -1),
      sessionKey,
      entry: cloned,
      ...(resetBoundaryPlan ? { resetBoundaryPlan } : {}),
    });
  }
  const referencedSessionIds = collectProjectedReferencedSessionIds({
    database,
    excludedSessionKeys: changedSessionKeys,
    projectedStore: store,
  });
  const deletePlans = removedEntries.flatMap(({ archiveTranscript, entry }) =>
    planSessionStateAfterEntryRemoval({
      archiveDirectory: params.archiveDirectory,
      archiveTranscript,
      database,
      entry,
      reason: "deleted",
      referencedSessionIds,
    }),
  );
  const observedSnapshotsBySessionId = new Map(
    projectedRemovals.flatMap(({ expectedEntry, removal }) =>
      expectedEntry.sessionId && removal.expectedTranscriptSnapshot
        ? [[expectedEntry.sessionId, removal.expectedTranscriptSnapshot] as const]
        : [],
    ),
  );
  for (const plan of deletePlans) {
    const observedSnapshot = observedSnapshotsBySessionId.get(plan.sessionId);
    if (observedSnapshot) {
      // Keep the delete plan bound to classification, even if another process
      // changes the transcript after the initial projection comparison.
      plan.snapshot = observedSnapshot;
    }
  }
  const plannedIds = new Set(deletePlans.map((plan) => plan.sessionId));
  for (const sessionId of readSessionGenerationIdsForKeys(database, removedKeysToArchive)) {
    if (plannedIds.has(sessionId)) {
      continue;
    }
    const plan = planSessionStateDeleteIfUnreferenced({
      archiveDirectory: params.archiveDirectory,
      archiveTranscript: true,
      database,
      reason: "deleted",
      referencedSessionIds,
      sessionId,
    });
    if (plan) {
      deletePlans.push(plan);
      plannedIds.add(sessionId);
    }
  }
  return { deletePlans, removals: projectedRemovals, upsertedEntries };
}

// Builds the post-removal reference set from an in-memory projected store.
function collectReferencedSqliteSessionIdsFromStore(
  store: Record<string, SessionEntry>,
): Set<string> {
  const sessionIds = new Set<string>();
  for (const entry of Object.values(store)) {
    for (const sessionId of collectSessionStateIdsForEntry(entry)) {
      sessionIds.add(sessionId);
    }
  }
  return sessionIds;
}

// Projected deletes must preserve raw session_nodes.current_session_id references for
// remaining rows whose entry_json cannot be parsed into a SessionEntry.
export function collectProjectedReferencedSessionIds(params: {
  database: OpenClawAgentDatabase;
  excludedSessionKeys: Iterable<string>;
  projectedStore: Record<string, SessionEntry>;
}): Set<string> {
  const excludedSessionKeys = new Set(params.excludedSessionKeys);
  const db = getSessionKysely(params.database.db);
  const rows = executeSqliteQuerySync(
    params.database.db,
    db.selectFrom("session_nodes").select(["entry_json", "session_key", "current_session_id"]),
  ).rows;
  const sessionIds = new Set<string>();
  for (const row of rows) {
    if (excludedSessionKeys.has(row.session_key)) {
      continue;
    }
    sessionIds.add(row.current_session_id);
    const entry = readSessionEntryOrNull(row.session_key, row);
    if (!entry) {
      continue;
    }
    for (const sessionId of collectSessionStateIdsForEntry(entry)) {
      sessionIds.add(sessionId);
    }
  }
  for (const sessionId of collectReferencedSqliteSessionIdsFromStore(params.projectedStore)) {
    sessionIds.add(sessionId);
  }
  return sessionIds;
}

export { collectSessionStateIdsForEntry };

function deleteSqliteSessionStateRows(database: OpenClawAgentDatabase, sessionId: string): void {
  const db = getSessionKysely(database.db);
  // The window row cascades canonical transcript tables, but FTS is virtual;
  // clear its projection before dropping the owner row.
  deleteSessionTranscriptIndexInTransaction(database.db, sessionId);
  executeSqliteQuerySync(
    database.db,
    db.deleteFrom("session_windows").where("session_id", "=", sessionId),
  );
}

// Plans orphan cleanup without file writes or row deletion; finalization
// handles archive durability before removing rows.
// Exported for direct testing (Phase 3 §8c blob-reverify pin) — the full
// planSessionLifecycleArtifactCleanup pipeline requires wiring reclaimability/
// marker gates that are orthogonal to what this pin proves.
export function planSqliteOrphanLifecycleTranscriptStateDeletes(params: {
  agentId?: string;
  archiveRemovedEntryTranscripts: boolean;
  archiveDirectory: string;
  database: OpenClawAgentDatabase;
  excludedSessionIds?: ReadonlySet<string>;
  pluginOwnerId?: string;
  referencedSessionIds: ReadonlySet<string>;
  transcriptContentMarker: string;
  orphanTranscriptMinAgeMs: number;
  nowMs: number;
}): SessionStateDeletePlan[] {
  const db = getSessionKysely(params.database.db);
  const rows = executeSqliteQuerySync(
    params.database.db,
    db
      .selectFrom("session_windows")
      .select(["session_id", "session_key", "plugin_owner_id"])
      .orderBy("session_id", "asc"),
  ).rows;

  const deletePlans: SessionStateDeletePlan[] = [];
  // Orphan transcript state is represented by a historical window that is no
  // longer the node's current id. The marker scopes cleanup to this lifecycle.
  for (const row of rows) {
    if (
      !sessionKeyBelongsToAgent(row.session_key, params.agentId) ||
      params.referencedSessionIds.has(row.session_id) ||
      params.excludedSessionIds?.has(row.session_id)
    ) {
      continue;
    }
    // §8c: `plugin_owner_id` is a projected column that can diverge from the
    // owning node's blob. A column-only mismatch must not gate this delete —
    // re-verify against the owning session_nodes row's blob `pluginOwnerId`
    // (mirrors planSessionLifecycleArtifactCleanup below, which re-checks
    // `entry?.pluginOwnerId` rather than trusting a projected column).
    if (params.pluginOwnerId && row.plugin_owner_id) {
      const ownerNodeRow = executeSqliteQueryTakeFirstSync(
        params.database.db,
        db
          .selectFrom("session_nodes")
          .select(["entry_json", "session_key", "current_session_id", "updated_at"])
          .where("session_key", "=", row.session_key),
      );
      // EXCEPTION: if the owning node row is absent or its blob is unparseable/
      // corrupt, this is a true orphan with no usable blob to re-verify against —
      // the column is the only signal available, so fall back to the column check.
      const ownerEntry = ownerNodeRow
        ? readSessionEntryOrNull(ownerNodeRow.session_key, ownerNodeRow)
        : undefined;
      if (ownerEntry) {
        if (ownerEntry.pluginOwnerId && ownerEntry.pluginOwnerId !== params.pluginOwnerId) {
          continue;
        }
      } else if (row.plugin_owner_id !== params.pluginOwnerId) {
        continue;
      }
    }
    if (
      !sqliteTranscriptStateIsReclaimable({
        database: params.database,
        sessionId: row.session_id,
        nowMs: params.nowMs,
        orphanTranscriptMinAgeMs: params.orphanTranscriptMinAgeMs,
      }) ||
      !sqliteTranscriptStateHasMarker({
        database: params.database,
        sessionId: row.session_id,
        transcriptContentMarker: params.transcriptContentMarker,
      })
    ) {
      continue;
    }
    const plan = planSessionStateDeleteIfUnreferenced({
      archiveTranscript: params.archiveRemovedEntryTranscripts,
      archiveDirectory: params.archiveDirectory,
      database: params.database,
      reason: "deleted",
      referencedSessionIds: params.referencedSessionIds,
      sessionId: row.session_id,
    });
    if (plan) {
      deletePlans.push(plan);
    }
  }
  return deletePlans;
}

export function planSessionLifecycleArtifactCleanup(
  database: OpenClawAgentDatabase,
  params: {
    agentId?: string;
    archiveRemovedEntryTranscripts: boolean;
    archiveDirectory: string;
    pluginOwnerId?: string;
    sessionKeySegmentPrefix: string;
    transcriptContentMarker: string;
    orphanTranscriptMinAgeMs: number;
    nowMs: number;
  },
): LifecycleArtifactCleanupPlan {
  const db = getSessionKysely(database.db);
  const rows = executeSqliteQuerySync(
    database.db,
    db
      .selectFrom("session_nodes")
      .select(["entry_json", "session_key", "current_session_id", "updated_at"])
      .orderBy("session_key", "asc"),
  ).rows;

  const removedSessionIds = new Set<string>();
  const entries: LifecycleArtifactCleanupPlan["entries"] = [];
  const projectedStore = readSessionEntryStore(database);
  const foreignOwnedSessionIds = params.pluginOwnerId
    ? new Set(
        executeSqliteQuerySync(
          database.db,
          db
            .selectFrom("session_windows")
            .select("session_id")
            .where("plugin_owner_id", "is not", null)
            .where("plugin_owner_id", "!=", params.pluginOwnerId),
        ).rows.map((row) => row.session_id),
      )
    : undefined;
  for (const row of rows) {
    if (
      !sessionKeyBelongsToAgent(row.session_key, params.agentId) ||
      !sessionKeySegmentStartsWith(row.session_key, params.sessionKeySegmentPrefix)
    ) {
      continue;
    }
    const entry = readSessionEntryOrNull(row.session_key, row);
    const sessionIds = uniqueStrings([
      row.current_session_id,
      ...(entry ? collectSessionStateIdsForEntry(entry) : []),
    ]);
    // Window ownership survives placeholder nodes and ownerless row projections; preserve
    // the entire node when any referenced generation belongs to another plugin.
    if (
      (params.pluginOwnerId &&
        entry?.pluginOwnerId &&
        entry.pluginOwnerId !== params.pluginOwnerId) ||
      sessionIds.some((sessionId) => foreignOwnedSessionIds?.has(sessionId))
    ) {
      continue;
    }
    if (
      !sqliteTranscriptStateIsReclaimable({
        database,
        // Admission updates the node even when a run has no event yet or reuses old events.
        sessionUpdatedAt: coerceSqliteNumber(row.updated_at),
        sessionId: row.current_session_id,
        nowMs: params.nowMs,
        orphanTranscriptMinAgeMs: params.orphanTranscriptMinAgeMs,
      })
    ) {
      continue;
    }
    for (const sessionId of sessionIds) {
      removedSessionIds.add(sessionId);
    }
    entries.push({
      expectedEntry: entry ? cloneSessionEntry(entry) : undefined,
      sessionKey: row.session_key,
    });
    delete projectedStore[row.session_key];
  }

  const referencedSessionIds = collectProjectedReferencedSessionIds({
    database,
    excludedSessionKeys: entries.map((entry) => entry.sessionKey),
    projectedStore,
  });
  const deletePlans: SessionStateDeletePlan[] = [];
  for (const sessionId of removedSessionIds) {
    const plan = planSessionStateDeleteIfUnreferenced({
      archiveTranscript: params.archiveRemovedEntryTranscripts,
      archiveDirectory: params.archiveDirectory,
      database,
      referencedSessionIds,
      sessionId,
    });
    if (plan) {
      deletePlans.push(plan);
    }
  }
  deletePlans.push(
    ...planSqliteOrphanLifecycleTranscriptStateDeletes({
      ...(params.agentId ? { agentId: params.agentId } : {}),
      archiveRemovedEntryTranscripts: params.archiveRemovedEntryTranscripts,
      archiveDirectory: params.archiveDirectory,
      database,
      excludedSessionIds: removedSessionIds,
      ...(params.pluginOwnerId ? { pluginOwnerId: params.pluginOwnerId } : {}),
      referencedSessionIds,
      transcriptContentMarker: params.transcriptContentMarker,
      orphanTranscriptMinAgeMs: params.orphanTranscriptMinAgeMs,
      nowMs: params.nowMs,
    }),
  );
  return { deletePlans, entries };
}

export function deletePlannedLifecycleArtifactEntries(
  database: OpenClawAgentDatabase,
  entries: readonly SessionEntryRemovalPlan[],
): number {
  assertPlannedLifecycleArtifactEntriesUnchanged(database, entries);
  let removedEntries = 0;
  for (const planned of entries) {
    deleteSessionEntryRows(database, planned.sessionKey);
    removedEntries += 1;
  }
  return removedEntries;
}

export function assertPlannedLifecycleArtifactEntriesUnchanged(
  database: OpenClawAgentDatabase,
  entries: readonly SessionEntryRemovalPlan[],
): void {
  // Entry-CAS-snapshot-structural (PHASE-1.md §4 escape hatch): `entries`
  // is produced by 3 independent bulk-read call sites, none of which
  // select `revision` — value-compare only; shape parity via
  // always throwing SessionConflictError. Revisited for issue #81: adding
  // `revision` to those 3 selects would touch `readSessionEntryStore`'s
  // shared `Record<string, SessionEntry>` return type across every one of
  // its many unrelated callers — out of scope for a revision-thread-only
  // change; this stays a documented structural exception.
  for (const planned of entries) {
    const currentRow = readExactSessionEntryRow(database, planned.sessionKey);
    if (!sqliteSessionEntriesEqual(currentRow?.entry, planned.expectedEntry)) {
      throw new SessionConflictError({
        actualRevision: currentRow?.row.revision ?? -1,
        expectedRevision: -1,
        key: planned.sessionKey,
        message: `SQLite lifecycle cleanup entry changed for ${planned.sessionKey}`,
      });
    }
  }
}
