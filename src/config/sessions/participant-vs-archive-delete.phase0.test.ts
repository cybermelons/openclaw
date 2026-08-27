// Phase-0 characterization test: participant write vs archive/delete interleave.
// recordSessionParticipantBestEffort defers via queueMicrotask and swallows errors,
// with no concurrency control against a concurrent archive or delete of the same
// session. This pins the OBSERVED outcome on main for each interleave.
import { describe, expect, it } from "vitest";
import { useTempSqliteSessionStore } from "./phase0-fixtures.test-support.js";
import {
  deleteSessionEntryLifecycle,
  listSessionParticipantsReadOnly,
  loadSessionEntry,
  recordSessionParticipant,
  upsertSessionEntryCore,
} from "./session-accessor.js";

describe("phase0: participant write vs archive/delete", () => {
  const store = useTempSqliteSessionStore();

  it("a participant write after archiving the session still succeeds and the row survives", async () => {
    const sessionKey = "agent:main:participant-vs-archive";
    const scope = { agentId: store.agentId, sessionKey, storePath: store.databasePath() };

    await upsertSessionEntryCore(scope, {
      sessionId: "session-archive-race",
      updatedAt: 1,
      createdActor: { type: "human", id: "owner" },
    });

    // Archive the session (write archivedAt directly, matching how archive is
    // actually applied to the store entry).
    await upsertSessionEntryCore(scope, { archivedAt: Date.now() });
    expect(loadSessionEntry(scope)?.archivedAt).toEqual(expect.any(Number));

    // Now record a participant against the now-archived session using the
    // underlying non-deferred function for deterministic ordering.
    const result = recordSessionParticipant(scope, {
      actor: { type: "human", id: "late-writer" },
      promptedAt: Date.now(),
      sessionAgentId: store.agentId,
      source: "profile",
    });

    // PINNED-BUG: #18 Phase 5. recordSessionParticipant has no guard against
    // writing to an archived session; the write silently succeeds ("inserted")
    // and the participant row is persisted against the archived entry.
    expect(result).toBe("inserted");
    expect(
      listSessionParticipantsReadOnly(scope)
        .get(sessionKey)
        ?.some((record) => record.actor.id === "late-writer"),
    ).toBe(true);
    expect(loadSessionEntry(scope)?.archivedAt).toEqual(expect.any(Number));
  });

  it("a participant write racing a session delete either lands before the delete cascades it away, or lands after and is orphaned with no error", async () => {
    const sessionKey = "agent:main:participant-vs-delete";
    const scope = { agentId: store.agentId, sessionKey, storePath: store.databasePath() };

    await upsertSessionEntryCore(scope, {
      sessionId: "session-delete-race",
      updatedAt: 1,
      createdActor: { type: "human", id: "owner" },
    });

    // Write a participant first (simulating the write landing before delete).
    const beforeDeleteResult = recordSessionParticipant(scope, {
      actor: { type: "human", id: "pre-delete-writer" },
      promptedAt: Date.now(),
      sessionAgentId: store.agentId,
      source: "profile",
    });
    expect(beforeDeleteResult).toBe("inserted");
    expect(
      listSessionParticipantsReadOnly(scope)
        .get(sessionKey)
        ?.some((record) => record.actor.id === "pre-delete-writer"),
    ).toBe(true);

    // Delete the session entry (cascades transcript + participant rows).
    const deleteResult = await deleteSessionEntryLifecycle({
      agentId: store.agentId,
      storePath: store.databasePath(),
      target: { canonicalKey: sessionKey, storeKeys: [sessionKey] },
      archiveTranscript: false,
    });
    expect(deleteResult.deleted).toBe(true);

    // PINNED-BUG: #18 Phase 5. Participant rows for a deleted session are
    // cascade-deleted with the session_nodes row (ON DELETE CASCADE), so a
    // write that landed before the delete does NOT survive it. This is the
    // safe half of the picture; the unsafe half is the next assertion below:
    // a participant write attempted AFTER delete has no session row to guard
    // against and is free to insert a fresh orphaned session_participants
    // row with no corresponding session_nodes row, since recordSessionParticipant
    // performs no existence check on the target session.
    expect(listSessionParticipantsReadOnly(scope).get(sessionKey)).toBeUndefined();

    const afterDeleteResult = recordSessionParticipant(scope, {
      actor: { type: "human", id: "post-delete-writer" },
      promptedAt: Date.now(),
      sessionAgentId: store.agentId,
      source: "profile",
    });

    // PINNED-BUG: #18 Phase 5. recordSessionParticipant has no guard requiring
    // the target session row to still exist; it inserts an orphaned
    // session_participants row for a session that was already deleted, and
    // reports success rather than an error.
    expect(afterDeleteResult).toBe("inserted");
    expect(
      listSessionParticipantsReadOnly(scope)
        .get(sessionKey)
        ?.some((record) => record.actor.id === "post-delete-writer"),
    ).toBe(true);
    // The session entry itself remains gone; only the participant row is orphaned.
    expect(loadSessionEntry(scope)).toBeUndefined();
  });
});
