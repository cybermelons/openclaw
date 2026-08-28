import { execFileSync } from "node:child_process";
// Phase-4 CS-5 (T-P4-CS5) — the resume-read sleep-retry loop in
// readSqliteCliSessionEntries is deleted (PHASE-4.md §4 CS-5): CS-3
// (drain+marker one txn, dispatch gated on COMMIT) and CS-4 (resume readers
// refuse drain_pending) already guarantee a resume read observes a
// consistent committed-drain transcript, so the sqlite reader is now a thin,
// synchronous, single-attempt wrapper. This file covers:
//   1. Reader paths succeed first-read against committed-drain zero-lag
//      fixtures built the same way CS-3's drain path builds them.
//   2. A source-scan negative probe: zero references to the four deleted
//      retry symbols remain in the codebase.
//   3. Fallback: a thrown SessionTranscriptProjectionUnavailableError from
//      the sqlite reader falls straight through to the file reader with no
//      retry and no propagated throw.
//   4. Fallback: a generic (non-projection) store error falls through the
//      same way.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { CURRENT_SESSION_VERSION } from "openclaw/plugin-sdk/agent-sessions";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { SessionEntry } from "../../config/sessions.js";
import { readSessionResumeEpochForScope } from "../../config/sessions/session-accessor.sqlite-active-projection.js";
import { CLAUDE_CLI_PROVIDER } from "../../gateway/cli-session-history.claude.js";
import { closeOpenClawAgentDatabasesForTest } from "../../state/openclaw-agent-db.js";
import { closeOpenClawStateDatabaseForTest } from "../../state/openclaw-state-db.js";
import { withEnvAsync } from "../../test-utils/env.js";
import { setCliSessionBinding } from "../cli-session.js";
import { drainTailForResume } from "../cli-transcript-reconcile.js";
import {
  hasCliSessionTranscript,
  loadCliSessionContextEngineMessages,
  loadCliSessionHistoryMessages,
  loadCliSessionReseedMessages,
} from "./session-history.js";

async function withCliSessionState<T>(stateDir: string, run: () => Promise<T>): Promise<T> {
  return await withEnvAsync({ OPENCLAW_STATE_DIR: stateDir }, run);
}

function createClaudeTurnLines(
  entries: Array<{ role: "user" | "assistant"; uuid: string; content: string }>,
): string {
  return entries
    .map((entry, index) =>
      JSON.stringify({
        type: entry.role,
        uuid: entry.uuid,
        timestamp: new Date(Date.parse("2026-03-26T16:29:54.800Z") + index).toISOString(),
        message: {
          role: entry.role,
          content: entry.content,
        },
      }),
    )
    .join("\n");
}

/**
 * Builds a committed-drain zero-lag fixture the same way CS-3's resume path
 * builds one: a bound Claude CLI session jsonl transcript, drained into
 * SQLite transcript_events + a `drained` session_resume_epoch marker, both
 * committed in one transaction (drainTailForResume). Reader paths under
 * test then read this fixture back through the SQLite store with no
 * projection lag to wait out.
 */
