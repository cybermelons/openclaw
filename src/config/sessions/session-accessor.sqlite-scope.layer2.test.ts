// Layer 2 of issue #118: the single throwing resolver `resolveSqliteScope` is split into two
// entry points with different preconditions, so the compiler forces each caller to prove it
// holds either an explicit agent id or a real session key.
//   - resolveSqliteScopeForAgent(input): the caller holds the agent id. It never throws for a
//     missing agent. It throws a TypeError only for the programmer error of an empty agentId.
//   - resolveSqliteScopeFromSessionKey(input): the agent id is derived from the key. A malformed
//     or agent-less key returns { ok: false, error } and never throws.
import { describe, expect, it } from "vitest";
import {
  isSqliteScopeResolutionError,
  resolveSqliteScopeForAgent,
  resolveSqliteScopeFromSessionKey,
} from "./session-accessor.sqlite-scope.js";

describe("issue #118 Layer 2: resolveSqliteScopeForAgent", () => {
  it("resolves an agent-wide scope from an explicit agent id with no session key", () => {
    const scope = resolveSqliteScopeForAgent({ agentId: "main" });
    expect(scope.agentId).toBe("main");
    // No session key was given, so the agent-wide scope carries the empty key internally.
    expect(scope.sessionKey).toBe("");
  });

  it("resolves a scope from an explicit agent id and a session key", () => {
    const scope = resolveSqliteScopeForAgent({ agentId: "main", sessionKey: "agent:main:main" });
    expect(scope.agentId).toBe("main");
    expect(scope.sessionKey).toBe("agent:main:main");
  });

  it("throws a TypeError for the programmer error of an empty agentId", () => {
    expect(() => resolveSqliteScopeForAgent({ agentId: "" })).toThrow(TypeError);
  });

  it("rejects at compile time a call with a session key but no agent id", () => {
    // issue #118: the whole point of the split is that the compiler forces a caller with only a
    // session key to use resolveSqliteScopeFromSessionKey. This must not typecheck.
    // @ts-expect-error agentId is required; a session-key-only caller must use the other entry point.
    const callWithoutAgent = () => resolveSqliteScopeForAgent({ sessionKey: "agent:main:main" });
    expect(typeof callWithoutAgent).toBe("function");
  });
});

describe("issue #118 Layer 2: resolveSqliteScopeFromSessionKey", () => {
  it("resolves a scope from a well-formed session key", () => {
    const result = resolveSqliteScopeFromSessionKey({ sessionKey: "agent:main:main" });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.scope.agentId).toBe("main");
      expect(result.scope.sessionKey).toBe("agent:main:main");
    }
  });

  it("returns ok:false without throwing when the key has no resolvable agent id", () => {
    const result = resolveSqliteScopeFromSessionKey({ sessionKey: "" });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(isSqliteScopeResolutionError(result.error)).toBe(true);
      expect(result.error.code).toBe("invalid_session_key");
    }
  });
});
