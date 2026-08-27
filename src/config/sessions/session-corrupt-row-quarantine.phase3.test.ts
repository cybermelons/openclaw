// Phase 3 CS-5 — T-P3-SCR (PHASE-3.md §6.2): self-contained-record extension.
// For each moved reader (readSessionEntriesByStatus,
// hasSessionEntriesByStatusReadOnly, listSessionEntriesReadOnly), corrupt
// one row's entry_json directly, drive the reader, and prove:
//   - the reader's ACTUAL current behavior on a corrupt row (silent skip,
//     verified per file:line below — no reader in this set re-throws), and
//   - a sibling VALID row in the same store is still returned correctly,
//     proving single-row judgment with no cross-row poisoning.
//
// Actual behavior verified by reading the source (not invented):
//   - readSessionEntriesByStatus (session-accessor.sqlite-status.ts:48-63):
//     `.flatMap` catches `SessionRowCorruptError` from `projectSessionEntry`
//     and returns `[]` for that row (silent skip), rethrows anything else.
//   - hasSessionEntriesByStatusReadOnly (session-accessor.sqlite-entry.ts:334-347):
//     per-row `for` loop catches `SessionRowCorruptError` and `continue`s
//     past the corrupt row (silent skip), rethrows anything else.
//   - listSessionEntriesReadOnly (session-accessor.sqlite-entry.ts:277-286)
//     is DIFFERENT: listSqliteSessionEntriesFromDatabase first calls
//     assertCanonicalSqliteSessionKeysCurrent (session-canonical-key.ts:124-176),
//     a connection-level full-table scan that hard-throws
//     SessionCanonicalKeyMigrationRequiredError on any unparseable
//     entry_json row. This fires BEFORE loadSessionEntrySnapshot's own
//     per-row try/catch(isSessionRowCorruptError) skip
//     (session-accessor.sqlite-entry-cache.ts:199-208) is ever reached, so
//     for THIS reader the corrupt row is not silently skipped — the whole
//     call throws. This is the reader's real, current behavior; the test
//     below asserts that throw rather than inventing a silent-skip result.
// The first two readers quarantine at the single `projectSessionEntry`
// throw boundary (session-entry-parse.ts:106-111,
// `recordOpenClawSessionRowQuarantine`) and never propagate the corrupt-row
// error out to the caller.
import { afterEach, describe, expect, it } from "vitest";
import { cleanupTempDirs, makeTempDir } from "../../../test/helpers/temp-dir.js";
import { openOpenClawAgentDatabase } from "../../state/openclaw-agent-db.js";
import { closeOpenClawAgentDatabasesForTest } from "../../state/openclaw-agent-db.js";
import { closeOpenClawStateDatabaseForTest } from "../../state/openclaw-state-db.js";
import {
  hasSessionEntriesByStatusReadOnly,
  listSessionEntriesReadOnly,
  upsertSessionEntryCore,
} from "./session-accessor.js";
import { readSessionEntriesByStatus } from "./session-accessor.sqlite-status.js";
import { isCanonicalSessionKeyMigrationRequiredError } from "./session-canonical-key.js";

const tempDirs: string[] = [];

afterEach(() => {
  closeOpenClawAgentDatabasesForTest();
  closeOpenClawStateDatabaseForTest();
  cleanupTempDirs(tempDirs);
});

