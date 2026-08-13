// CLI transcript reconcile tests protect jsonl-to-SQLite backfill, idempotency, and no-binding skip.
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import type { SessionEntry } from "../config/sessions.js";
import { CLAUDE_CLI_PROVIDER } from "../gateway/cli-session-history.claude.js";
import {
  closeOpenClawAgentDatabasesForTest,
  openOpenClawAgentDatabase,
} from "../state/openclaw-agent-db.js";
import { closeOpenClawStateDatabaseForTest } from "../state/openclaw-state-db.js";
import { withEnvAsync } from "../test-utils/env.js";
import { setCliSessionBinding } from "./cli-session.js";
import { reconcileCliTranscript } from "./cli-transcript-reconcile.js";

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
