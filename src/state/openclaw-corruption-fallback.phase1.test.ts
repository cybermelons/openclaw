// T-P1e (CORRUPTION-FALLBACK.md, PHASE-1.md §6a/6b/6c, Phase 1 CS-4): the
// corruption-fallback slice. Covers, in order:
//   1. corrupt-DB -> sticky marker written -> sessions skipped on boot,
//      sticky across a second boot (never auto-cleared by a later clean open).
//   2. LKG restore re-enters the synchronous open funnel
//      (openOpenClawAgentDatabase) rather than resuming a half-opened handle.
//   3. a pre-Phase-1 LKG snapshot (schema v17, no session_nodes.revision)
//      restores then migrates to head, with the revision column present and
//      readable at 0, and a subsequent CAS-from-0 write succeeding.
//   4. open-time validation (6c) budget accounting never blocks boot.
import fs from "node:fs";
import { afterEach, describe, expect, it } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import { isSessionRecoveryStorePathQuarantined } from "../agents/main-session-recovery/main-session-restart-recovery-shared.js";
import { requireNodeSqlite } from "../infra/node-sqlite.js";
import { readSqliteNumberPragma } from "../infra/sqlite-pragma.test-support.js";
import { OPENCLAW_AGENT_SCHEMA_VERSION } from "./openclaw-agent-db-contract.js";
import { resolveOpenClawAgentDatabaseLkgPath } from "./openclaw-agent-db-lkg.js";
import {
  OPENCLAW_AGENT_DB_OPEN_VALIDATION_BUDGET_MS,
  assertOpenClawAgentDatabaseOpenTimeValidation,
} from "./openclaw-agent-db-open-validation.js";
import {
  closeOpenClawAgentDatabasesForTest,
  openOpenClawAgentDatabase,
  runOpenClawAgentWriteTransaction,
} from "./openclaw-agent-db.js";
import {
  isOpenClawDatabaseCorruptMarker,
  readOpenClawDatabaseQuarantine,
} from "./openclaw-quarantine-store.js";
import { closeOpenClawStateDatabaseForTest } from "./openclaw-state-db.js";

const tempDirs = useAutoCleanupTempDirTracker((cleanup) => {
  afterEach(() => {
    try {
      closeOpenClawAgentDatabasesForTest();
    } finally {
      try {
        closeOpenClawStateDatabaseForTest();
      } finally {
        cleanup();
      }
    }
  });
});

function makeStateDir(): string {
  return tempDirs.make("openclaw-corruption-fallback-phase1-");
}

/**
 * Same technique as openclaw-database-verify.test.ts: proven page/index
 * damage on a table outside the canonical schema set, so the canonical-index
 * self-repair path (verifyAndRepairCanonicalSqliteIndexes) cannot silently
 * heal it before assertSqliteIntegrity's terminal check is reached.
 */
function corruptDatabaseIndex(databasePath: string): void {
  const { DatabaseSync } = requireNodeSqlite();
  const database = new DatabaseSync(databasePath);
  try {
    database.exec(`
      CREATE TABLE unsafe_index_records (
        id INTEGER PRIMARY KEY,
        indexed_value TEXT NOT NULL
      );
      CREATE INDEX unsafe_index_records_value ON unsafe_index_records(indexed_value);
      INSERT INTO unsafe_index_records (indexed_value) VALUES ('alpha'), ('beta');
    `);
    database.enableDefensive?.(false);
    database.exec("PRAGMA writable_schema = ON;");
    database
      .prepare(
        "UPDATE sqlite_schema SET sql = 'CREATE INDEX unsafe_index_records_value ON unsafe_index_records(id)' WHERE name = 'unsafe_index_records_value'",
      )
      .run();
    const schemaVersion = readSqliteNumberPragma(database, "schema_version");
    database.exec(`PRAGMA writable_schema = OFF; PRAGMA schema_version = ${schemaVersion + 1};`);
  } finally {
    database.close();
  }
}