async function withDrainedSqliteFixture<T>(
  params: {
    sessionId: string;
    sessionKey: string;
    agentId?: string;
    messages: Array<{ role: "user" | "assistant"; uuid: string; content: string }>;
  },
  run: (fixture: { stateDir: string; sessionFile: string; homeDir: string }) => Promise<T>,
): Promise<T> {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-cs5-fixture-"));
  const stateDir = path.join(root, "state");
  const homeDir = path.join(root, "home");
  const cliSessionId = "5b8b202c-f6bb-4046-9475-d2f15fd07530";
  const projectsDir = path.join(homeDir, ".claude", "projects", "demo-workspace");
  const cliSessionFile = path.join(projectsDir, `${cliSessionId}.jsonl`);
  fs.mkdirSync(projectsDir, { recursive: true });
  fs.writeFileSync(cliSessionFile, createClaudeTurnLines(params.messages), "utf-8");

  const sessionFile = path.join(
    stateDir,
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
      cwd: stateDir,
    })}\n`,
    "utf-8",
  );

  try {
    return await withEnvAsync({ HOME: homeDir }, async () =>
      withCliSessionState(stateDir, async () => {
        const entry: SessionEntry = { sessionId: params.sessionId, updatedAt: Date.now() };
        setCliSessionBinding(entry, CLAUDE_CLI_PROVIDER, { sessionId: cliSessionId });

        const result = await drainTailForResume({
          entry,
          sessionKey: params.sessionKey,
          agentId: params.agentId ?? "main",
          env: process.env,
          homeDir,
        });
        expect(result.epoch).toBeGreaterThan(0);

        // drainTailForResume commits the drain + marker in one txn; sanity
        // check the marker landed as "drained" so callers' resume-drain
        // refusal (CS-4) does not spuriously reject this fixture.
        const marker = readSessionResumeEpochForScope(
          {
            sessionId: params.sessionId,
            sessionKey: params.sessionKey,
            agentId: params.agentId ?? "main",
          },
          params.sessionKey,
        );
        expect(marker?.state).toBe("drained");

        return run({ stateDir, sessionFile, homeDir });
      }),
    );
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
}

afterEach(() => {
  closeOpenClawAgentDatabasesForTest();
  closeOpenClawStateDatabaseForTest();
  vi.restoreAllMocks();
});

describe("Phase-4 CS-5 sqlite reader thin-wrapper (T-P4-CS5)", () => {
  it("loadCliSessionReseedMessages reads a committed-drain zero-lag fixture on first read, no retry", async () => {
    await withDrainedSqliteFixture(
      {
        sessionId: "session-cs5-reseed",
        sessionKey: "agent:main:session-cs5-reseed",
        messages: [
          { role: "user", uuid: "user-1", content: "hello" },
          { role: "assistant", uuid: "assistant-1", content: "hi there" },
        ],
      },
      async ({ sessionFile }) => {
        const start = Date.now();
        const reseed = await loadCliSessionReseedMessages({
          sessionId: "session-cs5-reseed",
          sessionFile,
          sessionKey: "agent:main:session-cs5-reseed",
          agentId: "main",
          allowRawTranscriptReseed: true,
          rawTranscriptReseedReason: "no-cli-session",
        });
        const elapsedMs = Date.now() - start;
        expect(reseed.length).toBeGreaterThan(0);
        // No retry/backoff possible: a first-read success must return well
        // under the deleted retry budget (2000ms).
        expect(elapsedMs).toBeLessThan(1_000);
      },
    );
  });

  it("loadCliSessionContextEngineMessages reads a committed-drain zero-lag fixture on first read", async () => {
    await withDrainedSqliteFixture(
      {
        sessionId: "session-cs5-context",
        sessionKey: "agent:main:session-cs5-context",
        messages: [{ role: "user", uuid: "user-1", content: "only turn" }],
      },
      async ({ sessionFile }) => {
        const messages = await loadCliSessionContextEngineMessages({
          sessionId: "session-cs5-context",
          sessionFile,
          sessionKey: "agent:main:session-cs5-context",
          agentId: "main",
        });
        expect(messages.length).toBeGreaterThan(0);
      },
    );
  });

  it("loadCliSessionHistoryMessages reads a committed-drain zero-lag fixture on first read", async () => {
    await withDrainedSqliteFixture(
      {
        sessionId: "session-cs5-history",
        sessionKey: "agent:main:session-cs5-history",
        messages: [{ role: "user", uuid: "user-1", content: "a turn" }],
      },
      async ({ sessionFile }) => {
        const history = await loadCliSessionHistoryMessages({
          sessionId: "session-cs5-history",
          sessionFile,
          sessionKey: "agent:main:session-cs5-history",
          agentId: "main",
        });
        expect(history.length).toBeGreaterThan(0);
      },
    );
  });

  it("hasCliSessionTranscript reads a committed-drain zero-lag fixture on first read", async () => {
    await withDrainedSqliteFixture(
      {
        sessionId: "session-cs5-has-transcript",
        sessionKey: "agent:main:session-cs5-has-transcript",
        messages: [{ role: "user", uuid: "user-1", content: "a turn" }],
      },
      async ({ sessionFile }) => {
        await expect(
          hasCliSessionTranscript({
            sessionId: "session-cs5-has-transcript",
            sessionFile,
            sessionKey: "agent:main:session-cs5-has-transcript",
            agentId: "main",
          }),
        ).resolves.toBe(true);
      },
    );
  });

  it("has zero references to the deleted projection-retry symbols anywhere in the tree", () => {
    const deletedSymbols = [
      "PROJECTION_RETRY_MAX_ATTEMPTS",
      "PROJECTION_RETRY_BACKOFF_MS",
      "PROJECTION_RETRY_BUDGET_MS",
    ];
    const repoRoot = path.resolve(__dirname, "../../..");
    // Exclude this probe file: it names the deleted symbols as string literals,
    // so an unscoped grep would match itself and never pass.
    const selfPath = path.relative(repoRoot, __filename).split(path.sep).join("/");
    for (const symbol of deletedSymbols) {
      let output = "";
      try {
        output = execFileSync(
          "git",
          ["grep", "-nF", symbol, "--", "src", "test", `:(exclude)${selfPath}`],
          {
            cwd: repoRoot,
            encoding: "utf-8",
          },
        );
      } catch (error) {
        // git grep exits 1 with empty output when there are no matches --
        // that is the expected passing state for this probe.
        const status = (error as { status?: number }).status;
        if (status !== 1) {
          throw error;
        }
      }
      expect(output.trim(), `expected zero references to ${symbol}, found:\n${output}`).toBe("");
    }
  });

  it("returns undefined from the sqlite path (file reader serves the read) when the projection is unavailable", async () => {
    vi.resetModules();
    vi.doMock("../../config/sessions/session-accessor.sqlite-active-events.js", async () => {
      const actual = await vi.importActual<
        typeof import("../../config/sessions/session-accessor.sqlite-active-events.js")
      >("../../config/sessions/session-accessor.sqlite-active-events.js");
      return {
        ...actual,
        readSessionTranscriptMessageEvents: () => {
          throw new actual.SessionTranscriptProjectionUnavailableError("session-cs5-unavailable");
        },
      };
    });
    const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-cs5-state-"));
    const sessionFile = path.join(
      stateDir,
      "agents",
      "main",
      "sessions",
      "session-cs5-unavailable.jsonl",
    );
    fs.mkdirSync(path.dirname(sessionFile), { recursive: true });
    fs.writeFileSync(
      sessionFile,
      `${JSON.stringify({
        type: "session",
        version: CURRENT_SESSION_VERSION,
        id: "session-cs5-unavailable",
        timestamp: new Date(0).toISOString(),
        cwd: stateDir,
      })}\n${JSON.stringify({
        type: "message",
        id: "msg-0",
        parentId: null,
        timestamp: new Date(1).toISOString(),
        message: { role: "user", content: "file fallback turn", timestamp: 1 },
      })}\n`,
      "utf-8",
    );
    try {
      const { loadCliSessionHistoryMessages: loadHistory } = await import("./session-history.js");
      await withCliSessionState(stateDir, async () => {
        const start = Date.now();
        const history = await loadHistory({
          sessionId: "session-cs5-unavailable",
          sessionFile,
          sessionKey: "agent:main:session-cs5-unavailable",
          agentId: "main",
        });
        const elapsedMs = Date.now() - start;
        // File reader served the read: no hang, no propagated throw.
        expect(history.length).toBeGreaterThan(0);
        expect(elapsedMs).toBeLessThan(1_000);
      });
    } finally {
      fs.rmSync(stateDir, { recursive: true, force: true });
      vi.doUnmock("../../config/sessions/session-accessor.sqlite-active-events.js");
      vi.resetModules();
    }
  });

  it("does not lstat a `sqlite:` sessionFile sentinel when the sqlite store has no rows (#27)", async () => {
    vi.resetModules();
    vi.doMock("../../config/sessions/session-accessor.sqlite-active-events.js", async () => {
      const actual = await vi.importActual<
        typeof import("../../config/sessions/session-accessor.sqlite-active-events.js")
      >("../../config/sessions/session-accessor.sqlite-active-events.js");
      return {
        ...actual,
        readSessionTranscriptMessageEvents: () => [],
      };
    });
    const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-cs5-sentinel-"));
    const sessionFile = "sqlite:session-cs5-sentinel";
    try {
      const fspModule = await import("node:fs/promises");
      const lstatSpy = vi.spyOn(fspModule.default, "lstat");
      const { hasCliSessionTranscript: hasTranscript, loadCliSessionHistoryMessages: loadHistory } =
        await import("./session-history.js");
      await withCliSessionState(stateDir, async () => {
        const history = await loadHistory({
          sessionId: "session-cs5-sentinel",
          sessionFile,
          sessionKey: "agent:main:session-cs5-sentinel",
          agentId: "main",
        });
        expect(history).toEqual([]);
        await expect(
          hasTranscript({
            sessionId: "session-cs5-sentinel",
            sessionFile,
            sessionKey: "agent:main:session-cs5-sentinel",
            agentId: "main",
          }),
        ).resolves.toBe(false);
      });
      expect(lstatSpy).not.toHaveBeenCalled();
    } finally {
      fs.rmSync(stateDir, { recursive: true, force: true });
      vi.doUnmock("../../config/sessions/session-accessor.sqlite-active-events.js");
      vi.resetModules();
    }
  });

  it("returns undefined from the sqlite path (file reader serves the read) on a generic store error", async () => {
    vi.resetModules();
    vi.doMock("../../config/sessions/session-accessor.sqlite-active-events.js", async () => {
      const actual = await vi.importActual<
        typeof import("../../config/sessions/session-accessor.sqlite-active-events.js")
      >("../../config/sessions/session-accessor.sqlite-active-events.js");
      return {
        ...actual,
        readSessionTranscriptMessageEvents: () => {
          throw new Error("generic sqlite store failure");
        },
      };
    });
    const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-cs5-state-generic-"));
    const sessionFile = path.join(
      stateDir,
      "agents",
      "main",
      "sessions",
      "session-cs5-generic-error.jsonl",
    );
    fs.mkdirSync(path.dirname(sessionFile), { recursive: true });
    fs.writeFileSync(
      sessionFile,
      `${JSON.stringify({
        type: "session",
        version: CURRENT_SESSION_VERSION,
        id: "session-cs5-generic-error",
        timestamp: new Date(0).toISOString(),
        cwd: stateDir,
      })}\n${JSON.stringify({
        type: "message",
        id: "msg-0",
        parentId: null,
        timestamp: new Date(1).toISOString(),
        message: { role: "user", content: "file fallback turn", timestamp: 1 },
      })}\n`,
      "utf-8",
    );
    try {
      const { loadCliSessionHistoryMessages: loadHistory } = await import("./session-history.js");
      await withCliSessionState(stateDir, async () => {
        const start = Date.now();
        const history = await loadHistory({
          sessionId: "session-cs5-generic-error",
          sessionFile,
          sessionKey: "agent:main:session-cs5-generic-error",
          agentId: "main",
        });
        const elapsedMs = Date.now() - start;
        expect(history.length).toBeGreaterThan(0);
        expect(elapsedMs).toBeLessThan(1_000);
      });
    } finally {
      fs.rmSync(stateDir, { recursive: true, force: true });
      vi.doUnmock("../../config/sessions/session-accessor.sqlite-active-events.js");
      vi.resetModules();
    }
  });
});
