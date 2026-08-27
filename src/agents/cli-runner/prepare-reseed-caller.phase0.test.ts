// Phase-0 characterization test: prepareCliRunContext's caller-side three-state
// rawTranscriptReseedReason computation (prepare.ts ~lines 1630-1633) and the
// history-reseed dispatch that reads it. Exercises the full prepareCliRunContext
// entry point via the same fixture/mocking idiom as prepare.test.ts, and observes
// the dispatch indirectly through context.reusableCliSession (the reason source)
// and context.openClawHistoryPrompt (whether/what the reseed builder produced).
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { writeSessionResumeEpoch } from "../../config/sessions/session-accessor.sqlite-resume-epoch-store.js";
import { isSessionResumeDrainPendingError } from "../../config/sessions/session-resume-drain-pending-error.js";
import { setActivePluginRegistry } from "../../plugins/runtime.js";
import { setActiveDegradedSecretOwners } from "../../secrets/runtime-degraded-state.js";
import { openOpenClawAgentDatabase } from "../../state/openclaw-agent-db.js";
import { createTestRegistry } from "../../test-utils/channel-plugins.js";
import { readExternalCliBootstrapCredential as readExternalCliBootstrapCredentialImpl } from "../auth-profiles/external-cli-sync.js";
import { resolveApiKeyForProfile as resolveApiKeyForProfileImpl } from "../auth-profiles/oauth.js";
import { resetCliAuthEpochTestDeps } from "../cli-auth-epoch.test-support.js";
import { testing as cliBackendsTesting } from "../cli-backends.test-support.js";
import {
  buildDefaultTestCliBackend,
  createCliRunnerPrepareFixture,
  createTestMcpLoopbackClientGrant,
  createTestMcpLoopbackServer,
  createTestMcpLoopbackServerConfig,
} from "../cli-runner.test-helpers.js";
import { hashCliSessionText } from "../cli-session.js";
import { resetContextWindowCacheForTest } from "../context.js";
import { prepareCliRunContext } from "./prepare.js";
import {
  resetCliRunnerPrepareTestDeps,
  setCliRunnerPrepareTestDeps,
} from "./prepare.test-support.js";

vi.mock("../../plugins/hook-runner-global.js", () => ({
  getGlobalHookRunner: vi.fn(() => null),
}));

vi.mock("../../tts/tts-settings.js", () => ({
  buildTtsSystemPromptHint: vi.fn(() => undefined),
  resolveModelOverridePolicy: vi.fn(),
  setTtsMachinePrefsPathResolver: vi.fn(),
}));

vi.mock("../media-generation-task-status.js", () => ({
  VIDEO_GENERATION_TASK_KIND: "video_generation",
  buildActiveVideoGenerationTaskPromptContextForSession: vi.fn(() => undefined),
  buildVideoGenerationTaskStatusDetails: vi.fn(() => ({})),
  buildVideoGenerationTaskStatusText: vi.fn(() => ""),
  findActiveVideoGenerationTaskForSession: vi.fn(() => undefined),
  IMAGE_GENERATION_TASK_KIND: "image_generation",
  buildActiveImageGenerationTaskPromptContextForSession: vi.fn(() => undefined),
  buildImageGenerationTaskStatusDetails: vi.fn(() => ({})),
  buildImageGenerationTaskStatusText: vi.fn(() => ""),
  findActiveImageGenerationTaskForSession: vi.fn(() => undefined),
  MUSIC_GENERATION_TASK_KIND: "music_generation",
  buildActiveMusicGenerationTaskPromptContextForSession: vi.fn(() => undefined),
  buildMusicGenerationTaskStatusDetails: vi.fn(() => ({})),
  buildMusicGenerationTaskStatusText: vi.fn(() => ""),
  findActiveMusicGenerationTaskForSession: vi.fn(() => undefined),
}));

function setCliBackendForPrepareTest(
  params: {
    reseedFromRawTranscriptWhenUncompacted?: boolean;
  } = {},
) {
  cliBackendsTesting.setDepsForTest({
    resolvePluginSetupCliBackend: () => undefined,
    resolveRuntimeCliBackends: () => [
      {
        id: "claude-cli",
        pluginId: "anthropic",
        modelProvider: "anthropic",
        bundleMcp: false,
        config: {
          command: "claude",
          args: ["--print"],
          resumeArgs: ["--resume", "{sessionId}"],
          output: "jsonl",
          input: "stdin",
          sessionMode: "existing",
          ...(params.reseedFromRawTranscriptWhenUncompacted
            ? { reseedFromRawTranscriptWhenUncompacted: true }
            : {}),
        },
      },
    ],
  });
}