describe("corruption-fallback (T-P1e)", () => {
  it("writes a sticky marker on terminal corruption and keeps sessions skipped across a second boot", () => {
    const stateDir = makeStateDir();
    const env = { OPENCLAW_STATE_DIR: stateDir };
    const agentPath = openOpenClawAgentDatabase({ agentId: "worker-1", env }).path;
    runOpenClawAgentWriteTransaction(
      (database) => {
        database.db.exec(
          "INSERT INTO session_nodes (session_key, current_session_id, entry_json, updated_at, revision) VALUES ('seed-session', 'seed-session-id', '{}', 1, 0)",
        );
      },
      { agentId: "worker-1", env },
    );
    closeOpenClawAgentDatabasesForTest();

    corruptDatabaseIndex(agentPath);

    // Open recovers rather than throwing: quarantine + reinit/restore, then
    // the caller's open funnel re-enters and returns a usable handle.
    const recovered = openOpenClawAgentDatabase({ agentId: "worker-1", env });
    expect(recovered.path).toBe(agentPath);

    const marker = readOpenClawDatabaseQuarantine(agentPath, { env });
    expect(isOpenClawDatabaseCorruptMarker(marker)).toBe(true);
    expect(marker?.quarantinedFilePath).toBeTruthy();
    expect(fs.existsSync(marker!.quarantinedFilePath!)).toBe(true);

    // Startup recovery guards must consult the sticky marker and skip this
    // database's sessions, both immediately and on a later, unrelated clean
    // open of the recovered file (never auto-cleared).
    expect(isSessionRecoveryStorePathQuarantined(agentPath, env)).toBe(true);

    closeOpenClawAgentDatabasesForTest();
    const reopened = openOpenClawAgentDatabase({ agentId: "worker-1", env });
    expect(reopened.path).toBe(agentPath);
    closeOpenClawAgentDatabasesForTest();

    // A later clean open of the restored/reinitialized file must not silently
    // clear the marker: only an operator/doctor action or verified restore may.
    const markerAfterCleanReopen = readOpenClawDatabaseQuarantine(agentPath, { env });
    expect(isOpenClawDatabaseCorruptMarker(markerAfterCleanReopen)).toBe(true);
    expect(isSessionRecoveryStorePathQuarantined(agentPath, env)).toBe(true);
  });

  it("restores from LKG by re-entering the synchronous open funnel", () => {
    const stateDir = makeStateDir();
    const env = { OPENCLAW_STATE_DIR: stateDir };
    const agentPath = openOpenClawAgentDatabase({ agentId: "worker-1", env }).path;

    runOpenClawAgentWriteTransaction(
      (database) => {
        database.db.exec(
          "INSERT INTO session_nodes (session_key, current_session_id, entry_json, updated_at, revision) VALUES ('lkg-marker-session', 'lkg-marker-session-id', '{\"ok\":true}', 1, 1)",
        );
      },
      { agentId: "worker-1", env },
    );
    closeOpenClawAgentDatabasesForTest();

    // Publish a verified LKG snapshot from the known-good state above.
    const lkgPath = resolveOpenClawAgentDatabaseLkgPath(agentPath);
    fs.copyFileSync(agentPath, lkgPath);

    corruptDatabaseIndex(agentPath);

    const recovered = openOpenClawAgentDatabase({ agentId: "worker-1", env });
    expect(recovered.path).toBe(agentPath);

    // The restored file re-entered the open funnel: it opens successfully at
    // head schema and carries the pre-corruption row forward (the "lossy
    // rewind" caveat only means writes after the LKG snapshot are lost, not
    // that the funnel is bypassed).
    expect(readSqliteNumberPragma(recovered.db, "user_version")).toBe(
      OPENCLAW_AGENT_SCHEMA_VERSION,
    );
    const restoredRow = recovered.db
      .prepare("SELECT entry_json FROM session_nodes WHERE session_key = 'lkg-marker-session'")
      .get() as { entry_json?: unknown } | undefined;
    expect(restoredRow?.entry_json).toBe('{"ok":true}');

    const marker = readOpenClawDatabaseQuarantine(agentPath, { env });
    expect(isOpenClawDatabaseCorruptMarker(marker)).toBe(true);
  });

  it("migrates a pre-Phase-1 (schema v17, no revision column) LKG restore to head", () => {
    const stateDir = makeStateDir();
    const env = { OPENCLAW_STATE_DIR: stateDir };
    const agentPath = openOpenClawAgentDatabase({ agentId: "worker-1", env }).path;
    closeOpenClawAgentDatabasesForTest();

    // Build a pre-Phase-1 LKG snapshot: drop the revision column added by
    // CS-3b's ensureSessionRevisionColumn migration and roll user_version
    // back to 17, the last schema version before session_nodes.revision.
    const lkgPath = resolveOpenClawAgentDatabaseLkgPath(agentPath);
    fs.copyFileSync(agentPath, lkgPath);
    const { DatabaseSync } = requireNodeSqlite();
    const legacySnapshot = new DatabaseSync(lkgPath);
    try {
      legacySnapshot.exec(`
        ALTER TABLE session_nodes DROP COLUMN revision;
        PRAGMA user_version = 17;
      `);
    } finally {
      legacySnapshot.close();
    }

    // corruptDatabaseIndex proves damage by dropping a row from the live
    // index; seed one row on the live (corrupt-target) file first.
    runOpenClawAgentWriteTransaction(
      (database) => {
        database.db.exec(
          "INSERT INTO session_nodes (session_key, current_session_id, entry_json, updated_at, revision) VALUES ('seed-session', 'seed-session-id', '{}', 1, 0)",
        );
      },
      { agentId: "worker-1", env },
    );
    closeOpenClawAgentDatabasesForTest();
    corruptDatabaseIndex(agentPath);

    const recovered = openOpenClawAgentDatabase({ agentId: "worker-1", env });

    // Restore-then-reenter ran the Phase 1 migration chain: schema is back at
    // head, and the revision column exists with the documented DEFAULT 0 for
    // pre-revision-era rows.
    expect(readSqliteNumberPragma(recovered.db, "user_version")).toBe(
      OPENCLAW_AGENT_SCHEMA_VERSION,
    );
    const columns = recovered.db.prepare("PRAGMA table_info(session_nodes)").all() as Array<{
      name?: unknown;
    }>;
    expect(columns.some((column) => column.name === "revision")).toBe(true);

    runOpenClawAgentWriteTransaction(
      (database) => {
        database.db.exec(
          "INSERT INTO session_nodes (session_key, current_session_id, entry_json, updated_at, revision) VALUES ('post-migration-session', 'post-migration-session-id', '{}', 1, 0)",
        );
        const row = database.db
          .prepare(
            "SELECT revision FROM session_nodes WHERE session_key = 'post-migration-session'",
          )
          .get() as { revision?: unknown };
        expect(row.revision).toBe(0);
        // Subsequent CAS-from-0 succeeds against the migrated row.
        const result = database.db
          .prepare(
            "UPDATE session_nodes SET entry_json = '{\"bumped\":true}', revision = 1 WHERE session_key = 'post-migration-session' AND revision = 0",
          )
          .run();
        expect(result.changes).toBe(1);
      },
      { agentId: "worker-1", env },
    );
  });

  it("keeps the open-time validation budget accounting from blocking boot", () => {
    const stateDir = makeStateDir();
    const env = { OPENCLAW_STATE_DIR: stateDir };
    const agent = openOpenClawAgentDatabase({ agentId: "worker-1", env });

    // A nominal database finishes well inside budget and never throws.
    const result = assertOpenClawAgentDatabaseOpenTimeValidation(agent.db, agent.path, {
      migrationHeadVersion: OPENCLAW_AGENT_SCHEMA_VERSION,
    });
    expect(result.overBudget).toBe(false);
    expect(result.elapsedMs).toBeLessThan(OPENCLAW_AGENT_DB_OPEN_VALIDATION_BUDGET_MS);
    expect(result.newestEntryParsed).toBe(true);

    // A user_version mismatch against the migration head is a real app-level
    // invariant violation distinct from being merely over budget: it throws.
    expect(() =>
      assertOpenClawAgentDatabaseOpenTimeValidation(agent.db, agent.path, {
        migrationHeadVersion: OPENCLAW_AGENT_SCHEMA_VERSION + 1,
      }),
    ).toThrow(/user_version/);
  });
});
