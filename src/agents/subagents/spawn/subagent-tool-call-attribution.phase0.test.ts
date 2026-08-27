// Phase-0 characterization: subagent tool-call attribution (#24 OQ1).
//
// Scope note: a full live gateway spawn is too heavy for a unit test. This exercises the
// real write-side attribution seam directly: recordAcpParentStreamEvents(), the function the
// production spawn path calls at src/agents/subagents/spawn/acp-spawn-parent-stream.ts:269
// (`recordAcpParentStreamEvents({ sessionId: childSessionId, events })`), where childSessionId
// is normalizeOptionalString(params.childSessionId) (:228), sourced from
// state.initializedSession.sessionId at acp-spawn.ts:579/:623. This is the same "child event
// gets stamped with sessionId: childSessionId" seam the brief documents; it stops short of
// driving a full live subagent turn end-to-end.
//
// Free observations (non-gating, recorded here):
// - TaskSummary.childSessionKey (src/tasks/task-domain-views.ts:33) is populated from
//   task.childSessionKey when present; the write-side call at acp-spawn.ts:578-588 always
//   supplies childSessionId from state.initializedSession.sessionId, so this field is expected
//   populated on a real spawn (not exercised directly at this unit scope).
// - subagent-spawn.ts:437 stamps recordSessionParticipantBestEffort with sessionKey: childSessionKey
//   (the child's own key), separate from the parentSessionKey/spawnedBy lineage columns tested in
//   parent-spawned-by-readback.phase0.test.ts.
import { afterEach, describe, expect, it } from "vitest";
import { executeSqliteQuerySync, getNodeSqliteKysely } from "../../../infra/kysely-sync.js";
import type { DB as OpenClawAgentKyselyDatabase } from "../../../state/openclaw-agent-db.generated.js";
import {
  closeOpenClawAgentDatabasesForTest,
  runOpenClawAgentWriteTransaction,
} from "../../../state/openclaw-agent-db.js";
import { withTestDir } from "../../../test-helpers/temp-dir.js";
import { recordAcpParentStreamEvents } from "./acp-parent-stream-store.sqlite.js";
import { listAcpParentStreamEventsForTest } from "./acp-parent-stream-store.sqlite.test-support.js";

describe("subagent tool-call event attribution", () => {
  afterEach(() => {
    closeOpenClawAgentDatabasesForTest();
  });

  // VERDICT: PASS. Determined empirically below — the write call stamps sessionId: childSessionId
  // unconditionally, and the child/parent rows partition cleanly by session_id in the same
  // per-agent database. No child-attributed event is visible under the parent's session id.
  it("stamps the child sessionId on the tool-call event and none lands under the parent", async () => {
    await withTestDir({ prefix: "openclaw-subagent-attribution-" }, async (stateDir) => {
      const options = {
        agentId: "codex",
        env: { ...process.env, OPENCLAW_STATE_DIR: stateDir },
      };
      const parentSessionId = "parent-session-1";
      const childSessionId = "child-session-1";
      const runId = "run-attribution-1";

      // Seed both parent and child session_nodes/session_windows rows, mirroring the real
      // spawn path where parent and child share one per-agent sqlite database.
      runOpenClawAgentWriteTransaction((database) => {
        const db = getNodeSqliteKysely<
          Pick<OpenClawAgentKyselyDatabase, "session_nodes" | "session_windows">
        >(database.db);
        for (const [sessionKey, sessionId] of [
          ["agent:codex:parent", parentSessionId],
          ["agent:codex:acp:child", childSessionId],
        ] as const) {
          executeSqliteQuerySync(
            database.db,
            db.insertInto("session_nodes").values({
              session_key: sessionKey,
              current_session_id: sessionId,
              entry_json: "{}",
              updated_at: 1,
            }),
          );
          executeSqliteQuerySync(
            database.db,
            db.insertInto("session_windows").values({
              session_id: sessionId,
              session_key: sessionKey,
              session_scope: "conversation",
              created_at: 1,
              updated_at: 1,
            }),
          );
        }
      }, options);

      // One tool-call event, run through the real write-side attribution seam: the production
      // call site passes sessionId: childSessionId (never the parent's session id).
      recordAcpParentStreamEvents({
        ...options,
        sessionId: childSessionId,
        runId,
        events: [
          {
            createdAt: 10,
            event: { kind: "tool_call", toolName: "bash", callId: "call-1" },
          },
        ],
      });

      const childEvents = listAcpParentStreamEventsForTest({
        ...options,
        sessionId: childSessionId,
        runId,
      });
      const parentEvents = listAcpParentStreamEventsForTest({
        ...options,
        sessionId: parentSessionId,
        runId,
      });

      // Two-sided assertion: event exists under the child, none under the parent/requester.
      expect(childEvents).toEqual([{ kind: "tool_call", toolName: "bash", callId: "call-1" }]);
      expect(parentEvents).toEqual([]);
    });
  });
});
