// Fixture for openclaw-boundaries/no-sqlite-empty-session-key (issue #118).
// The rule must flag an object literal with `sessionKey: ""` passed to a SQLite scope call. It must
// NOT flag an unrelated `sessionKey: ""` in a return value or a plain, non-scope object.

declare function resolveSqliteAccessScope(scope: { agentId?: string; sessionKey: string }): unknown;
declare function resolveSqliteScopeForAgent(input: {
  agentId: string;
  sessionKey?: string;
}): unknown;
declare function upsertSessionEntryCore(
  scope: { agentId: string; sessionKey: string },
  patch: unknown,
): unknown;
declare function unrelatedHelper(value: { sessionKey: string }): unknown;

// Violation 1: empty session key passed to a scope resolver.
resolveSqliteAccessScope({ agentId: "main", sessionKey: "" });

// Violation 2: empty session key passed through the explicit-agent entry point.
resolveSqliteScopeForAgent({ agentId: "main", sessionKey: "" });

// Violation 3: empty session key passed to a session-entry upsert.
upsertSessionEntryCore({ agentId: "main", sessionKey: "" }, { sessionId: "x", updatedAt: 1 });

// Not a violation: a real session key at a scope call.
resolveSqliteAccessScope({ agentId: "main", sessionKey: "agent:main:main" });

// Not a violation: `sessionKey: ""` in a plain return value, not a scope call.
export function nothingEnqueued(): { enqueued: boolean; sessionKey: string } {
  return { enqueued: false, sessionKey: "" };
}

// Not a violation: `sessionKey: ""` passed to an unrelated (non-scope) function.
unrelatedHelper({ sessionKey: "" });
