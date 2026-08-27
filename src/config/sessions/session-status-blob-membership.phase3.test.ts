// Phase 3 CS-3 pin test (trap #1, §8c): `hasSessionEntriesByStatusReadOnly`
// gates restart recovery (a resume-class side effect). It returned a bare
// boolean straight from a `WHERE status IN (...)` COLUMN filter, so a stale or
// diverged `status` column could flip the probe true/false against the blob's
// real status. Fix: the column filter stays a cheap pre-narrow (index job), but
// the boolean is decided by the blob-sourced `entry.status` — a row whose
// column falsely claims membership must not move the probe.
//
// The sibling trap #1 fix in session-accessor.sqlite-lifecycle-state.ts
// (orphan-cleanup delete plan re-verifies plugin ownership against the owning
// node's blob) is exercised by the existing lifecycle.test.ts regression, which
// stays green with this changeset.
import { afterEach, describe, expect, it } from "vitest";
import { cleanupTempDirs, makeTempDir } from "../../../test/helpers/temp-dir.js";
import {
  closeOpenClawAgentDatabasesForTest,
  openOpenClawAgentDatabase,
} from "../../state/openclaw-agent-db.js";
import { closeOpenClawStateDatabaseForTest } from "../../state/openclaw-state-db.js";
import { hasSessionEntriesByStatusReadOnly, upsertSessionEntryCore } from "./session-accessor.js";

const tempDirs: string[] = [];

afterEach(() => {
  closeOpenClawAgentDatabasesForTest();
  closeOpenClawStateDatabaseForTest();
  cleanupTempDirs(tempDirs);
});

/** Rewrites only the `status` COLUMN (not the blob) so a test can force
 * column/blob divergence, then closes the handle so the read-only probe
 * re-opens the store fresh. */
function setColumnStatusOnly(
  agentId: string,
  env: NodeJS.ProcessEnv,
  sessionKey: string,
  status: string,
): void {
  openOpenClawAgentDatabase({ agentId, env })
    .db.prepare("UPDATE session_nodes SET status = ? WHERE session_key = ?")
    .run(status, sessionKey);
  closeOpenClawAgentDatabasesForTest();
}

describe("Phase 3 CS-3: hasSessionEntriesByStatusReadOnly probe is blob-truth", () => {
  it("T-P3-ZC-status-probe: a column diverged INTO a queried status must not flip the probe true", async () => {
    const stateDir = makeTempDir(tempDirs, "openclaw-phase3-status-probe-into-");
    const env = { OPENCLAW_STATE_DIR: stateDir };
    const agentId = "worker-1";
    const sessionKey = "agent:worker-1:main";

    // Blob says "done"; column agrees.
    await upsertSessionEntryCore(
      { agentId, env, sessionKey },
      { sessionId: "session-1", status: "done", updatedAt: 10 },
    );
    closeOpenClawAgentDatabasesForTest();

    // Clean baseline: probe reflects the blob status.
    expect(hasSessionEntriesByStatusReadOnly({ agentId, env }, ["done"])).toBe(true);
    expect(hasSessionEntriesByStatusReadOnly({ agentId, env }, ["running"])).toBe(false);

    // Diverge ONLY the column to a queried status; blob still says "done".
    setColumnStatusOnly(agentId, env, sessionKey, "running");

    // Column falsely claims "running"; the blob vetoes it. Restart recovery
    // must not treat this store as having a running session. This is the
    // guarantee: a column diverged INTO a queried status cannot flip the probe
    // true — the `status IN (...)` pre-narrow admits the row, then the
    // blob-sourced `entry.status` re-check rejects it.
    expect(hasSessionEntriesByStatusReadOnly({ agentId, env }, ["running"])).toBe(false);
  });

  it("equivalence half: on clean data the probe matches a plain column probe", async () => {
    const stateDir = makeTempDir(tempDirs, "openclaw-phase3-status-probe-clean-");
    const env = { OPENCLAW_STATE_DIR: stateDir };
    const agentId = "worker-2";

    await upsertSessionEntryCore(
      { agentId, env, sessionKey: "agent:worker-2:running" },
      { sessionId: "session-running", status: "running", updatedAt: 10 },
    );
    await upsertSessionEntryCore(
      { agentId, env, sessionKey: "agent:worker-2:done" },
      { sessionId: "session-done", status: "done", updatedAt: 20 },
    );
    closeOpenClawAgentDatabasesForTest();

    expect(hasSessionEntriesByStatusReadOnly({ agentId, env }, ["running"])).toBe(true);
    expect(hasSessionEntriesByStatusReadOnly({ agentId, env }, ["done"])).toBe(true);
    expect(hasSessionEntriesByStatusReadOnly({ agentId, env }, ["failed"])).toBe(false);
    expect(hasSessionEntriesByStatusReadOnly({ agentId, env }, ["running", "failed"])).toBe(true);
  });
});
