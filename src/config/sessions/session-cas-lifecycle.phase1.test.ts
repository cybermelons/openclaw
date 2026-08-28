// T-P1h (PHASE-1.md §4, CS-3b): entry-CAS "changed before"/"entries changed"
// throw sites owned by session-accessor.sqlite-lifecycle-state.ts that are
// structural exceptions to the revision-CAS conversion — both are documented
// "entry-CAS-snapshot-structural" (PHASE-1.md §4 escape hatch): their input
// snapshots do not carry a `session_nodes.revision` correlation, so both
// keep the legacy value-compare. Shape parity is satisfied by always
// throwing SessionConflictError instead of a bare Error. Both are exercised
// directly against the exported unit functions (not through the full
// cleanup-artifact orchestration, which needs unrelated marker/prefix
// fixtures).
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { cleanupTempDirs, makeTempDir } from "../../../test/helpers/temp-dir.js";
import {
  closeOpenClawAgentDatabasesForTest,
  openOpenClawAgentDatabase,
  runOpenClawAgentWriteTransaction,
} from "../../state/openclaw-agent-db.js";
import { closeOpenClawStateDatabaseForTest } from "../../state/openclaw-state-db.js";
import {
  applySessionEntryLifecycleMutation,
  loadSessionEntry,
  replaceTranscriptEvents,
  upsertSessionEntryCore,
} from "./session-accessor.js";
import { materializeSessionStateDeletePlans } from "./session-accessor.sqlite-archive.js";
import {
  assertPlannedLifecycleArtifactEntriesUnchanged,
  deleteMaterializedSessionStatePlans,
  planSessionStateDeleteIfUnreferenced,
} from "./session-accessor.sqlite-lifecycle-state.js";
import type { SessionEntryRemovalPlan } from "./session-accessor.sqlite-lifecycle-types.js";
import { touchTranscriptMutationInTransaction } from "./session-accessor.sqlite-transcript-state.js";
import { SessionConflictError } from "./session-conflict-error.js";
import { resolveSqliteTargetFromSessionStorePath } from "./session-sqlite-target.js";

const tempDirs: string[] = [];

function openLifecycleTestDatabase(storePath: string) {
  const target = resolveSqliteTargetFromSessionStorePath(storePath);
  if (!target.path) {
    throw new Error(`Could not resolve SQLite database path for ${storePath}`);
  }
  return openOpenClawAgentDatabase({ agentId: target.agentId ?? "main", path: target.path });
}

describe("session lifecycle-state entry-CAS-snapshot-structural (T-P1h)", () => {
  let tempDir: string;
  let storePath: string;

  beforeEach(() => {
    tempDir = makeTempDir(tempDirs, "openclaw-session-cas-lifecycle-");
    storePath = path.join(tempDir, "sessions.json");
  });

  afterEach(() => {
    closeOpenClawAgentDatabasesForTest();
    closeOpenClawStateDatabaseForTest();
    cleanupTempDirs(tempDirs);
  });

  it("deleteMaterializedSessionStatePlans throws SessionConflictError when the transcript changed after the snapshot", async () => {
    const sessionId = "structural-delete-snapshot-session";
    const sessionKey = "agent:main:structural-delete-snapshot";
    await replaceTranscriptEvents({ sessionId, sessionKey, storePath }, [
      { id: "seed-event", type: "message" },
    ]);
    const database = openLifecycleTestDatabase(storePath);
    const plan = planSessionStateDeleteIfUnreferenced({
      archiveDirectory: path.dirname(storePath),
      database,
      referencedSessionIds: new Set(),
      sessionId,
    });
    if (!plan) {
      throw new Error("expected an unreferenced SQLite transcript delete plan");
    }
    const materialized = await materializeSessionStateDeletePlans([plan]);

    // Land a competing transcript mutation after the snapshot was captured
    // — this is a session_windows/transcript_events-derived snapshot with
    // no session_nodes.revision correlation, so the recompare stays on
    // value-compare in both modes (structural exception).
    runOpenClawAgentWriteTransaction(
      (transactionDb) => {
        touchTranscriptMutationInTransaction(transactionDb, sessionId);
      },
      { agentId: database.agentId, path: database.path },
    );

    let conflict: SessionConflictError | undefined;
    try {
      runOpenClawAgentWriteTransaction(
        (transactionDb) =>
          deleteMaterializedSessionStatePlans(
            transactionDb,
            materialized,
            undefined,
            new Set([sessionKey]),
          ),
        { agentId: database.agentId, path: database.path },
      );
      expect.unreachable("expected deleteMaterializedSessionStatePlans to reject");
    } catch (err) {
      expect(err).toBeInstanceOf(SessionConflictError);
      conflict = err as SessionConflictError;
    }
    expect(conflict).toBeDefined();
    expect(conflict?.key).toBe(sessionId);
    expect(conflict?.retryable).toBe(true);
    // No session_nodes.revision correlation available for this snapshot
    // shape — sentinel -1s on both sides (documented escape hatch).
    expect(conflict?.expectedRevision).toBe(-1);
    expect(conflict?.actualRevision).toBe(-1);
  });

  it("assertPlannedLifecycleArtifactEntriesUnchanged throws SessionConflictError when the entry changed after planning", async () => {
    const sessionKey = "agent:main:structural-cleanup-entry";
    await upsertSessionEntryCore(
      { sessionKey, storePath },
      { sessionId: "structural-cleanup-session", updatedAt: 10 },
    );
    const plannedEntry = loadSessionEntry({ sessionKey, storePath });
    if (!plannedEntry) {
      throw new Error("expected the seeded entry to load");
    }
    const plan: SessionEntryRemovalPlan = { expectedEntry: plannedEntry, sessionKey };

    // Land a competing entry mutation after the removal plan captured its
    // expected entry — SessionEntryRemovalPlan is produced by three
    // independent bulk-read call sites, none of which currently carry
    // revision, so this stays on value-compare in both modes (documented
    // shared-3-producers exception).
    await applySessionEntryLifecycleMutation({
      skipMaintenance: true,
      storePath,
      upserts: [
        {
          entry: { sessionId: "structural-cleanup-session", updatedAt: 20, label: "changed" },
          sessionKey,
        },
      ],
    });

    const database = openLifecycleTestDatabase(storePath);
    let conflict: SessionConflictError | undefined;
    try {
      runOpenClawAgentWriteTransaction(
        (transactionDb) => assertPlannedLifecycleArtifactEntriesUnchanged(transactionDb, [plan]),
        { agentId: database.agentId, path: database.path },
      );
      expect.unreachable("expected assertPlannedLifecycleArtifactEntriesUnchanged to reject");
    } catch (err) {
      expect(err).toBeInstanceOf(SessionConflictError);
      conflict = err as SessionConflictError;
    }
    expect(conflict).toBeDefined();
    expect(conflict?.key).toBe(sessionKey);
    expect(conflict?.retryable).toBe(true);
    // expectedRevision has no correlation on this shared-producer plan
    // shape (sentinel -1); actualRevision reflects the real current row.
    expect(conflict?.expectedRevision).toBe(-1);
    expect(conflict?.actualRevision).toBeGreaterThanOrEqual(0);
  });
});
