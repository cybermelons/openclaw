// Phase-0 characterization: parentSessionKey vs spawnedBy write/read-back seam.
// #18 keeps this green (item #7 behavior-preserving); only #24 flips it in its own PR
// as the visible marker of seam-ownership transfer.
//
// Write side (session-accessor.sqlite-session-row.ts bindSessionNode, ~:104-106):
//   parent_session_key = normalizeText(entry.parentSessionKey) ?? normalizeText(entry.spawnedBy)
//   spawned_by = normalizeText(entry.spawnedBy)
// Read side (session-accessor.sqlite-canonical-inventory.ts hydrateCanonicalRepairEntry, ~:84-87):
//   spawnedBy present when row.spawned_by set
//   parentSessionKey present ONLY when row.parent_session_key !== row.spawned_by
// So when parentSessionKey == spawnedBy on write, read-back drops parentSessionKey (lossy by design).
// NOTE: for a normal valid row, loadSessionEntry / listSqliteSessionEntriesWithCanonicalOwnerEvidence
// return the persisted entry_json blob verbatim (parentSessionKey survives even when == spawnedBy) —
// the collapse in hydrateCanonicalRepairEntry only fires on the doctor malformed-row repair path,
// i.e. when entry_json fails to parse. We force that path here with a raw entry_json corruption,
// matching the idiom at src/commands/doctor-session-canonical-keys.test.ts:739 ("entry_json = 'not-json'").
import { describe, expect, it } from "vitest";
import { openOpenClawAgentDatabase } from "../../state/openclaw-agent-db.js";
import { useTempSessionsFixture } from "./phase0-fixtures.test-support.js";
import { upsertSessionEntryCore } from "./session-accessor.js";
import { listSqliteSessionEntriesWithCanonicalOwnerEvidence } from "./session-accessor.sqlite-canonical-inventory.js";
import { resolveSqliteTargetFromSessionStorePath } from "./session-sqlite-target.js";

function corruptEntryJson(storePath: string, sessionKey: string): void {
  const target = resolveSqliteTargetFromSessionStorePath(storePath, { agentId: "main" });
  const database = openOpenClawAgentDatabase({ agentId: "main", path: target.path });
  database.db
    .prepare(`UPDATE session_nodes SET entry_json = 'not-json' WHERE session_key = ?`)
    .run(sessionKey);
}

function readBack(storePath: string, sessionKey: string) {
  const rows = listSqliteSessionEntriesWithCanonicalOwnerEvidence({ agentId: "main", storePath });
  return rows.find((row) => row.sessionKey === sessionKey);
}

describe("parent_session_key / spawned_by canonical-repair read-back seam", () => {
  const fixture = useTempSessionsFixture("openclaw-parent-spawned-by-");

  it("drops parentSessionKey on repair read-back when it equals spawnedBy on write", async () => {
    const storePath = fixture.storePath();
    const sessionKey = "agent:main:child-equal";

    await upsertSessionEntryCore(
      { agentId: "main", sessionKey, storePath },
      {
        sessionId: "child-equal",
        parentSessionKey: "agent:main:parent",
        spawnedBy: "agent:main:parent",
        updatedAt: 10,
      },
    );
    corruptEntryJson(storePath, sessionKey);

    const found = readBack(storePath, sessionKey);
    expect(found?.entry.spawnedBy).toBe("agent:main:parent");
    expect(found?.entry.parentSessionKey).toBeUndefined();
  });

  it("keeps both parentSessionKey and spawnedBy on repair read-back when they differ", async () => {
    const storePath = fixture.storePath();
    const sessionKey = "agent:main:child-differ";

    await upsertSessionEntryCore(
      { agentId: "main", sessionKey, storePath },
      {
        sessionId: "child-differ",
        parentSessionKey: "agent:main:grandparent",
        spawnedBy: "agent:main:parent",
        updatedAt: 10,
      },
    );
    corruptEntryJson(storePath, sessionKey);

    const found = readBack(storePath, sessionKey);
    expect(found?.entry.spawnedBy).toBe("agent:main:parent");
    expect(found?.entry.parentSessionKey).toBe("agent:main:grandparent");
  });
});
