// CLI transcript reconcile tests protect jsonl-to-SQLite backfill, idempotency, and no-binding skip.
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import type { SessionEntry } from "../config/sessions.js";
import { readSessionResumeEpochForScope } from "../config/sessions/session-accessor.sqlite-active-projection.js";
import {
  readSessionResumeEpoch,
  writeSessionResumeEpoch,
} from "../config/sessions/session-accessor.sqlite-resume-epoch-store.js";
import {
  resolveSqliteScope,
  toDatabaseOptions,
} from "../config/sessions/session-accessor.sqlite-scope.js";
import { appendTranscriptMessageInTransaction } from "../config/sessions/session-accessor.sqlite-transcript-message-append.js";
import { SessionResumeDrainPendingError } from "../config/sessions/session-resume-drain-pending-error.js";
import { CLAUDE_CLI_PROVIDER } from "../gateway/cli-session-history.claude.js";
import {
  closeOpenClawAgentDatabasesForTest,
  openOpenClawAgentDatabase,
  runOpenClawAgentWriteTransaction,
} from "../state/openclaw-agent-db.js";
import { closeOpenClawStateDatabaseForTest } from "../state/openclaw-state-db.js";
import { withEnvAsync } from "../test-utils/env.js";
import { loadCliSessionContextEngineMessages } from "./cli-runner/session-history.js";
import { setCliSessionBinding } from "./cli-session.js";
import { drainTailForResume, reconcileCliTranscript } from "./cli-transcript-reconcile.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);

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

async function withClaudeProjectsDir<T>(
  entries: Array<{ role: "user" | "assistant"; uuid: string; content: string }>,
  run: (params: { homeDir: string; sessionId: string; filePath: string }) => Promise<T>,
): Promise<T> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-cli-reconcile-"));
  const homeDir = path.join(root, "home");
  const sessionId = "5b8b202c-f6bb-4046-9475-d2f15fd07530";
  const projectsDir = path.join(homeDir, ".claude", "projects", "demo-workspace");
  const filePath = path.join(projectsDir, `${sessionId}.jsonl`);
  await fs.mkdir(projectsDir, { recursive: true });
  await fs.writeFile(filePath, createClaudeTurnLines(entries), "utf-8");
  try {
    return await withEnvAsync({ HOME: homeDir }, () => run({ homeDir, sessionId, filePath }));
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
}

// Counts only backfilled message events, excluding the synthetic session-root
// event (type "session") that transcript persistence seeds at seq 0.
function countTranscriptMessageEvents(params: {
  agentId: string;
  env: NodeJS.ProcessEnv;
  sessionId: string;
}): number {
  const database = openOpenClawAgentDatabase({ agentId: params.agentId, env: params.env });
  const row = database.db
    .prepare(
      "SELECT COUNT(*) AS count FROM transcript_events WHERE session_id = ? AND json_extract(event_json, '$.type') = 'message'",
    )
    .get(params.sessionId) as { count?: unknown } | undefined;
  const count = row?.count;
  return typeof count === "number" ? count : 0;
}

