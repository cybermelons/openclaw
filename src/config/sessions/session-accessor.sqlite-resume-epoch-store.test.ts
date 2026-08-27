import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { cleanupTempDirs, makeTempDir } from "../../../test/helpers/temp-dir.js";
import {
  ensureSessionResumeEpochSessionIdColumns,
  ensureSessionResumeEpochTable,
} from "../../state/openclaw-agent-db-session-migrations.js";
import {
  closeOpenClawAgentDatabasesForTest,
  openOpenClawAgentDatabase,
} from "../../state/openclaw-agent-db.js";
import { closeOpenClawStateDatabaseForTest } from "../../state/openclaw-state-db.js";
import { upsertSessionEntryCore } from "./session-accessor.sqlite-entry.js";
import {
  readSessionResumeEpoch,
  writeSessionResumeEpoch,
} from "./session-accessor.sqlite-resume-epoch-store.js";
import { resolveSqliteTargetFromSessionStorePath } from "./session-sqlite-target.js";

// Phase-4 CS-2 — session_resume_epoch marker: table creation, backfill of
// existing sessions as epoch=0/drained, write-API upsert, and idempotent
// re-migration. Nothing reads the marker to gate dispatch yet (CS-3/CS-4).
describe("Phase-4 CS-2 session_resume_epoch marker (T-P4-CS2)", () => {
  const tempDirs: string[] = [];
  let storePath: string;
  let databasePath: string;

  beforeEach(() => {
    const tempDir = makeTempDir(tempDirs, "openclaw-session-resume-epoch-");
    storePath = path.join(tempDir, "sessions.json");
    databasePath = resolveSqliteTargetFromSessionStorePath(storePath, { agentId: "main" }).path;
  });

  afterEach(() => {
    closeOpenClawAgentDatabasesForTest();
    closeOpenClawStateDatabaseForTest();
    cleanupTempDirs(tempDirs);
  });

  function openDatabase() {
    return openOpenClawAgentDatabase({ agentId: "main", path: databasePath });
  }

  it("migration backfills existing sessions as epoch=0 / drained", async () => {
    // Seed two sessions before the marker migration is asserted. Opening the
    // agent database already runs schema + migrations, so the backfill has
    // seeded both — assert the seeded state.
    await upsertSessionEntryCore(
      { sessionKey: "agent:main:alpha", storePath },
      { sessionId: "alpha-session", updatedAt: 10 },
    );
    await upsertSessionEntryCore(
      { sessionKey: "agent:main:beta", storePath },
      { sessionId: "beta-session", updatedAt: 20 },
    );

    const database = openDatabase();
    // Backfill is idempotent — re-running never disturbs seeded rows.
    ensureSessionResumeEpochTable(database.db);

    const alpha = readSessionResumeEpoch(database, "agent:main:alpha");
    const beta = readSessionResumeEpoch(database, "agent:main:beta");
    expect(alpha).toEqual({
      sessionKey: "agent:main:alpha",
      epoch: 0,
      state: "drained",
      sessionId: null,
      drainedThroughSeq: null,
      updatedAt: expect.any(Number),
    });
    expect(beta?.epoch).toBe(0);
    expect(beta?.state).toBe("drained");
    expect(beta?.sessionId).toBeNull();
    expect(beta?.drainedThroughSeq).toBeNull();
  });

  it("write API upserts epoch and state", async () => {
    await upsertSessionEntryCore(
      { sessionKey: "agent:main:gamma", storePath },
      { sessionId: "gamma-session", updatedAt: 30 },
    );
    const database = openDatabase();

    // Backfill seeded it as drained@0; flip to drain_pending@1.
    writeSessionResumeEpoch(database, {
      sessionKey: "agent:main:gamma",
      epoch: 1,
      state: "drain_pending",
      sessionId: "gamma-session",
      drainedThroughSeq: null,
    });
    expect(readSessionResumeEpoch(database, "agent:main:gamma")).toMatchObject({
      epoch: 1,
      state: "drain_pending",
      sessionId: "gamma-session",
      drainedThroughSeq: null,
    });

    // Upsert again — same key, advance epoch and flip to drained.
    writeSessionResumeEpoch(database, {
      sessionKey: "agent:main:gamma",
      epoch: 2,
      state: "drained",
      sessionId: "gamma-session",
      drainedThroughSeq: 7,
    });
    expect(readSessionResumeEpoch(database, "agent:main:gamma")).toMatchObject({
      epoch: 2,
      state: "drained",
      sessionId: "gamma-session",
      drainedThroughSeq: 7,
    });
  });

  it("re-running the migration is a no-op that preserves existing markers", async () => {
    await upsertSessionEntryCore(
      { sessionKey: "agent:main:delta", storePath },
      { sessionId: "delta-session", updatedAt: 40 },
    );
    const database = openDatabase();

    // Advance the marker, then re-run the migration: backfill must not
    // overwrite the advanced row back to epoch=0/drained.
    writeSessionResumeEpoch(database, {
      sessionKey: "agent:main:delta",
      epoch: 5,
      state: "drain_pending",
      sessionId: "delta-session",
      drainedThroughSeq: 3,
    });
    ensureSessionResumeEpochTable(database.db);
    ensureSessionResumeEpochTable(database.db);

    expect(readSessionResumeEpoch(database, "agent:main:delta")).toMatchObject({
      epoch: 5,
      state: "drain_pending",
      sessionId: "delta-session",
      drainedThroughSeq: 3,
    });
  });

  it("session_id/drained_through_seq columns fold in additively: pre-fold-in rows read back null, trigger still writes (epoch=0, drained, NULL, NULL)", async () => {
    await upsertSessionEntryCore(
      { sessionKey: "agent:main:epsilon", storePath },
      { sessionId: "epsilon-session", updatedAt: 60 },
    );
    const database = openDatabase();

    // Column-add migration is idempotent — re-running never disturbs the row.
    ensureSessionResumeEpochSessionIdColumns(database.db);
    ensureSessionResumeEpochSessionIdColumns(database.db);

    const epsilon = readSessionResumeEpoch(database, "agent:main:epsilon");
    expect(epsilon).toMatchObject({
      epoch: 0,
      state: "drained",
      sessionId: null,
      drainedThroughSeq: null,
    });

    // The AFTER-INSERT trigger (unchanged, names columns explicitly) still
    // produces a fresh (epoch=0, drained, NULL, NULL) row for a new session
    // created after the column fold-in.
    await upsertSessionEntryCore(
      { sessionKey: "agent:main:zeta", storePath },
      { sessionId: "zeta-session", updatedAt: 70 },
    );
    const zeta = readSessionResumeEpoch(database, "agent:main:zeta");
    expect(zeta).toMatchObject({
      epoch: 0,
      state: "drained",
      sessionId: null,
      drainedThroughSeq: null,
    });
  });

  it("returns null for a session with no marker row", async () => {
    // Seed one real session so the store (and its schema) is materialized,
    // then query a key that was never written — absence must read as null.
    await upsertSessionEntryCore(
      { sessionKey: "agent:main:present", storePath },
      { sessionId: "present-session", updatedAt: 50 },
    );
    const database = openDatabase();
    expect(readSessionResumeEpoch(database, "agent:main:absent")).toBeNull();
  });
});
