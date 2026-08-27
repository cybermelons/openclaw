// T-P1b (PHASE-1.md §3, §5, §8 Delta 2): concurrency test against one real
// SQLite file. Connection "A" reads (captures its snapshot/expectedRevision
// implicitly via the accessor), connection "B" lands a participant write AND
// an entry patch interleaved while A is mid-flight, then A patches against its
// now-stale snapshot.
//
// Asserts:
//   (i)   A fails with SessionConflictError when B's entry patch intervened.
//   (ii)  A participant-only interleave does NOT conflict A — i.e.
//         `recordSessionParticipant` never bumps `session_nodes.revision`.
//   (iii) `withSessionRetry(A.patch, 3)` then succeeds.
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { cleanupTempDirs, makeTempDir } from "../../../test/helpers/temp-dir.js";
import {
  closeOpenClawAgentDatabasesForTest,
  openOpenClawAgentDatabase,
  runOpenClawAgentWriteTransaction,
} from "../../state/openclaw-agent-db.js";
import { closeOpenClawStateDatabaseForTest } from "../../state/openclaw-state-db.js";
import { patchSessionEntryCore, upsertSessionEntryCore } from "./session-accessor.js";
import { writeSessionEntry } from "./session-accessor.sqlite-entry-store.js";
import { recordSessionParticipant } from "./session-accessor.sqlite-participants.js";
import { SessionConflictError } from "./session-conflict-error.js";
import { resolveSqliteTargetFromSessionStorePath } from "./session-sqlite-target.js";
import { withSessionRetry } from "./with-session-retry.js";

const tempDirs: string[] = [];

function readRevision(databasePath: string, sessionKey: string): number | undefined {
  const database = openOpenClawAgentDatabase({ agentId: "main", path: databasePath });
  const row = database.db
    .prepare("SELECT revision FROM session_nodes WHERE session_key = ?")
    .get(sessionKey) as { revision: number } | undefined;
  return row?.revision;
}

/** Directly commits a second, out-of-band write — simulates a second connection
 * ("B") landing an entry patch on the same row while "A" is mid-flight inside
 * its own prepare phase. The in-process writer queue only serializes writes
 * issued through the accessor's own patch/upsert API on the SAME event-loop
 * turn sequence; a raw transaction here is the faithful analogue of a second
 * process/connection racing the same SQLite file (matching this file's real
 * "two connections, one DB file" framing without deadlocking A's held lane). */
function landCompetingEntryWrite(databasePath: string, sessionKey: string, label: string): void {
  runOpenClawAgentWriteTransaction(
    (database) => {
      const existing = database.db
        .prepare("SELECT entry_json FROM session_nodes WHERE session_key = ?")
        .get(sessionKey) as { entry_json: string } | undefined;
      const entry = existing
        ? { ...JSON.parse(existing.entry_json), label }
        : { sessionId: `${sessionKey}-competing`, updatedAt: Date.now(), label };
      writeSessionEntry(database, sessionKey, entry);
    },
    { agentId: "main", path: databasePath },
  );
}

describe("session entry-CAS concurrency (T-P1b)", () => {
  let tempDir: string;
  let storePath: string;
  let databasePath: string;
  let sessionKey: string;

  beforeEach(async () => {
    tempDir = makeTempDir(tempDirs, "openclaw-session-cas-concurrency-");
    storePath = path.join(tempDir, "sessions.json");
    databasePath = resolveSqliteTargetFromSessionStorePath(storePath, { agentId: "main" }).path;
    sessionKey = "agent:main:concurrency-target";
    await upsertSessionEntryCore(
      { sessionKey, storePath },
      { sessionId: "concurrency-session", updatedAt: 10, label: "v0" },
    );
  });

  afterEach(() => {
    closeOpenClawAgentDatabasesForTest();
    closeOpenClawStateDatabaseForTest();
    cleanupTempDirs(tempDirs);
  });

  it("(ii) a participant-only interleave from B does not conflict A's patch", async () => {
    const scope = { sessionKey, storePath };
    let released!: () => void;
    const gate = new Promise<void>((resolve) => {
      released = resolve;
    });

    const patchA = patchSessionEntryCore(scope, async (entry) => {
      await gate;
      return { ...entry, label: "v1-from-a" };
    });

    await new Promise<void>((resolve) => {
      setTimeout(resolve, 0);
    });
    const before = readRevision(databasePath, sessionKey);
    // B: participant-only write, must never touch session_nodes.revision.
    recordSessionParticipant(scope, {
      actor: { type: "human", id: "human-b" },
      source: "channel",
    });
    const afterParticipantWrite = readRevision(databasePath, sessionKey);
    expect(afterParticipantWrite).toBe(before);
    released();

    const result = await patchA;
    expect(result?.label).toBe("v1-from-a");
  });

  it("(i) an entry-patch interleave from B conflicts A's patch, and (iii) withSessionRetry then succeeds", async () => {
    const scope = { sessionKey, storePath };

    let released!: () => void;
    const gate = new Promise<void>((resolve) => {
      released = resolve;
    });

    const patchA = patchSessionEntryCore(scope, async (entry) => {
      await gate;
      return { ...entry, label: "v1-from-a" };
    });

    await new Promise<void>((resolve) => {
      setTimeout(resolve, 0);
    });
    // B: a raw out-of-band write lands directly on the row while A is
    // paused inside its own prepare phase, holding the writer-queue lane —
    // routing B through the accessor's own patch API here would simply
    // queue B behind A and deadlock, since A's `update` callback (awaiting
    // `gate`) has not yet released the lane.
    landCompetingEntryWrite(databasePath, sessionKey, "v1-from-b");
    released();

    let conflict: SessionConflictError | undefined;
    try {
      await patchA;
      expect.unreachable("expected patchA to reject with SessionConflictError");
    } catch (err) {
      expect(err).toBeInstanceOf(SessionConflictError);
      conflict = err as SessionConflictError;
      expect(conflict.retryable).toBe(true);
      expect(conflict.key).toBe(sessionKey);
      expect(conflict.actualRevision).toBeGreaterThan(conflict.expectedRevision);
    }
    expect(conflict).toBeDefined();

    // (iii) withSessionRetry re-reads fresh state each attempt via a fully
    // self-contained fn, so it converges past the now-resolved conflict.
    const retried = await withSessionRetry(
      async () =>
        await patchSessionEntryCore(scope, (entry) => ({
          ...entry,
          label: "v2-from-a-retry",
        })),
      3,
    );
    expect(retried?.label).toBe("v2-from-a-retry");
  });
});
