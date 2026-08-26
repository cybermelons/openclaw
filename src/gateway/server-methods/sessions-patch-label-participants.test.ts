import { afterEach, expect, test, vi } from "vitest";
import {
  loadSessionEntry,
  recordSessionParticipant,
  upsertSessionEntryCore,
} from "../../config/sessions/session-accessor.js";
import { closeOpenClawAgentDatabasesForTest } from "../../state/openclaw-agent-db.js";
import { withOpenClawTestState } from "../../test-utils/openclaw-test-state.js";
import { sessionMutationHandlers } from "./sessions-mutations.js";
import type { GatewayClient, GatewayRequestContext } from "./types.js";

afterEach(() => {
  closeOpenClawAgentDatabasesForTest();
});

function humanClient(): GatewayClient {
  return {
    authenticatedUserId: "label-reviewer@example.com",
    authenticatedUserProfile: {
      profileId: "label-reviewer",
      displayName: "Label Reviewer",
      hasAvatar: false,
      updatedAt: 1,
    },
    connect: {
      minProtocol: 1,
      maxProtocol: 1,
      client: { id: "openclaw-control-ui", version: "test", platform: "test", mode: "webchat" },
      role: "operator",
      scopes: ["operator.read", "operator.write", "operator.admin"],
    },
  };
}

function patchContext(): GatewayRequestContext {
  return {
    getRuntimeConfig: () => ({}),
    loadGatewayModelCatalog: vi.fn(async () => []),
    broadcastToConnIds: vi.fn(),
    getSessionEventSubscriberConnIds: () => new Set(),
    chatAbortControllers: new Map(),
    chatQueuedTurns: new Map(),
    dedupe: new Map(),
  } as unknown as GatewayRequestContext;
}

// A `label` patch needs store-wide label uniqueness, so it snapshots the whole
// store instead of taking the exact-key branch that `icon`/`pinned` use. Both
// sides of the replacement compare-and-swap must therefore read the row through
// the same projection: `session_participants` rows for a non-owner actor add
// `participants`/`participantCount` to the projected entry, and comparing a
// projected entry against an unprojected snapshot made every rename fail with
// "SQLite session entry changed before replacement".
test.each([
  {
    name: "human profile participant",
    actor: { type: "human" as const, id: "profile-second-reader" },
    source: "profile" as const,
  },
  {
    name: "agent participant",
    actor: { type: "agent" as const, id: "gateway-client" },
    source: "agent" as const,
  },
])("renames a session with a non-owner $name", async ({ actor, source }) => {
  await withOpenClawTestState({ scenario: "minimal" }, async (state) => {
    const sessionKey = `agent:main:label-${actor.type}-participant`;
    const scope = { agentId: "main", env: state.env, sessionKey };
    await upsertSessionEntryCore(scope, {
      sessionId: `session-label-${actor.type}-participant`,
      updatedAt: 1,
      createdActor: { type: "human", id: "profile-owner" },
    });
    recordSessionParticipant(scope, {
      actor,
      promptedAt: 10,
      sessionAgentId: "main",
      source,
    });

    // Guard the precondition: the projection must actually add a non-owner
    // participant, otherwise this test would pass for the wrong reason.
    expect(loadSessionEntry(scope)?.participantCount).toBe(1);
    expect(loadSessionEntry(scope)?.participants).toEqual([{ ...actor, source }]);

    const respond = vi.fn();
    await sessionMutationHandlers["sessions.patch"]!({
      params: { key: sessionKey, label: "Renamed session" },
      respond,
      context: patchContext(),
      client: humanClient(),
    } as never);

    expect(respond.mock.calls[0]?.[0]).toBe(true);
    expect(respond.mock.calls[0]?.[2]).toBeFalsy();
    expect(loadSessionEntry(scope)?.label).toBe("Renamed session");
    // The rename must not disturb the separately projected participant history.
    expect(loadSessionEntry(scope)?.participantCount).toBe(1);
  });
});
