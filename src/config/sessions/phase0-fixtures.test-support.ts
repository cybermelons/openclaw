// Shared Phase-0 characterization test fixtures: temp sqlite store, JSON store passthrough, call-order recorder.
import { afterEach, beforeEach } from "vitest";
import { cleanupTempDirs, makeTempDir } from "../../../test/helpers/temp-dir.js";
import {
  closeOpenClawAgentDatabasesForTest,
  openOpenClawAgentDatabase,
  resolveOpenClawAgentSqlitePath,
} from "../../state/openclaw-agent-db.js";

export { useTempSessionsFixture } from "./test-helpers.js";

/** Opens a temp sqlite agent database for "main" around each test; returns database/path/agentId accessors. */
export function useTempSqliteSessionStore() {
  const tempDirs: string[] = [];
  const agentId = "main";
  let databasePath = "";
  let database: ReturnType<typeof openOpenClawAgentDatabase> | undefined;

  beforeEach(() => {
    const tempDir = makeTempDir(tempDirs, "openclaw-phase0-");
    databasePath = resolveOpenClawAgentSqlitePath({
      agentId,
      env: { ...process.env, OPENCLAW_STATE_DIR: tempDir },
    });
    database = openOpenClawAgentDatabase({ agentId, path: databasePath });
  });

  afterEach(() => {
    closeOpenClawAgentDatabasesForTest();
    cleanupTempDirs(tempDirs);
  });

  return {
    database: () => {
      if (!database) {
        throw new Error("useTempSqliteSessionStore: database not initialized");
      }
      return database;
    },
    databasePath: () => databasePath,
    agentId,
  };
}

/** Backs a tiny ordered-name recorder so tests can assert relative call order of spied functions. */
export function createCallOrderRecorder(): {
  record: (name: string) => void;
  order: () => string[];
} {
  const calls: string[] = [];
  return {
    record: (name: string) => {
      calls.push(name);
    },
    order: () => [...calls],
  };
}
