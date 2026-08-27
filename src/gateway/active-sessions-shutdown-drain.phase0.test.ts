// Phase-0 characterization: shutdown drain behavior-pinning tests (T-A1a/b/c).
//
// These tests observe and pin CURRENT `main` behavior of the shutdown drain
// seam at `drainActiveSessionsForShutdown` (2s session_end budget) and its
// interaction with the admission drain seam at
// `interruptSessionWorkAdmissions` (15s owner concept). Mock/setup idioms
// (vi.mock targets, hook-runner double shape, tracker seeding via
// `emitGatewaySessionStartPluginHook`) are copied from the sibling
// `drain-active-sessions-for-shutdown.test.ts` in this directory.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useTempSqliteSessionStore } from "../config/sessions/phase0-fixtures.test-support.js";
import { appendTranscriptEventsInTransaction } from "../config/sessions/session-accessor.sqlite-transcript-store.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { clearInternalHooks } from "../hooks/internal-hooks.js";
import {
  beginSessionWorkAdmission,
  interruptSessionWorkAdmissions,
} from "../sessions/session-lifecycle-admission.js";

type SessionEndHookEvent = {
  reason?: string;
  sessionId?: string;
  sessionKey?: string;
};

const runSessionEndMock = vi.fn(async (_eventValue: SessionEndHookEvent) => undefined);
const hasHooksMock = vi.fn((name: string) => name === "session_end");
const getGlobalHookRunnerMock = vi.fn(() => ({
  hasHooks: hasHooksMock,
  runSessionEnd: runSessionEndMock,
  runSessionStart: vi.fn(async () => undefined),
}));

vi.mock("../plugins/hook-runner-global.js", () => ({
  getGlobalHookRunner: getGlobalHookRunnerMock,
}));

vi.mock("./session-transcript-files.fs.js", () => ({
  extractGeneratedTranscriptSessionId: vi.fn(() => undefined),
  resolveStableSessionEndTranscript: vi.fn(() => ({
    sessionFile: undefined,
    transcriptArchived: false,
  })),
  archiveSessionTranscriptsDetailed: vi.fn(() => []),
}));

vi.mock("../auto-reply/reply/session-hooks.js", () => ({
  buildSessionEndHookPayload: vi.fn(
    (params: { sessionId: string; reason: string; sessionKey: string }) => ({
      event: { sessionId: params.sessionId, reason: params.reason, sessionKey: params.sessionKey },
      context: { sessionId: params.sessionId, reason: params.reason },
    }),
  ),
  buildSessionStartHookPayload: vi.fn(() => ({ event: {}, context: {} })),
}));

const { emitGatewaySessionStartPluginHook } = await import("./session-reset-service.js");
const { drainActiveSessionsForShutdown } = await import("./active-sessions-shutdown-drain.js");
const { forgetActiveSessionForShutdown, listActiveSessionsForShutdown } =
  await import("./active-sessions-shutdown-tracker.js");

const cfg: OpenClawConfig = {};

function trackSessionForShutdown(params: { sessionId: string; sessionKey?: string }): void {
  emitGatewaySessionStartPluginHook({
    cfg,
    sessionKey: params.sessionKey ?? "agent:main:main",
    sessionId: params.sessionId,
    storePath: "/tmp/store.json",
    agentId: "main",
  });
}

function clearTrackedSessions(): void {
  for (const entry of listActiveSessionsForShutdown()) {
    forgetActiveSessionForShutdown(entry.sessionId);
  }
}

beforeEach(() => {
  clearTrackedSessions();
  clearInternalHooks();
  runSessionEndMock.mockClear();
  runSessionEndMock.mockReset();
  runSessionEndMock.mockImplementation(async () => undefined);
  hasHooksMock.mockClear();
  hasHooksMock.mockImplementation((name: string) => name === "session_end");
});

afterEach(() => {
  clearTrackedSessions();
  clearInternalHooks();
});