describe("reconcileCliTranscript", () => {
  let stateDir: string;

  beforeEach(() => {
    stateDir = tempDirs.make("openclaw-cli-reconcile-state-");
  });

  afterEach(() => {
    closeOpenClawAgentDatabasesForTest();
    closeOpenClawStateDatabaseForTest();
  });

  it("backfills every turn missing from SQLite transcript_events on first reconcile", async () => {
    await withClaudeProjectsDir(
      [
        { role: "user", uuid: "user-1", content: "hello" },
        { role: "assistant", uuid: "assistant-1", content: "hi there" },
        { role: "user", uuid: "user-2", content: "how are you" },
        { role: "assistant", uuid: "assistant-2", content: "doing great" },
      ],
      async ({ homeDir, sessionId }) => {
        const entry: SessionEntry = {
          sessionId: "openclaw-local-session",
          updatedAt: Date.now(),
        };
        setCliSessionBinding(entry, CLAUDE_CLI_PROVIDER, { sessionId });

        const env = { ...process.env, OPENCLAW_STATE_DIR: stateDir };
        const sessionKey = "agent:main:openclaw-local-session";

        const result = await reconcileCliTranscript({
          entry,
          sessionKey,
          agentId: "main",
          env,
          homeDir,
        });

        expect(result.status).toBe("reconciled");
        expect(result).toMatchObject({ status: "reconciled", backfilled: 4 });

        const count = countTranscriptMessageEvents({
          agentId: "main",
          env,
          sessionId: entry.sessionId,
        });
        expect(count).toBe(4);
      },
    );
  });

  it("is idempotent: a second reconcile call backfills nothing new", async () => {
    await withClaudeProjectsDir(
      [
        { role: "user", uuid: "user-1", content: "hello" },
        { role: "assistant", uuid: "assistant-1", content: "hi there" },
        { role: "user", uuid: "user-2", content: "how are you" },
      ],
      async ({ homeDir, sessionId }) => {
        const entry: SessionEntry = {
          sessionId: "openclaw-local-session-idempotent",
          updatedAt: Date.now(),
        };
        setCliSessionBinding(entry, CLAUDE_CLI_PROVIDER, { sessionId });

        const env = { ...process.env, OPENCLAW_STATE_DIR: stateDir };
        const sessionKey = "agent:main:openclaw-local-session-idempotent";

        const first = await reconcileCliTranscript({
          entry,
          sessionKey,
          agentId: "main",
          env,
          homeDir,
        });
        expect(first).toMatchObject({ status: "reconciled", backfilled: 3 });

        const second = await reconcileCliTranscript({
          entry,
          sessionKey,
          agentId: "main",
          env,
          homeDir,
        });

        // Accept either "noop" (watermark persisted) or "reconciled" with
        // backfilled 0 (eventId dedup) -- storePath was intentionally omitted,
        // so the watermark-persist branch is best-effort here.
        expect(second.status === "noop" || second.status === "reconciled").toBe(true);
        if (second.status === "reconciled") {
          expect(second.backfilled).toBe(0);
        }

        const count = countTranscriptMessageEvents({
          agentId: "main",
          env,
          sessionId: entry.sessionId,
        });
        expect(count).toBe(3);
      },
    );
  });

  function appendLocalMirrorRow(params: {
    env: NodeJS.ProcessEnv;
    sessionKey: string;
    sessionId: string;
    eventId: string;
    message: { role: string; content: unknown; timestamp: number };
  }): void {
    const resolved = resolveSqliteScope({
      agentId: "main",
      env: params.env,
      sessionKey: params.sessionKey,
    });
    runOpenClawAgentWriteTransaction((database) => {
      appendTranscriptMessageInTransaction(
        database,
        { ...resolved, sessionId: params.sessionId },
        { message: params.message, eventId: params.eventId },
      );
    }, toDatabaseOptions(resolved));
  }

  it("does not re-append turns the live mirror already persisted (timestamp watermark)", async () => {
    // jsonl rows carry 2026-03-26 timestamps; the mirror rows below are newer,
    // so every jsonl row belongs to an already-persisted turn.
    await withClaudeProjectsDir(
      [
        { role: "user", uuid: "user-1", content: 'Use the "demo" skill for this request.' },
        { role: "assistant", uuid: "assistant-1", content: "I'll load the skill." },
        { role: "assistant", uuid: "assistant-2", content: "Full final answer." },
      ],
      async ({ homeDir, sessionId }) => {
        const entry: SessionEntry = {
          sessionId: "openclaw-local-session-mirrored",
          updatedAt: Date.now(),
        };
        setCliSessionBinding(entry, CLAUDE_CLI_PROVIDER, { sessionId });
        const env = { ...process.env, OPENCLAW_STATE_DIR: stateDir };
        const sessionKey = "agent:main:openclaw-local-session-mirrored";

        appendLocalMirrorRow({
          env,
          sessionKey,
          sessionId: entry.sessionId,
          eventId: "mirror-user-1",
          message: {
            role: "user",
            content: [{ type: "text", text: "/demo" }],
            timestamp: Date.now(),
          },
        });
        appendLocalMirrorRow({
          env,
          sessionKey,
          sessionId: entry.sessionId,
          eventId: "mirror-assistant-1",
          message: {
            role: "assistant",
            content: [{ type: "text", text: "I'll load the skill.\n\nFull final answer." }],
            timestamp: Date.now(),
          },
        });

        const result = await reconcileCliTranscript({
          entry,
          sessionKey,
          agentId: "main",
          env,
          homeDir,
        });
        expect(result).toMatchObject({ status: "reconciled", backfilled: 0 });

        const count = countTranscriptMessageEvents({
          agentId: "main",
          env,
          sessionId: entry.sessionId,
        });
        expect(count).toBe(2);
      },
    );
  });

  it("skips newer jsonl fragments contained in a local record but backfills genuinely new rows", async () => {
    // Mirror assistant record is OLDER than the jsonl rows (crash-recovery
    // shape). The fragment duplicates part of the mirrored concatenated text
    // and must not re-append; the unrelated new row must backfill.
    const jsonlBaseTs = Date.parse("2026-03-26T16:29:54.800Z");
    await withClaudeProjectsDir(
      [
        { role: "assistant", uuid: "fragment-1", content: "I'll load the skill." },
        { role: "assistant", uuid: "new-turn-1", content: "Recovered in-flight answer." },
      ],
      async ({ homeDir, sessionId }) => {
        const entry: SessionEntry = {
          sessionId: "openclaw-local-session-fragment",
          updatedAt: Date.now(),
        };
        setCliSessionBinding(entry, CLAUDE_CLI_PROVIDER, { sessionId });
        const env = { ...process.env, OPENCLAW_STATE_DIR: stateDir };
        const sessionKey = "agent:main:openclaw-local-session-fragment";

        appendLocalMirrorRow({
          env,
          sessionKey,
          sessionId: entry.sessionId,
          eventId: "mirror-assistant-old",
          message: {
            role: "assistant",
            content: [{ type: "text", text: "I'll load the skill.\n\nEarlier full answer." }],
            timestamp: jsonlBaseTs - 60_000,
          },
        });

        const result = await reconcileCliTranscript({
          entry,
          sessionKey,
          agentId: "main",
          env,
          homeDir,
        });
        expect(result).toMatchObject({ status: "reconciled", backfilled: 1 });

        const count = countTranscriptMessageEvents({
          agentId: "main",
          env,
          sessionId: entry.sessionId,
        });
        expect(count).toBe(2);
      },
    );
  });

  it("skips with reason no-binding when the session entry has no bound CLI session", async () => {
    const entry: SessionEntry = {
      sessionId: "openclaw-local-session-no-binding",
      updatedAt: Date.now(),
    };
    const env = { ...process.env, OPENCLAW_STATE_DIR: stateDir };

    const result = await reconcileCliTranscript({
      entry,
      sessionKey: "agent:main:openclaw-local-session-no-binding",
      agentId: "main",
      env,
    });

    expect(result).toEqual({ status: "skipped", reason: "no-binding" });
  });
});

