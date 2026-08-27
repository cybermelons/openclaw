import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { CURRENT_SESSION_VERSION } from "openclaw/plugin-sdk/agent-sessions";
import { describe, expect, it } from "vitest";
import { writeSessionResumeEpoch } from "../../config/sessions/session-accessor.sqlite-resume-epoch-store.js";
import { isSessionResumeDrainPendingError } from "../../config/sessions/session-resume-drain-pending-error.js";
import { openOpenClawAgentDatabase } from "../../state/openclaw-agent-db.js";
import { withEnvAsync } from "../../test-utils/env.js";
import {
  hasCliSessionTranscript,
  loadCliSessionContextEngineMessages,
  loadCliSessionHistoryMessages,
  loadCliSessionReseedMessages,
} from "./session-history.js";

// Phase-4 CS-4 (T-P4-CS4) — resume/reseed readers refuse a drain-pending
// session_resume_epoch marker; non-resume readers tolerate it. Mirrors the
// CS-2 marker-store test harness (session-accessor.sqlite-resume-epoch-store.test.ts)
// and the fixture idiom in session-history.test.ts.

async function withCliSessionState<T>(stateDir: string, run: () => Promise<T>): Promise<T> {
  return await withEnvAsync({ OPENCLAW_STATE_DIR: stateDir }, run);
}

function createSessionTranscript(params: {
  rootDir: string;
  sessionId: string;
  agentId?: string;
  messages?: string[];
}): string {
  const sessionFile = path.join(
    params.rootDir,
    "agents",
    params.agentId ?? "main",
    "sessions",
    `${params.sessionId}.jsonl`,
  );
  fs.mkdirSync(path.dirname(sessionFile), { recursive: true });
  fs.writeFileSync(
    sessionFile,
    `${JSON.stringify({
      type: "session",
      version: CURRENT_SESSION_VERSION,
      id: params.sessionId,
      timestamp: new Date(0).toISOString(),
      cwd: params.rootDir,
    })}\n`,
    "utf-8",
  );
  for (const [index, message] of (params.messages ?? []).entries()) {
    fs.appendFileSync(
      sessionFile,
      `${JSON.stringify({
        type: "message",
        id: `msg-${index}`,
        parentId: index > 0 ? `msg-${index - 1}` : null,
        timestamp: new Date(index + 1).toISOString(),
        message: {
          role: "user",
          content: message,
          timestamp: index + 1,
        },
      })}\n`,
      "utf-8",
    );
  }
  return sessionFile;
}

function setResumeEpochMarker(params: {
  agentId?: string;
  sessionKey: string;
  epoch: number;
  state: "drain_pending" | "drained";
}): void {
  const database = openOpenClawAgentDatabase({ agentId: params.agentId ?? "main" });
  writeSessionResumeEpoch(database, {
    sessionKey: params.sessionKey,
    epoch: params.epoch,
    state: params.state,
  });
}

