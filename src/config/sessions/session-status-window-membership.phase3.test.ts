// Phase 3 CS-4 pin test (trap #2, §8c): `readSessionEntriesByStatus` used the
// `status` COLUMN for row-set MEMBERSHIP while projecting VALUES from the
// blob. That let column/blob divergence smuggle a row into (or out of) a
// status-gated set that feeds a write path
// (`applySqliteSessionEntryReplacementProjection`) and `listSessionEntriesByStatus`.
// Fix: membership is now blob-truth too (post-projection re-filter on
// `entry.status`), matching the already-blob-sourced values.
import { describe, expect, it } from "vitest";
import { useTempSqliteSessionStore } from "./phase0-fixtures.test-support.js";
import { readSessionEntriesByStatus } from "./session-accessor.sqlite-status.js";

const store = useTempSqliteSessionStore();

type SeedRow = {
  columnStatus: string;
  entryStatus: string;
  sessionKey: string;
};

/** Inserts a session_nodes row whose blob (`entry_json.status`) and `status`
 * column can be set independently, so tests can force column/blob divergence. */
function seedRow(seed: SeedRow): void {
  const db = store.database().db;
  const sessionId = `sess-${seed.sessionKey}`;
  const entryJson = JSON.stringify({
    sessionId,
    updatedAt: 100,
    status: seed.entryStatus,
  });
  db.prepare(
    `INSERT INTO session_nodes (session_key, current_session_id, entry_json, updated_at, status)
     VALUES (?, ?, ?, ?, ?)`,
  ).run(seed.sessionKey, sessionId, entryJson, 100, seed.columnStatus);
}

function setColumnStatus(sessionKey: string, status: string): void {
  store
    .database()
    .db.prepare("UPDATE session_nodes SET status=? WHERE session_key=?")
    .run(status, sessionKey);
}

describe("Phase 3 CS-4: readSessionEntriesByStatus membership is blob-truth", () => {
  it("T-P3-ZC-status-membership: membership follows the blob status, not a diverged column", () => {
    const database = store.database();
    const key = "agent:main:status-membership";
    seedRow({ sessionKey: key, columnStatus: "done", entryStatus: "done" });

    // Clean data: column and blob agree on "done".
    expect(readSessionEntriesByStatus(database, ["done"]).map((r) => r.sessionKey)).toContain(key);
    expect(
      readSessionEntriesByStatus(database, ["running"]).map((r) => r.sessionKey),
    ).not.toContain(key);

    // Diverge ONLY the column: blob still says "done", column now says "running".
    // The SQL `status IN (...)` filter stays a cheap pre-narrow (the index job),
    // so this row is still fetched by a "running" query (column matches) but is
    // now excluded by a "done" query (column no longer matches, so the pre-narrow
    // never hands the row to projectSessionEntry). Membership becomes blob-truth
    // WITHIN what the pre-narrow fetches: a row whose column falsely claims
    // membership in the requested set must not be admitted just because the
    // column says so — the blob is re-checked and wins.
    setColumnStatus(key, "running");

    // Column claims "running" membership; blob-truth vetoes it (blob says "done").
    expect(
      readSessionEntriesByStatus(database, ["running"]).map((r) => r.sessionKey),
    ).not.toContain(key);
  });

  it("equivalence half: on clean data, blob-truth filtering matches a plain column filter", () => {
    const database = store.database();
    seedRow({ sessionKey: "agent:main:eq-done", columnStatus: "done", entryStatus: "done" });
    seedRow({
      sessionKey: "agent:main:eq-running",
      columnStatus: "running",
      entryStatus: "running",
    });
    seedRow({ sessionKey: "agent:main:eq-failed", columnStatus: "failed", entryStatus: "failed" });

    const doneKeys = readSessionEntriesByStatus(database, ["done"]).map((r) => r.sessionKey);
    const runningKeys = readSessionEntriesByStatus(database, ["running"]).map((r) => r.sessionKey);
    const failedKeys = readSessionEntriesByStatus(database, ["failed"]).map((r) => r.sessionKey);

    expect(doneKeys).toEqual(["agent:main:eq-done"]);
    expect(runningKeys).toEqual(["agent:main:eq-running"]);
    expect(failedKeys).toEqual(["agent:main:eq-failed"]);

    const multiKeys = readSessionEntriesByStatus(database, ["done", "failed"]).map(
      (r) => r.sessionKey,
    );
    expect(multiKeys).toEqual(["agent:main:eq-done", "agent:main:eq-failed"]);
  });
});
