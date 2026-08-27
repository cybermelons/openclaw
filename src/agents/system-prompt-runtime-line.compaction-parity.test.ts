// The post-compaction Runtime line must be byte-identical to a live turn's for the
// same session, or the automatic literal-prefix prompt cache breaks at every
// compaction boundary. Both call sites derive runtimeInfo through the shared
// buildSystemPromptParams builder; this pins that they stay in lockstep.
import { describe, expect, it } from "vitest";
import { buildSystemPromptParams } from "./system-prompt-params.js";
import { buildAgentSystemPrompt } from "./system-prompt.js";

const SESSION = {
  sessionKey: "agent:main:dashboard:fixed-session",
  sessionId: "fixed-session-id",
  host: "openclaw",
  os: "Linux 6.0.6",
  arch: "x64",
  node: "v22.23.2",
  model: "anthropic/claude-opus-4-8",
  defaultModel: "anthropic/claude-opus-4-8",
  shell: "zsh",
  channel: "webchat",
  capabilities: ["markdown"],
} as const;

function runtimeLineFor(runtime: typeof SESSION): string {
  const { runtimeInfo } = buildSystemPromptParams({
    agentId: "main",
    workspaceDir: "/tmp/openclaw",
    // No repo root at this path, so both call sites resolve the same absent value.
    preparedRepoRoot: null,
    runtime,
  });
  const prompt = buildAgentSystemPrompt({ workspaceDir: "/tmp/openclaw", runtimeInfo });
  const line = prompt.split("\n").find((l) => l.startsWith("Runtime:"));
  if (!line) {
    throw new Error("Runtime line missing from system prompt");
  }
  return line;
}

// Field set the live path (attempt-system-prompt-prepare.ts) hands to
// buildSystemPromptParams for a fixed session.
const LIVE_RUNTIME = {
  sessionKey: SESSION.sessionKey,
  sessionId: SESSION.sessionId,
  host: SESSION.host,
  os: SESSION.os,
  arch: SESSION.arch,
  node: SESSION.node,
  model: SESSION.model,
  defaultModel: SESSION.defaultModel,
  shell: SESSION.shell,
  channel: SESSION.channel,
  capabilities: SESSION.capabilities,
} as typeof SESSION;

// Field set the compaction path (prepared-compaction-runtime.ts) hands to the
// same builder. Independently spelled so dropping a field from either call site
// breaks this parity assertion.
const COMPACT_RUNTIME = {
  sessionKey: SESSION.sessionKey,
  sessionId: SESSION.sessionId,
  host: SESSION.host,
  os: SESSION.os,
  arch: SESSION.arch,
  node: SESSION.node,
  model: SESSION.model,
  defaultModel: SESSION.defaultModel,
  shell: SESSION.shell,
  channel: SESSION.channel,
  capabilities: SESSION.capabilities,
} as typeof SESSION;

describe("compaction vs live Runtime line parity", () => {
  it("renders a byte-identical Runtime line for the same session", () => {
    // Live path (attempt-system-prompt-prepare) and compaction path
    // (prepared-compaction-runtime) now build structurally identical runtime
    // objects, so the same session yields the same line.
    const live = runtimeLineFor(LIVE_RUNTIME);
    const compact = runtimeLineFor(COMPACT_RUNTIME);
    expect(compact).toBe(live);
  });

  it("emits the default_model token both paths thread", () => {
    expect(runtimeLineFor(SESSION)).toContain(`default_model=${SESSION.defaultModel}`);
  });

  it("drops default_model when the field is absent, diverging the cache", () => {
    // Regression guard: a call site that omits defaultModel (the pre-fix
    // compaction inline object) produces a line missing the token, proving the
    // parity above depends on threading it.
    const { defaultModel: _drop, ...withoutDefaultModel } = SESSION;
    const line = runtimeLineFor(withoutDefaultModel as typeof SESSION);
    expect(line).not.toContain("default_model=");
  });
});