describe("Phase-4 CS-4 resume-drain-pending refusal (T-P4-CS4)", () => {
  it("loadCliSessionReseedMessages throws SessionResumeDrainPendingError fast (no internal retry) when the marker is drain_pending, then succeeds with the drained tail once committed", async () => {
    const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-cli-state-"));
    const sessionFile = createSessionTranscript({
      rootDir: stateDir,
      sessionId: "session-resume-drain",
      messages: ["earlier turn", "later turn"],
    });
    const sessionKey = "agent:main:main";

    try {
      await withCliSessionState(stateDir, async () => {
        setResumeEpochMarker({ sessionKey, epoch: 3, state: "drain_pending" });

        const start = Date.now();
        let thrown: unknown;
        try {
          await loadCliSessionReseedMessages({
            sessionId: "session-resume-drain",
            sessionFile,
            sessionKey,
            agentId: "main",
            allowRawTranscriptReseed: true,
            rawTranscriptReseedReason: "no-cli-session",
          });
        } catch (error) {
          thrown = error;
        }
        const elapsedMs = Date.now() - start;

        expect(isSessionResumeDrainPendingError(thrown)).toBe(true);
        if (isSessionResumeDrainPendingError(thrown)) {
          expect(thrown.sessionId).toBe(sessionKey);
          expect(thrown.pendingEpoch).toBe(3);
        }
        // No internal wait/sleep budget: the refusal is a synchronous check
        // before the transcript read, so it must not take anywhere near a
        // retry-budget-scale delay.
        expect(elapsedMs).toBeLessThan(1_000);

        // The drain transaction commits and flips the marker to drained.
        setResumeEpochMarker({ sessionKey, epoch: 3, state: "drained" });

        const reseed = await loadCliSessionReseedMessages({
          sessionId: "session-resume-drain",
          sessionFile,
          sessionKey,
          agentId: "main",
          allowRawTranscriptReseed: true,
          rawTranscriptReseedReason: "no-cli-session",
        });
        expect(reseed.length).toBeGreaterThan(0);
        const first = reseed[0] as { role?: unknown; content?: unknown };
        expect(first.role).toBe("user");
        expect(first.content).toBe("earlier turn");
      });
    } finally {
      fs.rmSync(stateDir, { recursive: true, force: true });
    }
  });

  it("loadCliSessionContextEngineMessages refuses drain_pending then succeeds once the marker is drained", async () => {
    const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-cli-state-"));
    const sessionFile = createSessionTranscript({
      rootDir: stateDir,
      sessionId: "session-resume-drain-context",
      messages: ["only turn"],
    });
    const sessionKey = "agent:main:main";

    try {
      await withCliSessionState(stateDir, async () => {
        setResumeEpochMarker({ sessionKey, epoch: 1, state: "drain_pending" });

        let thrown: unknown;
        try {
          await loadCliSessionContextEngineMessages({
            sessionId: "session-resume-drain-context",
            sessionFile,
            sessionKey,
            agentId: "main",
          });
        } catch (error) {
          thrown = error;
        }
        expect(isSessionResumeDrainPendingError(thrown)).toBe(true);
        if (isSessionResumeDrainPendingError(thrown)) {
          expect(thrown.sessionId).toBe(sessionKey);
          expect(thrown.pendingEpoch).toBe(1);
        }

        setResumeEpochMarker({ sessionKey, epoch: 1, state: "drained" });

        const messages = await loadCliSessionContextEngineMessages({
          sessionId: "session-resume-drain-context",
          sessionFile,
          sessionKey,
          agentId: "main",
        });
        expect(messages.length).toBeGreaterThan(0);
      });
    } finally {
      fs.rmSync(stateDir, { recursive: true, force: true });
    }
  });

  it("loadCliSessionHistoryMessages does not throw on a drain_pending marker (non-resume reader tolerates it, PHASE-4.md §7c)", async () => {
    const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-cli-state-"));
    const sessionFile = createSessionTranscript({
      rootDir: stateDir,
      sessionId: "session-resume-drain-history",
      messages: ["a turn"],
    });
    const sessionKey = "agent:main:main";

    try {
      await withCliSessionState(stateDir, async () => {
        setResumeEpochMarker({ sessionKey, epoch: 7, state: "drain_pending" });

        const history = await loadCliSessionHistoryMessages({
          sessionId: "session-resume-drain-history",
          sessionFile,
          sessionKey,
          agentId: "main",
        });
        expect(history.length).toBeGreaterThan(0);
      });
    } finally {
      fs.rmSync(stateDir, { recursive: true, force: true });
    }
  });

  it("hasCliSessionTranscript does not throw on a drain_pending marker (non-resume reader tolerates it, PHASE-4.md §7c)", async () => {
    const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-cli-state-"));
    const sessionFile = createSessionTranscript({
      rootDir: stateDir,
      sessionId: "session-resume-drain-has-transcript",
      messages: ["a turn"],
    });
    const sessionKey = "agent:main:main";

    try {
      await withCliSessionState(stateDir, async () => {
        setResumeEpochMarker({ sessionKey, epoch: 9, state: "drain_pending" });

        await expect(
          hasCliSessionTranscript({
            sessionId: "session-resume-drain-has-transcript",
            sessionFile,
            sessionKey,
            agentId: "main",
          }),
        ).resolves.toBe(true);
      });
    } finally {
      fs.rmSync(stateDir, { recursive: true, force: true });
    }
  });
});
