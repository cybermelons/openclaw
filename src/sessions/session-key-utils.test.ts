// issue #124 Layer 1: malformedSessionKeyReason flags only a structurally broken agent-
// prefixed session key, so the gateway request boundary can reject it before dispatch while
// still letting legacy/alias keys (e.g. "main") through to default-agent resolution.
import { describe, expect, it } from "vitest";
import { malformedSessionKeyReason } from "./session-key-utils.js";

describe("malformedSessionKeyReason", () => {
  const malformedCases: Array<{
    input: string;
    reason: "missing_agent_id" | "missing_rest";
  }> = [
    { input: "agent:", reason: "missing_agent_id" },
    { input: "agent::x", reason: "missing_agent_id" },
    { input: "agent:main", reason: "missing_rest" },
  ];

  for (const { input, reason } of malformedCases) {
    it(`flags ${JSON.stringify(input)} with reason "${reason}"`, () => {
      expect(malformedSessionKeyReason(input)).toBe(reason);
    });
  }

  // "main" is a legacy/alias key, not a malformed one: toAgentStoreSessionKey
  // (routing/session-key.ts) scopes any non-"agent:"-prefixed key to the default agent by
  // design, so the boundary must let it through to that resolution.
  it('does not flag "main" (legacy/alias key resolved downstream)', () => {
    expect(malformedSessionKeyReason("main")).toBeUndefined();
  });

  // Empty input never starts with "agent:", so it is not flagged here. The gateway boundary
  // only calls this for a present, non-empty param (`if (rawSessionKey)`), so an empty string
  // is unreachable at that call site; this only documents the function's own behavior.
  it("does not flag an empty string", () => {
    expect(malformedSessionKeyReason("")).toBeUndefined();
  });

  it("does not flag a well-formed agent-scoped key", () => {
    expect(malformedSessionKeyReason("agent:main:x")).toBeUndefined();
  });

  it("does not flag mixed-case input, normalizing exactly like parseAgentSessionKey", () => {
    expect(malformedSessionKeyReason("Agent:Main:X")).toBeUndefined();
  });

  it("does not flag a multi-segment rest (e.g. channel-scoped session keys)", () => {
    expect(malformedSessionKeyReason("agent:main:signal:group:abc123")).toBeUndefined();
  });
});