async function seedCorruptAndValidRows(env: NodeJS.ProcessEnv): Promise<{
  agentId: string;
  corruptKey: string;
  validKey: string;
}> {
  const agentId = "main";
  const corruptKey = "agent:main:scr-corrupt";
  const validKey = "agent:main:scr-valid";

  await upsertSessionEntryCore(
    { agentId, env, sessionKey: corruptKey },
    { sessionId: "corrupt-session", status: "running", updatedAt: 10 },
  );
  await upsertSessionEntryCore(
    { agentId, env, sessionKey: validKey },
    { sessionId: "valid-session", status: "running", updatedAt: 10 },
  );

  const database = openOpenClawAgentDatabase({ agentId, env });
  // Raw entry_json UPDATE resets entry_valid to 0 via the
  // session_nodes_entry_valid_after_entry_update trigger (a stale-row
  // signal distinct from blob corruption). Re-stamping entry_valid = 1
  // afterwards mirrors the pattern in session-accessor.readonly.test.ts
  // ("rejects stale valid projections..."): it isolates the blob-corruption
  // case from the separate canonical-key staleness gate, so the moved
  // readers' own corrupt-row handling is what's under test here.
  database.db
    .prepare("UPDATE session_nodes SET entry_json = ? WHERE session_key = ?")
    .run("{not valid", corruptKey);
  database.db
    .prepare("UPDATE session_nodes SET entry_valid = 1 WHERE session_key = ?")
    .run(corruptKey);
  closeOpenClawAgentDatabasesForTest();

  return { agentId, corruptKey, validKey };
}

describe("Phase 3 T-P3-SCR — corrupt-row quarantine per moved reader", () => {
  it("readSessionEntriesByStatus silently skips the corrupt row and still returns the valid sibling", async () => {
    const stateDir = makeTempDir(tempDirs, "openclaw-phase3-scr-status-");
    const env = { OPENCLAW_STATE_DIR: stateDir };
    const { agentId, corruptKey, validKey } = await seedCorruptAndValidRows(env);

    const database = openOpenClawAgentDatabase({ agentId, env });
    const results = readSessionEntriesByStatus(database, ["running"]);

    expect(results.some((row) => row.sessionKey === corruptKey)).toBe(false);
    const valid = results.find((row) => row.sessionKey === validKey);
    expect(valid?.entry.status).toBe("running");
  });

  it("hasSessionEntriesByStatusReadOnly silently skips the corrupt row and still proves the valid sibling exists", async () => {
    const stateDir = makeTempDir(tempDirs, "openclaw-phase3-scr-has-status-");
    const env = { OPENCLAW_STATE_DIR: stateDir };
    const { agentId } = await seedCorruptAndValidRows(env);
    closeOpenClawAgentDatabasesForTest();

    // Must not throw despite the corrupt row: the valid sibling still
    // satisfies the predicate.
    expect(hasSessionEntriesByStatusReadOnly({ agentId, env }, ["running"])).toBe(true);
  });

  it("listSessionEntriesReadOnly's actual behavior: assertCanonicalSqliteSessionKeysCurrent hard-throws before the per-row quarantine loop runs", async () => {
    // Different from the other two moved readers: listSessionEntriesReadOnly
    // -> listSqliteSessionEntriesFromDatabase first calls
    // assertCanonicalSqliteSessionKeysCurrent (session-accessor.sqlite-entry.ts:358),
    // which does its own full-table parse-and-validate scan
    // (session-canonical-key.ts:158-175) and throws
    // SessionCanonicalKeyMigrationRequiredError on ANY unparseable
    // entry_json row, BEFORE loadSessionEntrySnapshot's per-row
    // try/catch(isSessionRowCorruptError) quarantine loop
    // (session-accessor.sqlite-entry-cache.ts:199-208) is ever reached.
    // This is a stricter connection-level boundary, not a silent skip —
    // asserting the invented "silent skip" behavior here would be wrong.
    const stateDir = makeTempDir(tempDirs, "openclaw-phase3-scr-list-");
    const env = { OPENCLAW_STATE_DIR: stateDir };
    const { agentId } = await seedCorruptAndValidRows(env);
    closeOpenClawAgentDatabasesForTest();

    let caught: unknown;
    try {
      listSessionEntriesReadOnly({ agentId, env });
    } catch (error) {
      caught = error;
    }
    expect(isCanonicalSessionKeyMigrationRequiredError(caught)).toBe(true);
  });
});
