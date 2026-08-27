// Phase 3 CS-5 — T-P3-ZC (PHASE-3.md §6.1): zero-cache discipline.
// Proves no public read accessor ever serves a projected COLUMN value as
// fact. Two halves:
//   1. Honest half — bump revision via a real write, re-read through every
//      public accessor, confirm each reflects the post-bump blob.
//   2. Hostile half — mutate a projected column directly in SQL, bypassing
//      the write path entirely (entry_json untouched). Every accessor must
//      still return the BLOB value, not the mutated column. This is the
//      executable proof of the whole phase (§6.1: "If any accessor returns
//      the mutated value, a fact-read survived the audit").
import { afterEach, describe, expect, it } from "vitest";
import { cleanupTempDirs, makeTempDir } from "../../../test/helpers/temp-dir.js";
import { closeOpenClawAgentDatabasesForTest } from "../../state/openclaw-agent-db.js";
import { openOpenClawAgentDatabase } from "../../state/openclaw-agent-db.js";
import { closeOpenClawStateDatabaseForTest } from "../../state/openclaw-state-db.js";
import {
  hasSessionEntriesByStatusReadOnly,
  listSessionEntriesCore,
  listSessionEntriesReadOnly,
  upsertSessionEntryCore,
} from "./session-accessor.js";
import { readExactSessionEntryRow } from "./session-accessor.sqlite-entry-store.js";
import { readSessionEntriesByStatus } from "./session-accessor.sqlite-status.js";

const tempDirs: string[] = [];

afterEach(() => {
  closeOpenClawAgentDatabasesForTest();
  closeOpenClawStateDatabaseForTest();
  cleanupTempDirs(tempDirs);
});

describe("Phase 3 T-P3-ZC — zero-cache discipline", () => {
  it("every public accessor reflects the blob after a revision-bumping write", async () => {
    const stateDir = makeTempDir(tempDirs, "openclaw-phase3-zc-honest-");
    const env = { OPENCLAW_STATE_DIR: stateDir };
    const agentId = "main";
    const sessionKey = "agent:main:zc-honest";
    const scope = { agentId, env, sessionKey };

    await upsertSessionEntryCore(scope, {
      sessionId: "session-1",
      status: "running",
      updatedAt: 10,
      displayName: "before",
    });
    // A second upsert bumps revision and changes the blob-visible facts.
    await upsertSessionEntryCore(scope, {
      sessionId: "session-1",
      status: "done",
      updatedAt: 20,
      displayName: "after",
    });
    closeOpenClawAgentDatabasesForTest();

    const listScope = { agentId, env };
    const listed = listSessionEntriesReadOnly(listScope).find(
      (row) => row.sessionKey === sessionKey,
    );
    expect(listed?.entry.status).toBe("done");
    expect(listed?.entry.displayName).toBe("after");

    const listedCore = listSessionEntriesCore(listScope).find(
      (row) => row.sessionKey === sessionKey,
    );
    expect(listedCore?.entry.status).toBe("done");
    expect(listedCore?.entry.displayName).toBe("after");

    const database = openOpenClawAgentDatabase({ agentId, env });
    const byStatus = readSessionEntriesByStatus(database, ["done"]).find(
      (row) => row.sessionKey === sessionKey,
    );
    expect(byStatus?.entry.status).toBe("done");
    expect(byStatus?.entry.displayName).toBe("after");

    expect(hasSessionEntriesByStatusReadOnly(listScope, ["done"])).toBe(true);
    expect(hasSessionEntriesByStatusReadOnly(listScope, ["running"])).toBe(false);

    const exactRow = readExactSessionEntryRow(database, sessionKey);
    expect(exactRow?.entry.status).toBe("done");
    expect(exactRow?.entry.displayName).toBe("after");
  });

  it("hostile half — a projected column mutated directly in SQL never leaks past any accessor", async () => {
    const stateDir = makeTempDir(tempDirs, "openclaw-phase3-zc-hostile-");
    const env = { OPENCLAW_STATE_DIR: stateDir };
    const agentId = "main";
    const sessionKey = "agent:main:zc-hostile";
    const scope = { agentId, env, sessionKey };

    await upsertSessionEntryCore(scope, {
      sessionId: "session-1",
      status: "running",
      updatedAt: 10,
      displayName: "blob-truth",
    });

    // Mutate the projected COLUMNS directly, bypassing the write path.
    // entry_json is untouched, so the blob still says status=running,
    // displayName=blob-truth.
    const database = openOpenClawAgentDatabase({ agentId, env });
    database.db
      .prepare("UPDATE session_nodes SET status = ?, display_name = ? WHERE session_key = ?")
      .run("killed", "column-lie", sessionKey);
    closeOpenClawAgentDatabasesForTest();

    const listScope = { agentId, env };
    const listed = listSessionEntriesReadOnly(listScope).find(
      (row) => row.sessionKey === sessionKey,
    );
    expect(listed?.entry.status).toBe("running");
    expect(listed?.entry.displayName).toBe("blob-truth");

    const listedCore = listSessionEntriesCore(listScope).find(
      (row) => row.sessionKey === sessionKey,
    );
    expect(listedCore?.entry.status).toBe("running");
    expect(listedCore?.entry.displayName).toBe("blob-truth");

    const reopened = openOpenClawAgentDatabase({ agentId, env });
    // readSessionEntriesByStatus's SQL WHERE is a cheap pre-narrow on the
    // (now-lying) COLUMN, then re-verifies membership against the blob
    // (session-accessor.sqlite-status.ts:40-54, §8c). Querying for the
    // mutated column value "killed" is exactly the case that pre-narrow
    // lets through — it must then be rejected once checked against the
    // blob, which still says "running". A query for "running" would miss
    // the row entirely at the SQL layer (the column pre-narrow excludes
    // it), which is a documented pre-narrow miss, not a fact-read leak.
    expect(
      readSessionEntriesByStatus(reopened, ["killed"]).find((row) => row.sessionKey === sessionKey),
    ).toBeUndefined();
    const byStatus = readSessionEntriesByStatus(reopened, ["running", "killed"]).find(
      (row) => row.sessionKey === sessionKey,
    );
    expect(byStatus?.entry.status).toBe("running");
    expect(byStatus?.entry.displayName).toBe("blob-truth");

    expect(hasSessionEntriesByStatusReadOnly(listScope, ["running"])).toBe(true);
    expect(hasSessionEntriesByStatusReadOnly(listScope, ["killed"])).toBe(false);

    const exactRow = readExactSessionEntryRow(reopened, sessionKey);
    expect(exactRow?.entry.status).toBe("running");
    expect(exactRow?.entry.displayName).toBe("blob-truth");
  });
});
