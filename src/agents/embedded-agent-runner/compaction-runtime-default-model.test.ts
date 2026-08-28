import { describe, expect, it } from "vitest";
import type { OpenClawConfig } from "../../config/types.js";
import { resolveDefaultModelForAgent } from "../model-selection-config.js";
import { buildAgentSystemPrompt } from "../system-prompt.js";

// Issue #32: the compaction runtime line dropped `default_model=`, so the post-compaction
// prompt prefix diverged from the pre-compaction one and re-busted the prompt cache.
// `buildPreparedCompactionRuntime` now resolves the agent default and passes it as
// `runtimeInfo.defaultModel`; these pin the two halves of that wiring.
describe("compaction runtime line carries default_model (#32)", () => {
  const config = {
    agents: {
      defaults: { model: { primary: "anthropic/claude-opus-4-5" } },
    },
  } as unknown as OpenClawConfig;

  it("resolves the agent default model ref the compaction runtime passes through", () => {
    const ref = resolveDefaultModelForAgent({ cfg: config, agentId: "main" });
    expect(`${ref.provider}/${ref.model}`).toBe("anthropic/claude-opus-4-5");
  });

  it("renders default_model= when the runtime info supplies it", () => {
    const ref = resolveDefaultModelForAgent({ cfg: config, agentId: "main" });
    const prompt = buildAgentSystemPrompt({
      workspaceDir: "/tmp/openclaw",
      runtimeInfo: {
        agentId: "main",
        model: "anthropic/claude-sonnet-4-5",
        defaultModel: `${ref.provider}/${ref.model}`,
      },
      defaultThinkLevel: "low",
    });
    expect(prompt).toContain("default_model=anthropic/claude-opus-4-5");
  });

  it("omits default_model= when the runtime info lacks it (the #32 regression shape)", () => {
    const prompt = buildAgentSystemPrompt({
      workspaceDir: "/tmp/openclaw",
      runtimeInfo: {
        agentId: "main",
        model: "anthropic/claude-sonnet-4-5",
      },
      defaultThinkLevel: "low",
    });
    expect(prompt).not.toContain("default_model=");
  });
});
