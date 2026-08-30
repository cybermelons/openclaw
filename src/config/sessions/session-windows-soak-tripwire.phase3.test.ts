// Phase 3 CS-7 — runtime soak tripwire (PHASE-3.md §4.2 step 3, §8(b)).
//
// The static merge-time proxy (session-droppable-column-tripwire.phase3.test.ts)
// asserts zero grep-visible live SELECTs of session_windows.status /
// .display_name outside the carve-out. That proxy cannot see dynamic SQL.
// This test exercises the REAL runtime hook wired into src/infra/kysely-sync.ts,
// which inspects the final compiled SQL string for every accessor read, so
// it catches what the static proxy structurally cannot.
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanupTempDirs, makeTempDir } from "../../../test/helpers/temp-dir.js";
import { executeSqliteQuerySync, iterateSqliteQuerySync } from "../../infra/kysely-sync.js";
import { getLogger } from "../../logging/logger.js";
import {
  closeOpenClawAgentDatabasesForTest,
  openOpenClawAgentDatabase,
} from "../../state/openclaw-agent-db.js";
import { closeOpenClawStateDatabaseForTest } from "../../state/openclaw-state-db.js";
import { upsertSessionEntryCore } from "./session-accessor.js";
import { getSessionKysely } from "./session-accessor.sqlite-scope.js";
import { listSessionTranscriptInstances } from "./session-history.js";
import { resolveSqliteTargetFromSessionStorePath } from "./session-sqlite-target.js";

const tempDirs: string[] = [];

const SOAK_TRIPWIRE_LOG_MESSAGE = "live SELECT of a droppable session_windows column value";

// getChildLogger() builds a fresh sub-logger instance per call (tslog's
// getSubLogger does `new this.constructor(...)`), so spying the getLogger()
// instance directly (as cleanup-service.agent-purge.test.ts does for a
// getLogger()-only call site) does not observe it. warn() is a shared
// prototype method (tslog Logger.prototype.warn), so spy there instead —
// this observes calls on the base logger AND every derived sub-logger.
function spyOnLoggerWarn() {
  const prototype = Object.getPrototypeOf(getLogger()) as { warn: (...args: unknown[]) => void };
  return vi.spyOn(prototype, "warn").mockImplementation(() => undefined);
}

describe("session_windows soak tripwire — runtime hook (Phase 3 CS-7, §4.2/§8(b))", () => {
  let tempDir: string;
  let storePath: string;
  let databasePath: string;
  let sessionKey: string;

  beforeEach(async () => {
    tempDir = makeTempDir(tempDirs, "openclaw-session-windows-soak-tripwire-");
    storePath = path.join(tempDir, "sessions.json");
    databasePath = resolveSqliteTargetFromSessionStorePath(storePath, { agentId: "main" }).path;
    sessionKey = "agent:main:soak-tripwire";
    await upsertSessionEntryCore(
      { sessionKey, storePath },
      { sessionId: "soak-tripwire-session", updatedAt: 10 },
    );
  });

  afterEach(() => {
    closeOpenClawAgentDatabasesForTest();
    closeOpenClawStateDatabaseForTest();
    cleanupTempDirs(tempDirs);
    vi.restoreAllMocks();
  });

  function openDb() {
    const database = openOpenClawAgentDatabase({ agentId: "main", path: databasePath });
    const db = getSessionKysely(database.db);
    return { database, db };
  }

  it("logs when a non-carve-out reader SELECTs session_windows.status by name", () => {
    const warn = spyOnLoggerWarn();
    const { database, db } = openDb();

    const rows = executeSqliteQuerySync(
      database.db,
      db
        .selectFrom("session_windows")
        .select(["session_id", "status"])
        .where("session_key", "=", sessionKey),
    ).rows;

    expect(rows).toHaveLength(1);
    expect(warn).toHaveBeenCalledWith(
      SOAK_TRIPWIRE_LOG_MESSAGE,
      expect.objectContaining({ columns: ["status"] }),
    );
  });

  it("logs when a non-carve-out reader SELECTs session_windows.display_name by name via iterateSqliteQuerySync", () => {
    const warn = spyOnLoggerWarn();
    const { database, db } = openDb();

    const rows = [
      ...iterateSqliteQuerySync(
        database.db,
        db
          .selectFrom("session_windows")
          .select(["session_id", "display_name"])
          .where("session_key", "=", sessionKey),
      ),
    ];

    expect(rows).toHaveLength(1);
    expect(warn).toHaveBeenCalledWith(
      SOAK_TRIPWIRE_LOG_MESSAGE,
      expect.objectContaining({ columns: ["display_name"] }),
    );
  });

  it("does NOT log for a SELECT of an unrelated column", () => {
    const warn = spyOnLoggerWarn();
    const { database, db } = openDb();

    const rows = executeSqliteQuerySync(
      database.db,
      db
        .selectFrom("session_windows")
        .select(["session_id", "session_key"])
        .where("session_key", "=", sessionKey),
    ).rows;

    expect(rows).toHaveLength(1);
    expect(warn).not.toHaveBeenCalledWith(SOAK_TRIPWIRE_LOG_MESSAGE, expect.anything());
  });

  it("does NOT log when status is only used in a WHERE/ORDER BY clause (class (a) filter/sort use), not the select-list", () => {
    const warn = spyOnLoggerWarn();
    const { database, db } = openDb();

    const rows = executeSqliteQuerySync(
      database.db,
      db
        .selectFrom("session_windows")
        .select(["session_id", "session_key"])
        .where("status", "is", null)
        .orderBy("status", "desc"),
    ).rows;

    expect(rows).toHaveLength(1);
    expect(warn).not.toHaveBeenCalledWith(SOAK_TRIPWIRE_LOG_MESSAGE, expect.anything());
  });

  it("does NOT log for the sanctioned carve-out reader (session-accessor.sqlite-history.ts)", () => {
    const warn = spyOnLoggerWarn();
    const { database } = openDb();

    // listTranscriptInstancesFromDatabase (the carve-out) only returns rows
    // with transcript_updated_at set. Advance it directly in SQL so the real
    // carve-out call site executes its real query through the real hook.
    database.db.prepare("UPDATE session_windows SET transcript_updated_at = ? WHERE session_key = ?").run(
      20,
      sessionKey,
    );

    const instances = listSessionTranscriptInstances({ agentId: "main", storePath });

    expect(instances.some((instance) => instance.sessionKey === sessionKey)).toBe(true);
    expect(warn).not.toHaveBeenCalledWith(SOAK_TRIPWIRE_LOG_MESSAGE, expect.anything());
  });
});
