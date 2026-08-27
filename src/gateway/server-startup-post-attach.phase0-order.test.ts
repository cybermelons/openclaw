/**
 * Phase-0 characterization: T-A2 startup ordering.
 *
 * Pins the current boot sequence of `startGatewayPostAttachRuntime` across
 * four real seams:
 *   markStartupOrphanedMainSessionsForRecovery -> startChannels ->
 *   scheduleRestartAbortedMainSessionRecovery -> unlockStartupMethods
 *
 * This file reuses the existing `server-startup-post-attach.test.ts` harness
 * (its `vi.hoisted` seam doubles, `vi.mock` wiring, and
 * `createPostAttachParams` / `createPostAttachRuntimeDeps` helpers) rather
 * than authoring a new boot harness. Deviation: this file cannot literally
 * import from the sibling `.test.ts` (test files are not meant to be
 * imported as modules and the sibling does not export its helpers), so the
 * minimal harness scaffolding is duplicated here at the same fidelity
 * (same `vi.mock` targets, same hoisted doubles, same `createPostAttach*`
 * default shapes) purely to observe call order; no new behavior is
 * exercised beyond what the sibling file already covers.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createCallOrderRecorder } from "../config/sessions/phase0-fixtures.test-support.js";
import type { PluginServicesHandle } from "../plugins/services.js";
import { resetGatewayWorkAdmission } from "../process/gateway-work-admission.js";
import { closeOpenClawStateDatabaseForTest } from "../state/openclaw-state-db.js";
import "./server-startup-outcomes.test-support.js";
import { createGatewayResidentRegistry } from "./server-resident-registry.js";

const hoisted = vi.hoisted(() => {
  const startPluginServices = vi.fn<
    (params: { onHandle?: (handle: PluginServicesHandle) => void }) => Promise<PluginServicesHandle>
  >(async () => ({ stop: async () => {} }));
  const startGmailWatcherWithLogs = vi.fn(async () => {});
  const loadInternalHooks = vi.fn(async () => 0);
  const setInternalHooksEnabled = vi.fn();
  const hasInternalHookListeners = vi.fn(() => false);
  const startupHookEvent = { type: "gateway", action: "startup", sessionKey: "gateway:startup" };
  const createInternalHookEvent = vi.fn(() => startupHookEvent);
  const triggerInternalHook = vi.fn(async () => {});
  const initializeGatewayUpdateStatus = vi.fn(async () => ({
    root: null,
    status: { root: null, installKind: "unknown" as const, packageManager: "unknown" as const },
    installReceipt: null,
  }));
  const scheduleGatewayUpdateCheck = vi.fn(() => () => {});
  const logGatewayStartup = vi.fn();
  const scheduleSubagentRegistrySweep = vi.fn();
  const markStartupOrphanedMainSessionsForRecovery = vi.fn(async () => ({
    marked: 0,
    skipped: 0,
  }));
  const scheduleRestartAbortedMainSessionRecovery = vi.fn();
  const scheduleRestartSentinelWake =
    vi.fn<typeof import("./server-restart-sentinel.js").scheduleRestartSentinelWake>();
  const refreshLatestUpdateRestartSentinel = vi.fn<
    typeof import("./server-restart-sentinel.js").refreshLatestUpdateRestartSentinel
  >(async () => null);
  const getAcpRuntimeBackend = vi.fn<(id?: string) => unknown>(() => null);
  const reconcilePendingSessionIdentities = vi.fn(async () => ({
    checked: 0,
    resolved: 0,
    failed: 0,
  }));
  const isCliProvider = vi.fn(() => false);
  const resolveConfiguredModelRef = vi.fn(() => ({
    provider: "openai",
    model: "gpt-5.4",
  }));
  const resolveHooksGmailModel = vi.fn<() => { provider: string; model: string } | null>(
    () => null,
  );
  const loadFullModelCatalog = vi.fn(async () => {
    throw new Error("full model catalog should not materialize");
  });
  const loadModelCatalog = vi.fn(async (_options?: unknown): Promise<unknown> => ({}));
  const getModelRefStatus = vi.fn(() => ({
    key: "openai/gpt-5.4",
    allowed: true,
    inCatalog: true,
  }));
  const prepareModelRuntimeSnapshot = vi.fn(async () => ({}));
  const refreshPreparedModelRuntimeSnapshots = vi.fn(
    async (_cfg?: unknown, _options?: unknown) => {},
  );
  const prewarmConfigDrivenReplyRuntime = vi.fn(async () => {});
  const prewarmContextWindowCacheAfterReady = vi.fn(async () => {});
  const scheduleGatewayHandlerPrewarm = vi.fn(() => ({ stop: vi.fn() }));
  const clearCurrentProviderAuthState = vi.fn();
  const warmCurrentProviderAuthStateOffMainThread = vi.fn(
    async (_cfg?: unknown, _options?: unknown) => {},
  );
  const setAuthProfileFailureHook = vi.fn();
  const transcriptsAutoStartService = {
    start: vi.fn(),
    stop: vi.fn(async () => {}),
  };
  const createTranscriptsAutoStartService = vi.fn(() => transcriptsAutoStartService);
  return {
    startPluginServices,
    startGmailWatcherWithLogs,
    loadInternalHooks,
    setInternalHooksEnabled,
    hasInternalHookListeners,
    startupHookEvent,
    createInternalHookEvent,
    triggerInternalHook,
    initializeGatewayUpdateStatus,
    scheduleGatewayUpdateCheck,
    logGatewayStartup,
    scheduleSubagentRegistrySweep,
    markStartupOrphanedMainSessionsForRecovery,
    scheduleRestartAbortedMainSessionRecovery,
    scheduleRestartSentinelWake,
    refreshLatestUpdateRestartSentinel,
    getAcpRuntimeBackend,
    reconcilePendingSessionIdentities,
    isCliProvider,
    resolveConfiguredModelRef,
    resolveHooksGmailModel,
    loadFullModelCatalog,
    loadModelCatalog,
    getModelRefStatus,
    prepareModelRuntimeSnapshot,
    refreshPreparedModelRuntimeSnapshots,
    prewarmConfigDrivenReplyRuntime,
    prewarmContextWindowCacheAfterReady,
    scheduleGatewayHandlerPrewarm,
    clearCurrentProviderAuthState,
    warmCurrentProviderAuthStateOffMainThread,
    setAuthProfileFailureHook,
    transcriptsAutoStartService,
    createTranscriptsAutoStartService,
  };
});

vi.mock("../agents/session-dirs.js", () => ({
  resolveAgentSessionDirs: vi.fn(async () => []),
}));

vi.mock("../agents/subagents/registry/subagent-registry.js", () => ({
  scheduleSubagentRegistrySweep: hoisted.scheduleSubagentRegistrySweep,
}));

vi.mock("../agents/main-session-recovery/main-session-restart-recovery-marking.js", () => ({
  markStartupOrphanedMainSessionsForRecovery: hoisted.markStartupOrphanedMainSessionsForRecovery,
}));

vi.mock("../agents/main-session-recovery/main-session-restart-recovery.js", () => ({
  scheduleRestartAbortedMainSessionRecovery: hoisted.scheduleRestartAbortedMainSessionRecovery,
}));

vi.mock("../config/paths.js", async () => {
  const actual = await vi.importActual<typeof import("../config/paths.js")>("../config/paths.js");
  return {
    ...actual,
    STATE_DIR: "/tmp/openclaw-state",
    resolveConfigPath: vi.fn(() => "/tmp/openclaw-state/openclaw.json"),
    resolveGatewayPort: vi.fn(() => 18789),
    resolveStateDir: vi.fn((env: NodeJS.ProcessEnv = process.env) =>
      env.OPENCLAW_STATE_DIR?.trim() ? actual.resolveStateDir(env) : "/tmp/openclaw-state",
    ),
  };
});

vi.mock("../hooks/gmail-watcher-lifecycle.js", () => ({
  startGmailWatcherWithLogs: hoisted.startGmailWatcherWithLogs,
}));

vi.mock("../hooks/internal-hooks.js", () => ({
  createInternalHookEvent: hoisted.createInternalHookEvent,
  hasInternalHookListeners: hoisted.hasInternalHookListeners,
  setInternalHooksEnabled: hoisted.setInternalHooksEnabled,
  triggerInternalHook: hoisted.triggerInternalHook,
}));

vi.mock("../hooks/loader.js", () => ({
  loadInternalHooks: hoisted.loadInternalHooks,
}));

vi.mock("../plugins/hook-runner-global.js", () => ({
  getGlobalHookRunner: vi.fn(() => null),
}));

vi.mock("../plugins/services.js", () => ({
  startPluginServices: hoisted.startPluginServices,
}));

vi.mock("../acp/control-plane/manager.js", () => ({
  getAcpSessionManager: vi.fn(() => ({
    reconcilePendingSessionIdentities: hoisted.reconcilePendingSessionIdentities,
  })),
}));

vi.mock("../acp/control-plane/manager.lifecycle.js", () => ({
  disposeAcpSessionManagerInstance: vi.fn(async () => undefined),
}));

vi.mock("../acp/runtime/registry.js", () => ({
  getAcpRuntimeBackend: hoisted.getAcpRuntimeBackend,
}));

vi.mock("./server-restart-sentinel.js", () => ({
  refreshLatestUpdateRestartSentinel: hoisted.refreshLatestUpdateRestartSentinel,
  scheduleRestartSentinelWake: hoisted.scheduleRestartSentinelWake,
}));

vi.mock("./server-startup-log.js", () => ({
  logGatewayStartup: hoisted.logGatewayStartup,
}));

vi.mock("../infra/update-startup.js", () => ({
  initializeGatewayUpdateStatus: hoisted.initializeGatewayUpdateStatus,
  scheduleGatewayUpdateCheck: hoisted.scheduleGatewayUpdateCheck,
}));

vi.mock("../agents/prepared-model-catalog.js", () => ({
  loadProviderScopedThinkingCatalog: vi.fn(async () => []),
  loadPreparedModelCatalog: hoisted.loadModelCatalog,
}));

vi.mock("../agents/model-selection.js", () => ({
  getModelRefStatus: hoisted.getModelRefStatus,
  isCliProvider: hoisted.isCliProvider,
  resolveConfiguredModelRef: hoisted.resolveConfiguredModelRef,
  resolveHooksGmailModel: hoisted.resolveHooksGmailModel,
}));

vi.mock("../agents/prepared-model-runtime.js", () => ({
  publishPreparedModelRuntimeSnapshot: hoisted.prepareModelRuntimeSnapshot,
  refreshPreparedModelRuntimeSnapshots: hoisted.refreshPreparedModelRuntimeSnapshots,
}));

vi.mock("../auto-reply/reply/get-reply-from-config.runtime.js", () => ({
  getReplyFromConfig: vi.fn(),
  prewarmConfigDrivenReplyRuntime: hoisted.prewarmConfigDrivenReplyRuntime,
}));
vi.mock("../agents/context.js", () => ({
  prewarmContextWindowCacheAfterReady: hoisted.prewarmContextWindowCacheAfterReady,
}));

vi.mock("./server-startup-handler-prewarm.js", () => ({
  scheduleGatewayHandlerPrewarm: hoisted.scheduleGatewayHandlerPrewarm,
}));

vi.mock("../agents/model-provider-auth.js", () => ({
  warmCurrentProviderAuthStateOffMainThread: hoisted.warmCurrentProviderAuthStateOffMainThread,
}));

vi.mock("../agents/model-provider-auth-state.js", () => ({
  clearCurrentProviderAuthState: hoisted.clearCurrentProviderAuthState,
}));

vi.mock("../agents/auth-profiles/failure-hook.js", () => ({
  setAuthProfileFailureHook: hoisted.setAuthProfileFailureHook,
}));

vi.mock("../agents/auth-profiles.js", async () => {
  const actual = await vi.importActual<typeof import("../agents/auth-profiles.js")>(
    "../agents/auth-profiles.js",
  );
  return {
    ...actual,
    setAuthProfileFailureHook: hoisted.setAuthProfileFailureHook,
  };
});

vi.mock("../agents/tools/transcripts-tool.js", () => ({
  createTranscriptsAutoStartService: hoisted.createTranscriptsAutoStartService,
}));

const {
  startGatewayPostAttachRuntime: startGatewayPostAttachRuntimeImpl,
  startGatewaySidecars: startGatewaySidecarsImpl,
} = await import("./server-startup-post-attach.js");

type PostAttachParams = Parameters<typeof startGatewayPostAttachRuntimeImpl>[0];
type PostAttachRuntimeDeps = NonNullable<Parameters<typeof startGatewayPostAttachRuntimeImpl>[1]>;

async function waitForGatewayTestState<T>(
  assertion: () => T | Promise<T>,
  options: { timeout?: number; interval?: number } = {},
): Promise<T> {
  return await vi.waitFor(assertion, { ...options, interval: 1 });
}

function createPostAttachRuntimeDeps(
  overrides: Partial<PostAttachRuntimeDeps> = {},
): PostAttachRuntimeDeps {
  return {
    getGlobalHookRunner: vi.fn(() => null),
    logGatewayStartup: hoisted.logGatewayStartup,
    refreshLatestUpdateRestartSentinel: hoisted.refreshLatestUpdateRestartSentinel,
    initializeGatewayUpdateStatus: hoisted.initializeGatewayUpdateStatus,
    scheduleGatewayUpdateCheck: hoisted.scheduleGatewayUpdateCheck,
    startGatewaySidecars: startGatewaySidecarsImpl,
    warmSystemCa: vi.fn(async () => {}),
    loadSubagentRegistrySweep: vi.fn(async () => hoisted.scheduleSubagentRegistrySweep),
    ...overrides,
  };
}

function createPostAttachParams(overrides: Partial<PostAttachParams> = {}): PostAttachParams {
  return {
    minimalTestGateway: false,
    cfgAtStart: { hooks: { internal: { enabled: false } } } as never,
    getConfig: () => ({ hooks: { internal: { enabled: false } } }) as never,
    bindHost: "127.0.0.1",
    bindHosts: ["127.0.0.1"],
    port: 18789,
    tlsEnabled: false,
    log: { info: vi.fn(), warn: vi.fn() },
    isNixMode: false,
    broadcastToConnIds: vi.fn(),
    getClientConnIds: () => new Set(),
    controlUiBasePath: "/",
    gatewayPluginConfigAtStart: { hooks: { internal: { enabled: false } } } as never,
    activationSourceConfig: { hooks: { internal: { enabled: false } } } as never,
    pluginManifestRecords: [],
    pluginRegistry: {
      plugins: [
        { id: "beta", status: "loaded" },
        { id: "alpha", status: "loaded" },
        { id: "cold", status: "disabled" },
        { id: "broken", status: "error" },
      ],
      typedHooks: [],
    } as never,
    defaultWorkspaceDir: "/tmp/openclaw-workspace",
    deps: {} as never,
    startChannels: vi.fn(async () => {}),
    recoveryRuntime: {
      dispatchAgent: vi.fn(),
      waitForAgent: vi.fn(),
      sendRecoveryNotice: vi.fn(),
    },
    logHooks: {
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
    },
    logChannels: {
      info: vi.fn(),
      error: vi.fn(),
    },
    unlockStartupMethods: vi.fn(),
    residentRegistry: createGatewayResidentRegistry(),
    providerAuthPrewarm: { enabled: false },
    unregisterGatewayLifetimeSidecar: vi.fn(),
    stopRegisteredPostReadySidecars: vi.fn(async () => {}),
    stopRegisteredGatewayLifetimeSidecars: vi.fn(async () => {}),
    ...overrides,
  };
}

describe("startGatewayPostAttachRuntime boot ordering (Phase-0 T-A2)", () => {
  const originalCleanupEnv = process.env.OPENCLAW_CLEANUP_TEST;

  beforeEach(() => {
    resetGatewayWorkAdmission();
    closeOpenClawStateDatabaseForTest();
    vi.stubEnv("OPENCLAW_SKIP_CHANNELS", "0");
    vi.stubEnv("OPENCLAW_SKIP_PROVIDERS", "0");
    vi.stubEnv("OPENCLAW_CLEANUP_TEST", "1");
    hoisted.markStartupOrphanedMainSessionsForRecovery.mockReset();
    hoisted.markStartupOrphanedMainSessionsForRecovery.mockResolvedValue({
      marked: 0,
      skipped: 0,
    });
    hoisted.scheduleRestartAbortedMainSessionRecovery.mockClear();
    hoisted.scheduleRestartAbortedMainSessionRecovery.mockReturnValue(undefined);
    hoisted.logGatewayStartup.mockClear();
  });

  afterEach(async () => {
    resetGatewayWorkAdmission();
    closeOpenClawStateDatabaseForTest();
    vi.unstubAllEnvs();
    if (originalCleanupEnv === undefined) {
      delete process.env.OPENCLAW_CLEANUP_TEST;
    } else {
      process.env.OPENCLAW_CLEANUP_TEST = originalCleanupEnv;
    }
  });

  it("T-A2: runs the boot sequence in main's fixed order — mark orphans, start channels, schedule restart recovery, unlock startup methods", async () => {
    const recorder = createCallOrderRecorder();

    hoisted.markStartupOrphanedMainSessionsForRecovery.mockImplementationOnce(async () => {
      recorder.record("markStartupOrphanedMainSessionsForRecovery");
      return { marked: 0, skipped: 0 };
    });
    const startChannels = vi.fn(async () => {
      recorder.record("startChannels");
    });
    hoisted.scheduleRestartAbortedMainSessionRecovery.mockImplementationOnce(() => {
      recorder.record("scheduleRestartAbortedMainSessionRecovery");
      return undefined;
    });
    const unlockStartupMethods = vi.fn(() => {
      recorder.record("unlockStartupMethods");
    });

    const runtime = startGatewayPostAttachRuntimeImpl(
      {
        ...createPostAttachParams({
          startChannels,
          unlockStartupMethods,
        }),
      },
      createPostAttachRuntimeDeps(),
    );

    await waitForGatewayTestState(
      () => {
        expect(unlockStartupMethods).toHaveBeenCalledTimes(1);
      },
      { timeout: 5000 },
    );
    await runtime;

    expect(recorder.order()).toEqual([
      "markStartupOrphanedMainSessionsForRecovery",
      "startChannels",
      "scheduleRestartAbortedMainSessionRecovery",
      "unlockStartupMethods",
    ]);
  });
});