describe("drainActiveSessionsForShutdown Phase-0 characterization", () => {
  const store = useTempSqliteSessionStore();

  it("T-A1a: persists an in-flight transcript append made from a session_end hook before drain resolves", async () => {
    const sessionId = "sess-transcript-a1a";
    const scope = {
      agentId: store.agentId,
      sessionKey: "agent:main:main",
      sessionId,
    };

    runSessionEndMock.mockImplementationOnce(async (event: SessionEndHookEvent) => {
      // Simulate a session_end plugin doing a transcript append during drain.
      appendTranscriptEventsInTransaction(store.database(), scope, [
        {
          type: "leaf",
          id: "a1a-leaf",
          parentId: null,
          message: { role: "assistant", content: `shutdown for ${event.sessionId}` },
        } as never,
      ]);
    });
    trackSessionForShutdown({ sessionId });

    const result = await drainActiveSessionsForShutdown({ reason: "shutdown" });

    expect(result.timedOut).toBe(false);
    expect(result.emittedSessionIds).toEqual([sessionId]);

    const row = store
      .database()
      .db.prepare("SELECT event_json FROM transcript_events WHERE session_id = ?")
      .get(sessionId) as { event_json: string } | undefined;

    // Observed on main: the drain awaits each session_end handler (see the
    // sibling drain test "awaits each session_end handler..."), so a
    // transcript append made synchronously inside the hook, within the 2s
    // default budget, is READABLE after drain resolves. Not a pinned bug —
    // this is the correct/expected behavior.
    expect(row).toBeDefined();
    expect(JSON.parse(row?.event_json ?? "null")).toMatchObject({ id: "a1a-leaf" });
  });

  it("T-A1b: honors the totalTimeoutMs budget when a session_end hook never resolves", async () => {
    runSessionEndMock.mockImplementationOnce(async () => {
      // Never resolves: pins the drain's bounded-wait behavior under a hung plugin.
      await new Promise<void>(() => {});
    });
    trackSessionForShutdown({ sessionId: "sess-hang-a1b" });

    const startedAt = Date.now();
    const result = await drainActiveSessionsForShutdown({
      reason: "shutdown",
      totalTimeoutMs: 150,
    });
    const elapsedMs = Date.now() - startedAt;

    expect(result.timedOut).toBe(true);
    expect(result.emittedSessionIds).toEqual(["sess-hang-a1b"]);
    // Budget + generous scheduler slack; asserts the race resolves near the
    // configured budget rather than waiting for the hung hook.
    expect(elapsedMs).toBeLessThan(150 + 2000);
    // The un-drained turn's hook call was still started (fire class: started
    // but never awaited to completion) — the drain does not cancel it.
    expect(runSessionEndMock).toHaveBeenCalledTimes(1);
  });

  it("T-A1c: nested drain — an active session_end drain does not block or get blocked by a concurrent admission drain", async () => {
    let releaseSessionEnd: (() => void) | undefined;
    const sessionEndLatch = new Promise<void>((resolve) => {
      releaseSessionEnd = resolve;
    });
    runSessionEndMock.mockImplementationOnce(async () => {
      await sessionEndLatch;
    });
    trackSessionForShutdown({ sessionId: "sess-nested-a1c" });

    // Start a concurrent admission (15s owner concept) whose onInterrupt
    // deliberately does NOT release the lease — modeling work that ignores
    // the interrupt signal — while the session_end drain (2s budget) is
    // also in flight.
    const admissionScope = "gateway:root:nested-a1c";
    const admissionIdentities = ["nested-admission-a1c"];
    const admission = await beginSessionWorkAdmission({
      scope: admissionScope,
      identities: admissionIdentities,
      assertAllowed: () => {},
    });

    const sessionEndDrainPromise = drainActiveSessionsForShutdown({
      reason: "shutdown",
      totalTimeoutMs: 150,
    });
    const admissionDrainPromise = interruptSessionWorkAdmissions({
      scope: admissionScope,
      identities: admissionIdentities,
      timeoutMs: 150,
    });

    const [sessionEndResult, admissionDrainReleased] = await Promise.all([
      sessionEndDrainPromise,
      admissionDrainPromise,
    ]);

    // Observed on main: the two drains are independent budget trees — the
    // session_end drain (2s family) times out on its own 150ms budget
    // without waiting on the admission drain, and the admission drain
    // (15s family) also times out on its own 150ms budget (the admission
    // was interrupted but its owner never released the lease within the
    // window). Neither composes with nor blocks the other; they race
    // independently.
    // PINNED-BUG: #18 Phase 6 — no shared/composed budget tree exists
    // between the session_end (2s) and admission (15s) drain families;
    // this is the Phase-6 baseline this test locks in.
    expect(sessionEndResult.timedOut).toBe(true);
    expect(admissionDrainReleased).toBe(false);

    releaseSessionEnd?.();
    admission.release();
  });
});
