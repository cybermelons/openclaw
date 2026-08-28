// T-P1g (PHASE-1.md §4, CS-3b): entry-CAS "changed before" throw sites owned
// by session-accessor.sqlite-projection.ts. Each test lands a competing raw
// write between the async prepare/projection phase and the synchronous
// commit transaction (via `beforeCommitInTransaction`, the same seam
// session-cas-concurrency.phase1.test.ts uses for the primary patch path),
// then asserts the recompare throws SessionConflictError with the correct
// expected/actual revision (revision compare).
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
  applySessionEntryReplacements,
  upsertSessionEntryCore,
} from "./session-accessor.js";
import { writeSessionEntry } from "./session-accessor.sqlite-entry-store.js";
import { SessionConflictError } from "./session-conflict-error.js";
import { resolveSqliteTargetFromSessionStorePath } from "./session-sqlite-target.js";

const tempDirs: string[] = [];

function readRevision(databasePath: string, sessionKey: string): number | undefined {
  const database = openOpenClawAgentDatabase({ agentId: "main", path: databasePath });
  const row = database.db
    .prepare("SELECT revision FROM session_nodes WHERE session_key = ?")
    .get(sessionKey) as { revision: number } | undefined;
  return row?.revision;
}

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

describe("session projection entry-CAS (T-P1g)", () => {
  let tempDir: string;
  let storePath: string;
  let databasePath: string;

  beforeEach(() => {
    tempDir = makeTempDir(tempDirs, "openclaw-session-cas-projection-");
    storePath = path.join(tempDir, "sessions.json");
    databasePath = resolveSqliteTargetFromSessionStorePath(storePath, { agentId: "main" }).path;
  });

  afterEach(() => {
    closeOpenClawAgentDatabasesForTest();
    closeOpenClawStateDatabaseForTest();
    cleanupTempDirs(tempDirs);
  });

  it("lifecycle removal conflicts when a competing write lands before commit", async () => {
    const sessionKey = "agent:main:lifecycle-removal-conflict";
    await upsertSessionEntryCore(
      { sessionKey, storePath },
      { sessionId: "removal-conflict-session", updatedAt: 10 },
    );
    const expectedRevision = readRevision(databasePath, sessionKey);
    expect(expectedRevision).toBeDefined();

    let conflict: SessionConflictError | undefined;
    try {
      await applySessionEntryLifecycleMutation({
        beforeCommitInTransaction: () => {
          landCompetingEntryWrite(databasePath, sessionKey, "competing-removal");
        },
        removals: [{ sessionKey }],
        storePath,
      });
      expect.unreachable("expected removal to reject with SessionConflictError");
    } catch (err) {
      expect(err).toBeInstanceOf(SessionConflictError);
      conflict = err as SessionConflictError;
    }
    expect(conflict).toBeDefined();
    expect(conflict?.key).toBe(sessionKey);
    expect(conflict?.retryable).toBe(true);
    expect(conflict?.expectedRevision).toBe(expectedRevision);
    expect(conflict?.actualRevision).toBeGreaterThan(conflict?.expectedRevision as number);
  });

  it("lifecycle upsert conflicts when a competing write lands before commit", async () => {
    const sessionKey = "agent:main:lifecycle-upsert-conflict";
    await upsertSessionEntryCore(
      { sessionKey, storePath },
      { sessionId: "upsert-conflict-session", updatedAt: 10 },
    );
    const expectedRevision = readRevision(databasePath, sessionKey);
    expect(expectedRevision).toBeDefined();

    let conflict: SessionConflictError | undefined;
    try {
      await applySessionEntryLifecycleMutation({
        beforeCommitInTransaction: () => {
          landCompetingEntryWrite(databasePath, sessionKey, "competing-upsert");
        },
        storePath,
        upserts: [
          {
            entry: { sessionId: "upsert-conflict-session", updatedAt: 20, label: "planned" },
            sessionKey,
          },
        ],
      });
      expect.unreachable("expected upsert to reject with SessionConflictError");
    } catch (err) {
      expect(err).toBeInstanceOf(SessionConflictError);
      conflict = err as SessionConflictError;
    }
    expect(conflict).toBeDefined();
    expect(conflict?.key).toBe(sessionKey);
    expect(conflict?.retryable).toBe(true);
    expect(conflict?.expectedRevision).toBe(expectedRevision);
    expect(conflict?.actualRevision).toBeGreaterThan(conflict?.expectedRevision as number);
  });

  it("exact replacement conflicts when a competing write lands before commit", async () => {
    const sessionKey = "agent:main:replacement-conflict";
    await upsertSessionEntryCore(
      { sessionKey, storePath },
      { sessionId: "replacement-conflict-session", updatedAt: 10 },
    );
    const expectedRevision = readRevision(databasePath, sessionKey);
    expect(expectedRevision).toBeDefined();
    let landed = false;

    let conflict: SessionConflictError | undefined;
    try {
      await applySessionEntryReplacements({
        sessionKeys: [sessionKey],
        storePath,
        update: (entries) => {
          // The projection's own transaction has no synchronous pre-commit
          // hook on this path, so land the competing write from inside the
          // `update` callback — it runs after the expected-snapshot capture
          // and before the recompare in the write transaction.
          if (!landed) {
            landed = true;
            landCompetingEntryWrite(databasePath, sessionKey, "competing-replacement");
          }
          return {
            replacements: entries.map(({ sessionKey: key, entry }) => ({
              entry: { ...entry, label: "planned-replacement" },
              sessionKey: key,
            })),
            result: undefined,
          };
        },
      });
      expect.unreachable("expected replacement to reject with SessionConflictError");
    } catch (err) {
      expect(err).toBeInstanceOf(SessionConflictError);
      conflict = err as SessionConflictError;
    }
    expect(conflict).toBeDefined();
    expect(conflict?.key).toBe(sessionKey);
    expect(conflict?.retryable).toBe(true);
    expect(conflict?.expectedRevision).toBe(expectedRevision);
    expect(conflict?.actualRevision).toBeGreaterThan(conflict?.expectedRevision as number);
  });
});
