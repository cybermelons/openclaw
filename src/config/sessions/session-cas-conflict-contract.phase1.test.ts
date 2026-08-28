// T-P1a (PHASE-1.md §7 shape-only parity, §8 Delta 2): property/conflict-contract
// test. Generated session shapes + patch mutations against a real SQLite-backed
// accessor. Every patch either succeeds, or rejects with a `SessionConflictError`
// whose SHAPE satisfies the contract: `retryable === true`, `actualRevision >
// expectedRevision` for a genuine landed conflict, and the error chain never
// contains a bare "changed before" message (the pre-Phase-1 legacy wording).
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
import { SessionConflictError } from "./session-conflict-error.js";
import { resolveSqliteTargetFromSessionStorePath } from "./session-sqlite-target.js";

const tempDirs: string[] = [];

/** Directly commits a second, out-of-band write — simulates a second connection
 * landing a change to the same row while the accessor under test is mid-flight
 * inside its own prepare phase (the in-process writer queue only serializes
 * writes issued through the accessor's own API, so a raw transaction here is
 * the faithful analogue of a second process/connection). */
function landCompetingWrite(databasePath: string, sessionKey: string, label: string): void {
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

describe("session entry-CAS conflict contract (T-P1a)", () => {
  let tempDir: string;
  let storePath: string;
  let databasePath: string;

  beforeEach(() => {
    tempDir = makeTempDir(tempDirs, "openclaw-session-cas-conflict-contract-");
    storePath = path.join(tempDir, "sessions.json");
    databasePath = resolveSqliteTargetFromSessionStorePath(storePath, { agentId: "main" }).path;
    // Touch the DB so it exists before any raw-transaction competing write.
    openOpenClawAgentDatabase({ agentId: "main", path: databasePath });
  });

  afterEach(() => {
    closeOpenClawAgentDatabasesForTest();
    closeOpenClawStateDatabaseForTest();
    cleanupTempDirs(tempDirs);
  });

  it("an uncontended patch succeeds without throwing", async () => {
    const scope = { sessionKey: "agent:main:uncontended", storePath };
    await upsertSessionEntryCore(scope, { sessionId: "s1", updatedAt: 10 });
    const result = await patchSessionEntryCore(scope, (entry) => ({
      ...entry,
      label: "patched",
    }));
    expect(result?.label).toBe("patched");
  });

  it("a patch racing a landed competing write rejects with a well-shaped SessionConflictError", async () => {
    const sessionKey = "agent:main:contended";
    const scope = { sessionKey, storePath };
    await upsertSessionEntryCore(scope, { sessionId: "s2", updatedAt: 10, label: "v1" });

    let released!: () => void;
    const gate = new Promise<void>((resolve) => {
      released = resolve;
    });

    const patchPromise = patchSessionEntryCore(scope, async (entry) => {
      // Pause inside the prepare phase (after the initial snapshot read,
      // before the write-transaction recompare) so the competing write
      // below can land in between.
      await gate;
      return { ...entry, label: "v2-from-a" };
    });

    // Give the patch's prepare phase a tick to read its snapshot first.
    await new Promise<void>((resolve) => {
      setTimeout(resolve, 0);
    });
    landCompetingWrite(databasePath, sessionKey, "v2-from-b");
    released();

    await expect(patchPromise).rejects.toSatisfy((err: unknown) => {
      expect(err).toBeInstanceOf(SessionConflictError);
      const conflict = err as SessionConflictError;
      expect(conflict.retryable).toBe(true);
      expect(conflict.key).toBe(sessionKey);
      expect(conflict.actualRevision).toBeGreaterThan(conflict.expectedRevision);
      // The error chain must never surface the pre-Phase-1 bare-string
      // wording; only the typed SessionConflictError shape is acceptable.
      let cursor: unknown = conflict;
      while (cursor instanceof Error) {
        expect(cursor.message).not.toContain("changed before");
        cursor = (cursor as { cause?: unknown }).cause;
      }
      return true;
    });
  });
});