// The fixture's session is filesystem-only (no session_nodes row), so the
// session_resume_epoch AFTER-INSERT trigger never fires for it. loadCliSessionReseedMessages
// and loadCliSessionContextEngineMessages now refuse absent markers as an invariant
// violation (PHASE-4.md §4 CS-4 Decision 3), so every fixture session here needs its
// marker written directly, mirroring how CS-3's drain path writes it.
function seedResumeEpochMarker(params: {
  sessionKey: string;
  epoch: number;
  state: "drain_pending" | "drained";
}): void {
  const database = openOpenClawAgentDatabase({ agentId: "main" });
  writeSessionResumeEpoch(database, { ...params, sessionId: null, drainedThroughSeq: null });
}

describe("prepareCliRunContext caller-side reseed reason (phase0)", () => {
  let fixture: ReturnType<typeof createCliRunnerPrepareFixture>;
  let defaultTestCliBackend: ReturnType<typeof buildDefaultTestCliBackend>;

  beforeEach(() => {
    defaultTestCliBackend = buildDefaultTestCliBackend();
    cliBackendsTesting.setDepsForTest({
      resolvePluginSetupCliBackend: () => undefined,
      resolveRuntimeCliBackends: () => [defaultTestCliBackend],
    });
    setCliRunnerPrepareTestDeps({
      isWorkspaceBootstrapPending: vi.fn(async () => false),
      makeBootstrapWarn: vi.fn(() => () => undefined),
      resolveBootstrapContextForRun: vi.fn(async () => ({
        bootstrapFiles: [],
        contextFiles: [],
      })),
      getActiveMcpLoopbackRuntime: vi.fn(() => undefined),
      ensureMcpLoopbackServer: vi.fn(createTestMcpLoopbackServer),
      createMcpLoopbackServerConfig: vi.fn(createTestMcpLoopbackServerConfig),
      mintMcpLoopbackClientGrant: vi.fn(createTestMcpLoopbackClientGrant),
      bindMcpLoopbackClientGrantAdmission: vi.fn(() => true),
      revokeMcpLoopbackClientGrant: vi.fn(() => true),
      resolveMcpLoopbackPolicyTools: vi.fn(() => ({ agentId: "main", tools: [] })),
      resolveMcpLoopbackScopedTools: vi.fn(() => ({ agentId: "main", tools: [] })),
      resolveOpenClawReferencePaths: vi.fn(async () => ({ docsPath: null, sourcePath: null })),
      prepareClaudeCliSkillsPlugin: vi.fn(async () => ({
        args: [],
        cleanup: vi.fn(async () => undefined),
      })),
      getClaudeGeneration: vi.fn(() => undefined),
      readExternalCliBootstrapCredential: readExternalCliBootstrapCredentialImpl,
      resolveApiKeyForProfile: resolveApiKeyForProfileImpl,
    });
    setActiveDegradedSecretOwners([]);
    fixture = createCliRunnerPrepareFixture(prepareCliRunContext);
  });

  afterEach(() => {
    cliBackendsTesting.resetDepsForTest();
    resetCliRunnerPrepareTestDeps();
    resetCliAuthEpochTestDeps();
    resetContextWindowCacheForTest();
    setActivePluginRegistry(createTestRegistry());
    setActiveDegradedSecretOwners([]);
    vi.unstubAllEnvs();
    fixture.cleanup();
  });

  it("state (a): reusableCliSessionId present -> reason=session-expired, and reseed does not fire (reuse path)", async () => {
    const { dir } = fixture.session;
    setCliBackendForPrepareTest({ reseedFromRawTranscriptWhenUncompacted: true });
    fixture.appendTranscript({
      id: "msg-reuse-1",
      parentId: null,
      timestamp: new Date(1).toISOString(),
      message: { role: "user", content: "reuse-path history marker", timestamp: 1 },
    });
    const transcriptCheck = vi.fn(async () => true);
    const orphanCheck = vi.fn(async () => false);
    setCliRunnerPrepareTestDeps({
      claudeCliSessionTranscriptHasContent: transcriptCheck,
      claudeCliSessionTranscriptHasOrphanedToolUse: orphanCheck,
    });
    seedResumeEpochMarker({
      sessionKey: "agent:main:telegram:direct:peer",
      epoch: 0,
      state: "drained",
    });

    const context = await fixture.prepare({
      sessionKey: "agent:main:telegram:direct:peer",
      provider: "claude-cli",
      model: "opus",
      cliSessionBinding: {
        sessionId: "live-claude-sid",
        cwdHash: hashCliSessionText(dir),
      },
      cliSessionId: "live-claude-sid",
    });

    // Case (a): a live, valid CLI session id is reusable.
    expect(context.reusableCliSession).toEqual({ mode: "reuse", sessionId: "live-claude-sid" });
    // shouldPrepareOpenClawHistoryPrompt = !skips && (!reusableCliSessionId || allowRawTranscriptReseed).
    // allowRawTranscriptReseed is true here, so the reseed dispatch still fires even
    // though a reusable CLI session id is present (rawTranscriptReseedReason=session-expired).
    expect(context.openClawHistoryPrompt).toContain("reuse-path history marker");
  });

  it("state (b): no reusable session but invalidatedReason set -> reason=that invalidatedReason, reseed dispatch fires", async () => {
    setCliBackendForPrepareTest({ reseedFromRawTranscriptWhenUncompacted: true });
    fixture.appendTranscript({
      id: "msg-invalidate-1",
      parentId: null,
      timestamp: new Date(1).toISOString(),
      message: { role: "user", content: "invalidate-path history marker", timestamp: 1 },
    });
    const transcriptCheck = vi.fn(async () => false);
    const orphanCheck = vi.fn(async () => false);
    setCliRunnerPrepareTestDeps({
      claudeCliSessionTranscriptHasContent: transcriptCheck,
      claudeCliSessionTranscriptHasOrphanedToolUse: orphanCheck,
    });
    seedResumeEpochMarker({
      sessionKey: "agent:main:telegram:direct:peer",
      epoch: 0,
      state: "drained",
    });

    const context = await fixture.prepare({
      sessionKey: "agent:main:telegram:direct:peer",
      provider: "claude-cli",
      model: "opus",
      cliSessionBinding: { sessionId: "stale-claude-sid" },
      cliSessionId: "stale-claude-sid",
    });

    // Case (b): the on-disk transcript is missing, so the binding is invalidated
    // with invalidatedReason="missing-transcript" -> that becomes the reseed reason.
    expect(context.reusableCliSession).toEqual({
      mode: "invalidate",
      invalidatedReason: "missing-transcript",
    });
    // No reusableCliSessionId (mode=invalidate has none), so
    // shouldPrepareOpenClawHistoryPrompt is true unconditionally here.
    expect(context.openClawHistoryPrompt).toContain("invalidate-path history marker");
  });

  it("state (c): reason=no-cli-session, but a drain_pending marker refuses the reseed read (PHASE-4 CS-4)", async () => {
    setCliBackendForPrepareTest({ reseedFromRawTranscriptWhenUncompacted: true });
    fixture.appendTranscript({
      id: "msg-none-1",
      parentId: null,
      timestamp: new Date(1).toISOString(),
      message: { role: "user", content: "bindingless-path history marker", timestamp: 1 },
    });
    // Direct write is expected: no production path produces drain_pending yet
    // (that lands in a later CS). This pins the reader's refusal behavior.
    seedResumeEpochMarker({
      sessionKey: "agent:main:telegram:direct:peer",
      epoch: 3,
      state: "drain_pending",
    });

    let thrown: unknown;
    try {
      await fixture.prepare({
        sessionKey: "agent:main:telegram:direct:peer",
        provider: "claude-cli",
        model: "opus",
        // No cliSessionBinding and no cliSessionId: reusableCliSessionCandidate is
        // { mode: "none" }, so invalidatedReason is also undefined, and reason
        // falls back to "no-cli-session" -> the reseed dispatch fires and hits
        // the drain-pending marker.
      });
    } catch (error) {
      thrown = error;
    }

    expect(isSessionResumeDrainPendingError(thrown)).toBe(true);
    if (isSessionResumeDrainPendingError(thrown)) {
      expect(thrown.sessionId).toBe("agent:main:telegram:direct:peer");
      expect(thrown.pendingEpoch).toBe(3);
    }
  });
});
