// T-P1f (PHASE-1.md §8, Delta 2): for each §2a write class exercised via the
// accessor, perform that write against a fixture row and assert `revision`
// strictly increased. Iterates the CS-3-classification.md table (satellites
// excluded — session_participants is not a session_nodes write).
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { cleanupTempDirs, makeTempDir } from "../../../test/helpers/temp-dir.js";
import {
  closeOpenClawAgentDatabasesForTest,
  openOpenClawAgentDatabase,
} from "../../state/openclaw-agent-db.js";
import { closeOpenClawStateDatabaseForTest } from "../../state/openclaw-state-db.js";
import {
  deleteSessionEntryLifecycle,
  patchSessionEntryCore,
  replaceSessionEntry,
  upsertSessionEntryCore,
} from "./session-accessor.js";
import { recordSessionParticipant } from "./session-accessor.sqlite-participants.js";
import { resolveSqliteTargetFromSessionStorePath } from "./session-sqlite-target.js";

const tempDirs: string[] = [];

function readRevision(databasePath: string, sessionKey: string): number | undefined {
  const database = openOpenClawAgentDatabase({ agentId: "main", path: databasePath });
  const row = database.db
    .prepare("SELECT revision FROM session_nodes WHERE session_key = ?")
    .get(sessionKey) as { revision: number } | undefined;
  return row?.revision;
}

describe("session_nodes revision bump — writer inventory (T-P1f)", () => {
  let tempDir: string;
  let storePath: string;
  let databasePath: string;

  beforeEach(() => {
    tempDir = makeTempDir(tempDirs, "openclaw-session-cas-revision-bump-");
    storePath = path.join(tempDir, "sessions.json");
    databasePath = resolveSqliteTargetFromSessionStorePath(storePath, { agentId: "main" }).path;
  });

  afterEach(() => {
    closeOpenClawAgentDatabasesForTest();
    closeOpenClawStateDatabaseForTest();
    cleanupTempDirs(tempDirs);
  });

  it("bumps revision on the initial insert (Upsert class)", async () => {
    const scope = { sessionKey: "agent:main:insert-bump", storePath };
    await upsertSessionEntryCore(scope, { sessionId: "insert-session", updatedAt: 10 });
    const revision = readRevision(databasePath, scope.sessionKey);
    expect(revision).toBeGreaterThanOrEqual(1);
  });

  it("bumps revision on entry-patch upsert (CAS class, entry-patch upsert)", async () => {
    const scope = { sessionKey: "agent:main:patch-bump", storePath };
    await upsertSessionEntryCore(scope, { sessionId: "patch-session", updatedAt: 10 });
    const before = readRevision(databasePath, scope.sessionKey);
    await patchSessionEntryCore(scope, (entry) => ({ ...entry, label: "patched" }));
    const after = readRevision(databasePath, scope.sessionKey);
    expect(before).toBeDefined();
    expect(after).toBeGreaterThan(before as number);
  });

  it("bumps revision on replace (CAS class, replaceEntry)", async () => {
    const scope = { sessionKey: "agent:main:replace-bump", storePath };
    await upsertSessionEntryCore(scope, { sessionId: "replace-session", updatedAt: 10 });
    const before = readRevision(databasePath, scope.sessionKey);
    await replaceSessionEntry(scope, { sessionId: "replace-session", updatedAt: 20 });
    const after = readRevision(databasePath, scope.sessionKey);
    expect(before).toBeDefined();
    expect(after).toBeGreaterThan(before as number);
  });

  it("bumps revision on lifecycle delete's clear-preserving-windows path (Upsert/Blind class)", async () => {
    const sessionKey = "agent:main:delete-bump";
    const scope = { agentId: "main", sessionKey, storePath };
    await upsertSessionEntryCore(scope, { sessionId: "delete-session", updatedAt: 10 });
    const before = readRevision(databasePath, sessionKey);
    expect(before).toBeDefined();
    await deleteSessionEntryLifecycle({
      archiveTranscript: false,
      storePath,
      target: { canonicalKey: sessionKey, storeKeys: [sessionKey] },
    });
    // Deletion either drops the row (revision no longer applicable) or, when a
    // window survives, clears the entry in place via a revision-bumping
    // insert-or-conflict-update — either way the pre-delete revision must not
    // silently persist unchanged on a still-present row.
    const after = readRevision(databasePath, scope.sessionKey);
    if (after !== undefined) {
      expect(after).toBeGreaterThan(before as number);
    }
  });

  it("does NOT bump session_nodes.revision on a participant-only (satellite) write", async () => {
    const scope = { sessionKey: "agent:main:participant-bump", storePath };
    await upsertSessionEntryCore(scope, { sessionId: "participant-session", updatedAt: 10 });
    const before = readRevision(databasePath, scope.sessionKey);
    recordSessionParticipant(scope, {
      actor: { type: "human", id: "human-1" },
      source: "channel",
    });
    const after = readRevision(databasePath, scope.sessionKey);
    expect(after).toBe(before);
  });
});
