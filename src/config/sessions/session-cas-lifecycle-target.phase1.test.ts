// Issue #81: `assertLifecycleTargetUnchanged` (session-accessor.sqlite-entry-store.ts)
// used to value-compare `expectedEntry` via `sqliteSessionEntriesEqual` even
// though its only caller, `resetSessionEntryLifecycle`, already resolves a
// `{ entry, key, revision }` primary snapshot (`readLifecycleTargetSnapshot`)
// right before calling it. It now takes that snapshot directly and does an
// integer `session_nodes.revision` compare, matching the
// `assertLifecycleTargetSnapshotUnchanged` pattern next to it. This proves
// the conflict path still fires (via `SessionConflictError`, not a bare
// `Error`) when a competing write lands the row's revision forward between
// the reset's read and its commit.
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { cleanupTempDirs, makeTempDir } from "../../../test/helpers/temp-dir.js";
import {
  closeOpenClawAgentDatabasesForTest,
  runOpenClawAgentWriteTransaction,
} from "../../state/openclaw-agent-db.js";
import { closeOpenClawStateDatabaseForTest } from "../../state/openclaw-state-db.js";
import { resetSessionEntryLifecycle, upsertSessionEntryCore } from "./session-accessor.js";
import { writeSessionEntry } from "./session-accessor.sqlite-entry-store.js";
import { SessionConflictError } from "./session-conflict-error.js";
import { resolveSqliteTargetFromSessionStorePath } from "./session-sqlite-target.js";

const tempDirs: string[] = [];

/** Directly commits a second, out-of-band write on the same row — the same
 * "second connection races the same SQLite file" technique used in
 * session-cas-concurrency.phase1.test.ts, landed while the reset's
 * `buildNextEntry` callback is paused mid-flight. */
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

describe("resetSessionEntryLifecycle target revision-CAS (issue #81)", () => {
  let tempDir: string;
  let storePath: string;
  let databasePath: string;
  let sessionKey: string;

  beforeEach(async () => {
    tempDir = makeTempDir(tempDirs, "openclaw-session-cas-lifecycle-target-");
    storePath = path.join(tempDir, "sessions.json");
    databasePath = resolveSqliteTargetFromSessionStorePath(storePath, { agentId: "main" }).path;
    sessionKey = "agent:main:reset-cas-target";
    await upsertSessionEntryCore(
      { sessionKey, storePath },
      { sessionId: "reset-cas-session", updatedAt: 10, label: "v0" },
    );
  });

  afterEach(() => {
    closeOpenClawAgentDatabasesForTest();
    closeOpenClawStateDatabaseForTest();
    cleanupTempDirs(tempDirs);
  });

  it("rejects with SessionConflictError when a competing write lands between the read and the reset commit", async () => {
    const target = { canonicalKey: sessionKey, storeKeys: [sessionKey] };
    let released!: () => void;
    const gate = new Promise<void>((resolve) => {
      released = resolve;
    });

    const reset = resetSessionEntryLifecycle({
      buildNextEntry: async (context) => {
        await gate;
        return { ...context.currentEntry, sessionId: "reset-cas-session", updatedAt: 30 };
      },
      storePath,
      target,
    });

    await new Promise<void>((resolve) => {
      setTimeout(resolve, 0);
    });
    // B: a raw out-of-band write bumps session_nodes.revision on the target
    // row while the reset is paused inside buildNextEntry, still holding the
    // writer-queue lane (same rationale as session-cas-concurrency.phase1.test.ts).
    landCompetingEntryWrite(databasePath, sessionKey, "v1-from-b");
    released();

    let conflict: SessionConflictError | undefined;
    try {
      await reset;
      expect.unreachable("expected resetSessionEntryLifecycle to reject with SessionConflictError");
    } catch (err) {
      expect(err).toBeInstanceOf(SessionConflictError);
      conflict = err as SessionConflictError;
    }
    expect(conflict).toBeDefined();
    expect(conflict?.retryable).toBe(true);
    expect(conflict?.key).toBe(sessionKey);
    // Integer revision compare, not a value/JSON compare: B's write bumped
    // the row's revision forward, so actual strictly exceeds expected.
    expect(conflict?.actualRevision).toBeGreaterThan(conflict?.expectedRevision ?? -1);
  });

  it("succeeds and bumps revision when no competing write lands", async () => {
    const target = { canonicalKey: sessionKey, storeKeys: [sessionKey] };
    const result = await resetSessionEntryLifecycle({
      buildNextEntry: (context) => ({
        ...context.currentEntry,
        sessionId: "reset-cas-session",
        updatedAt: 40,
      }),
      storePath,
      target,
    });
    expect(result.nextEntry.updatedAt).toBe(40);
    expect(result.previousEntry?.label).toBe("v0");
  });

  it("succeeds on a fresh target with no prior row (both sides sentinel -1)", async () => {
    const freshKey = "agent:main:reset-cas-fresh";
    const target = { canonicalKey: freshKey, storeKeys: [freshKey] };
    const result = await resetSessionEntryLifecycle({
      buildNextEntry: () => ({ sessionId: "reset-cas-fresh-session", updatedAt: 50 }),
      storePath,
      target,
    });
    expect(result.nextEntry.updatedAt).toBe(50);
    expect(result.previousEntry).toBeUndefined();
  });
});