// Phase-4 CS-3 (T1) — drainTailForResume commits the interrupted-turn tail
// drain and the resume_epoch marker write in one transaction. See
// docs/session-rearchitecture/PHASE-4.md §4 CS-3.
describe("drainTailForResume", () => {
  let stateDir: string;

  beforeEach(() => {
    stateDir = tempDirs.make("openclaw-cli-drain-resume-state-");
  });

  afterEach(() => {
    closeOpenClawAgentDatabasesForTest();
    closeOpenClawStateDatabaseForTest();
  });

  function readEpochMarker(params: {
    agentId: string;
    env: NodeJS.ProcessEnv;
    sessionKey: string;
  }) {
    const database = openOpenClawAgentDatabase({ agentId: params.agentId, env: params.env });
    return readSessionResumeEpoch(database, params.sessionKey);
  }

  it("commits epoch+1/drained with zero candidates (no CLI binding) and never throws", async () => {
    const entry: SessionEntry = {
      sessionId: "openclaw-local-session-drain-no-binding",
      updatedAt: Date.now(),
    };
    const env = { ...process.env, OPENCLAW_STATE_DIR: stateDir };
    const sessionKey = "agent:main:openclaw-local-session-drain-no-binding";

    const result = await drainTailForResume({ entry, sessionKey, agentId: "main", env });

    expect(result).toEqual({ backfilled: 0, epoch: 1 });
    expect(readEpochMarker({ agentId: "main", env, sessionKey })).toMatchObject({
      epoch: 1,
      state: "drained",
    });
  });

  it("commits epoch+1/drained with zero candidates when the tail is already fully mirrored", async () => {
    await withClaudeProjectsDir(
      [
        { role: "user", uuid: "user-1", content: "hello" },
        { role: "assistant", uuid: "assistant-1", content: "hi there" },
      ],
      async ({ homeDir, sessionId }) => {
        const entry: SessionEntry = {
          sessionId: "openclaw-local-session-drain-mirrored",
          updatedAt: Date.now(),
        };
        setCliSessionBinding(entry, CLAUDE_CLI_PROVIDER, { sessionId });
        const env = { ...process.env, OPENCLAW_STATE_DIR: stateDir };
        const sessionKey = "agent:main:openclaw-local-session-drain-mirrored";

        // Pre-drain via reconcileCliTranscript so every jsonl row is already
        // represented in SQLite transcript_events; the resume drain then has
        // nothing new to append but must still commit the marker.
        const preDrain = await reconcileCliTranscript({
          entry,
          sessionKey,
          agentId: "main",
          env,
          homeDir,
        });
        expect(preDrain).toMatchObject({ status: "reconciled", backfilled: 2 });

        const before = readEpochMarker({ agentId: "main", env, sessionKey });
        expect(before?.epoch).toBe(0);

        const result = await drainTailForResume({
          entry,
          sessionKey,
          agentId: "main",
          env,
          homeDir,
        });

        expect(result).toEqual({ backfilled: 0, epoch: 1 });
        expect(readEpochMarker({ agentId: "main", env, sessionKey })).toMatchObject({
          epoch: 1,
          state: "drained",
        });
      },
    );
  });

  it("rolls back appended rows and the drained-marker write together when the post-append hook throws, but leaves the phase-1 drain_pending commit in place (CS-4 guard reachable)", async () => {
    await withClaudeProjectsDir(
      [
        { role: "user", uuid: "user-1", content: "hello" },
        { role: "assistant", uuid: "assistant-1", content: "hi there" },
      ],
      async ({ homeDir, sessionId }) => {
        const entry: SessionEntry = {
          sessionId: "openclaw-local-session-drain-rollback",
          updatedAt: Date.now(),
        };
        setCliSessionBinding(entry, CLAUDE_CLI_PROVIDER, { sessionId });
        const env = { ...process.env, OPENCLAW_STATE_DIR: stateDir };
        const sessionKey = "agent:main:openclaw-local-session-drain-rollback";

        // Seed session_nodes (and the epoch=0/drained backfill trigger) via a
        // no-op resume drain before the failing attempt, so a pre-existing
        // marker row is available to assert stays UNCHANGED after rollback.
        const seed = await drainTailForResume({
          entry: { ...entry, sessionId: "openclaw-local-session-drain-rollback-seed" },
          sessionKey: "agent:main:openclaw-local-session-drain-rollback-seed",
          agentId: "main",
          env,
        });
        expect(seed.epoch).toBe(1);

        const failure = new Error("simulated post-append failure");
        await expect(
          drainTailForResume({
            entry,
            sessionKey,
            agentId: "main",
            env,
            homeDir,
            failureHookAfterAppends: () => {
              throw failure;
            },
          }),
        ).rejects.toThrow(failure);

        // Phase 1 (drain_pending) is a separate, already-committed transaction:
        // it survives phase 2's rollback. This is the durably-committed
        // drain_pending row the CS-4 refusal guard reads in production.
        const marker = readEpochMarker({ agentId: "main", env, sessionKey });
        expect(marker).toMatchObject({ epoch: 0, state: "drain_pending" });

        // Phase 2 (append + drained-marker write) rolled back together: no
        // transcript rows were appended.
        const count = countTranscriptMessageEvents({
          agentId: "main",
          env,
          sessionId: entry.sessionId,
        });
        expect(count).toBe(0);
      },
    );
  });

  it("CS-4 guard is reachable: loadCliSessionContextEngineMessages throws SessionResumeDrainPendingError on the durably-committed phase-1 drain_pending row after a phase-2 crash, then clears on re-entry with epoch advanced exactly once and no duplicate rows", async () => {
    await withClaudeProjectsDir(
      [
        { role: "user", uuid: "user-1", content: "hello" },
        { role: "assistant", uuid: "assistant-1", content: "hi there" },
      ],
      async ({ homeDir, sessionId }) => {
        const entry: SessionEntry = {
          sessionId: "openclaw-local-session-drain-guard",
          updatedAt: Date.now(),
        };
        setCliSessionBinding(entry, CLAUDE_CLI_PROVIDER, { sessionId });
        const env = { ...process.env, OPENCLAW_STATE_DIR: stateDir };
        const sessionKey = "agent:main:openclaw-local-session-drain-guard";

        // A minimal OpenClaw session envelope (independent of the CLI jsonl
        // above) — the guard reads the marker before touching this file, so
        // its content only needs to be valid enough for the eventual
        // post-guard read to succeed.
        const sessionFile = path.join(stateDir, "openclaw-local-session-drain-guard.jsonl");
        await fs.writeFile(
          sessionFile,
          `${JSON.stringify({
            type: "session",
            version: "1",
            id: entry.sessionId,
            timestamp: new Date(0).toISOString(),
            cwd: stateDir,
          })}\n${JSON.stringify({
            type: "message",
            id: "msg-0",
            parentId: null,
            timestamp: new Date(1).toISOString(),
            message: { role: "user", content: "hi", timestamp: 1 },
          })}\n`,
          "utf-8",
        );

        const failure = new Error("simulated crash after phase 1, during phase 2");
        await expect(
          drainTailForResume({
            entry,
            sessionKey,
            agentId: "main",
            env,
            homeDir,
            failureHookAfterAppends: () => {
              throw failure;
            },
          }),
        ).rejects.toThrow(failure);

        await withEnvAsync(env, async () => {
          let thrown: unknown;
          try {
            await loadCliSessionContextEngineMessages({
              sessionId: entry.sessionId,
              sessionFile,
              sessionKey,
              agentId: "main",
            });
          } catch (error) {
            thrown = error;
          }
          expect(thrown).toBeInstanceOf(SessionResumeDrainPendingError);

          // Re-entry: drain to completion. Guard clears; epoch advanced
          // exactly once relative to pre-crash (0 -> 1, not 0 -> 2); no
          // duplicate rows (idempotent append dedups on eventId).
          const result = await drainTailForResume({
            entry,
            sessionKey,
            agentId: "main",
            env,
            homeDir,
          });
          expect(result).toEqual({ backfilled: 2, epoch: 1 });

          const messages = await loadCliSessionContextEngineMessages({
            sessionId: entry.sessionId,
            sessionFile,
            sessionKey,
            agentId: "main",
          });
          expect(messages.length).toBeGreaterThan(0);
        });

        const count = countTranscriptMessageEvents({
          agentId: "main",
          env,
          sessionId: entry.sessionId,
        });
        expect(count).toBe(2);
      },
    );
  });

  it("watermark: after a completed drain, the marker names the drained session_id and drainedThroughSeq = MAX(seq) for it", async () => {
    await withClaudeProjectsDir(
      [
        { role: "user", uuid: "user-1", content: "hello" },
        { role: "assistant", uuid: "assistant-1", content: "hi there" },
      ],
      async ({ homeDir, sessionId }) => {
        const entry: SessionEntry = {
          sessionId: "openclaw-local-session-drain-watermark",
          updatedAt: Date.now(),
        };
        setCliSessionBinding(entry, CLAUDE_CLI_PROVIDER, { sessionId });
        const env = { ...process.env, OPENCLAW_STATE_DIR: stateDir };
        const sessionKey = "agent:main:openclaw-local-session-drain-watermark";

        const result = await drainTailForResume({
          entry,
          sessionKey,
          agentId: "main",
          env,
          homeDir,
        });
        expect(result).toEqual({ backfilled: 2, epoch: 1 });

        const database = openOpenClawAgentDatabase({ agentId: "main", env });
        const marker = readSessionResumeEpoch(database, sessionKey);
        expect(marker).toMatchObject({
          epoch: 1,
          state: "drained",
          sessionId: entry.sessionId,
        });
        expect(marker?.drainedThroughSeq).not.toBeNull();

        const maxSeqRow = database.db
          .prepare("SELECT MAX(seq) AS max_seq FROM transcript_events WHERE session_id = ?")
          .get(entry.sessionId) as { max_seq?: unknown };
        expect(marker?.drainedThroughSeq).toBe(maxSeqRow.max_seq);

        const seqRows = database.db
          .prepare(
            "SELECT seq FROM transcript_events WHERE session_id = ? AND json_extract(event_json, '$.type') = 'message'",
          )
          .all(entry.sessionId) as Array<{ seq: number }>;
        expect(seqRows.length).toBe(2);
        const epoch = marker?.epoch;
        const drainedThroughSeq = marker?.drainedThroughSeq;

        // Predicate true for a drained event.
        const predicate = (
          candidateSessionId: string,
          candidateSeq: number,
          candidateEpoch: number,
        ) =>
          candidateEpoch === epoch &&
          candidateSessionId === entry.sessionId &&
          drainedThroughSeq !== null &&
          candidateSeq <= (drainedThroughSeq as number);

        for (const row of seqRows) {
          expect(predicate(entry.sessionId, row.seq, epoch as number)).toBe(true);
        }
        // False for a higher seq.
        expect(predicate(entry.sessionId, (drainedThroughSeq as number) + 1, epoch as number)).toBe(
          false,
        );
        // False for a different session_id.
        expect(predicate("some-other-session-id", seqRows[0]!.seq, epoch as number)).toBe(false);
        // False for a different epoch.
        expect(predicate(entry.sessionId, seqRows[0]!.seq, (epoch as number) + 1)).toBe(false);
      },
    );
  });

  it("rollover: two drains with the same session_key but different session_ids leave the marker naming the second session_id + its watermark, epoch bumped twice", async () => {
    await withClaudeProjectsDir(
      [{ role: "user", uuid: "user-1", content: "first window" }],
      async ({ homeDir, sessionId: firstCliSessionId }) => {
        const sessionKey = "agent:main:openclaw-local-session-drain-rollover";
        const env = { ...process.env, OPENCLAW_STATE_DIR: stateDir };

        const firstEntry: SessionEntry = {
          sessionId: "openclaw-local-session-drain-rollover-a",
          updatedAt: Date.now(),
        };
        setCliSessionBinding(firstEntry, CLAUDE_CLI_PROVIDER, { sessionId: firstCliSessionId });
        const firstResult = await drainTailForResume({
          entry: firstEntry,
          sessionKey,
          agentId: "main",
          env,
          homeDir,
        });
        expect(firstResult).toEqual({ backfilled: 1, epoch: 1 });

        const database = openOpenClawAgentDatabase({ agentId: "main", env });
        const afterFirst = readSessionResumeEpoch(database, sessionKey);
        expect(afterFirst).toMatchObject({
          epoch: 1,
          state: "drained",
          sessionId: firstEntry.sessionId,
        });

        // Second window: a new transcript session_id under the same session_key.
        const secondEntry: SessionEntry = {
          sessionId: "openclaw-local-session-drain-rollover-b",
          updatedAt: Date.now(),
        };
        setCliSessionBinding(secondEntry, CLAUDE_CLI_PROVIDER, { sessionId: firstCliSessionId });
        const secondResult = await drainTailForResume({
          entry: secondEntry,
          sessionKey,
          agentId: "main",
          env,
          homeDir,
        });
        expect(secondResult.epoch).toBe(2);

        const afterSecond = readSessionResumeEpoch(database, sessionKey);
        expect(afterSecond).toMatchObject({
          epoch: 2,
          state: "drained",
          sessionId: secondEntry.sessionId,
        });
        expect(afterSecond?.drainedThroughSeq).not.toBeNull();
      },
    );
  });

  it("NULL tolerance: state='drained' with NULL sessionId/drainedThroughSeq (pre-fold-in row) resumes without refusal", async () => {
    const sessionKey = "agent:main:openclaw-local-session-drain-null-tolerance";
    const env = { ...process.env, OPENCLAW_STATE_DIR: stateDir };
    const entry: SessionEntry = {
      sessionId: "openclaw-local-session-drain-null-tolerance",
      updatedAt: Date.now(),
    };

    // Materialize a marker row via a no-op drain, then rewrite it to the
    // pre-fold-in shape (drained, NULL sessionId, NULL drainedThroughSeq).
    await drainTailForResume({ entry, sessionKey, agentId: "main", env });
    const database = openOpenClawAgentDatabase({ agentId: "main", env });
    writeSessionResumeEpoch(database, {
      sessionKey,
      epoch: 1,
      state: "drained",
      sessionId: null,
      drainedThroughSeq: null,
    });

    const scope = resolveSqliteScope({ agentId: "main", env, sessionKey });
    const resumed = readSessionResumeEpochForScope(
      { ...scope, sessionId: entry.sessionId },
      sessionKey,
    );
    expect(resumed).toMatchObject({ state: "drained", sessionId: null, drainedThroughSeq: null });
  });
});
