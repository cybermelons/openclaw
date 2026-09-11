// Layer 0 of issue #118: a malformed or agent-less session key must never terminate the
// gateway. The three-ring invariant is verified here at its unit seams:
//   ring 1 - the resolver throws a typed, classifiable error (not a bare Error);
//   ring 3 - the process-rejection backstop classifies that error as non-fatal.
// Ring 2 (the dispatch-boundary map to a client error) is covered by the server-methods
// dispatch tests; this file guards the two rings that do not need a live gateway.
import { describe, expect, it } from "vitest";
import {
  isSqliteScopeResolutionError,
  resolveSqliteScopeFromSessionKey,
  resolveSqliteTranscriptScope,
  SqliteScopeResolutionError,
} from "../config/sessions/session-accessor.sqlite-scope.js";
import {
  getUnhandledSqliteScopeRejectionCount,
  isSqliteScopeResolutionRejection,
  isTransientUnhandledRejectionError,
  noteSuppressedSqliteScopeRejection,
  resetUnhandledSqliteScopeRejectionCountForTest,
} from "../infra/unhandled-rejections.js";

describe("issue #118 ring 1: resolver returns a typed scope error on client input", () => {
  it("returns a typed SqliteScopeResolutionError when no agent id can be resolved", () => {
    // An empty session key with no explicit agent id is the exact recurring caller bug.
    // After Layer 2 the session-key path returns a Result instead of throwing, so the
    // classifiable typed error reaches the caller without a bare throw.
    const result = resolveSqliteScopeFromSessionKey({ sessionKey: "" });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(isSqliteScopeResolutionError(result.error)).toBe(true);
      expect(result.error.code).toBe("invalid_session_key");
    }
  });

  it("throws SqliteScopeResolutionError when the transcript scope lacks a session key", () => {
    expect(() =>
      resolveSqliteTranscriptScope({ agentId: "main", sessionId: "abc", sessionKey: "" }),
    ).toThrow(SqliteScopeResolutionError);
  });
});

describe("issue #118 ring 3: the process backstop classifies the scope error as non-fatal", () => {
  it("classifies a thrown scope error as a suppressible rejection", () => {
    const error = new SqliteScopeResolutionError("no agent id");
    expect(isSqliteScopeResolutionRejection(error)).toBe(true);
    expect(isTransientUnhandledRejectionError(error)).toBe(true);
  });

  it("classifies a scope error nested in an AggregateError", () => {
    const nested = new AggregateError([new SqliteScopeResolutionError("no agent id")], "wrap");
    expect(isSqliteScopeResolutionRejection(nested)).toBe(true);
  });

  it("does not classify an unrelated error as a scope rejection", () => {
    expect(isSqliteScopeResolutionRejection(new Error("network down"))).toBe(false);
  });

  it("keeps the classifier predicate pure: calling it never increments the counter", () => {
    resetUnhandledSqliteScopeRejectionCountForTest();
    const error = new SqliteScopeResolutionError("no agent id");
    // The predicate is called directly by tests and at the handler. It must have no side effect.
    isTransientUnhandledRejectionError(error);
    isSqliteScopeResolutionRejection(error);
    expect(getUnhandledSqliteScopeRejectionCount()).toBe(0);
  });

  it("counts only rejections the handler actually absorbs", () => {
    resetUnhandledSqliteScopeRejectionCountForTest();
    noteSuppressedSqliteScopeRejection();
    noteSuppressedSqliteScopeRejection();
    expect(getUnhandledSqliteScopeRejectionCount()).toBe(2);
  });
});
