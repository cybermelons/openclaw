import { describe, expect, it, vi } from "vitest";
import type { SessionEntry } from "../../config/sessions.js";

// Issue #14 (Route C): a chat-history READ must not WRITE a transcript backfill. The
// history-serve reconcile drain raced the live mirror's end-of-turn append and produced
// duplicate turns on resume; crash-recovery dispatch (main-session-restart-dispatch.ts)
// already re-drains genuinely lost turns, so history-serve must never call
// reconcileCliTranscript. This mock lets the regression test assert that directly.
const reconcileCliTranscriptMock = vi.hoisted(() => vi.fn().mockResolvedValue({ status: "noop" }));
vi.mock("../../agents/cli-transcript-reconcile.js", () => ({
  reconcileCliTranscript: reconcileCliTranscriptMock,
}));

// A bound CLI-imported session (resolveClaudeCliBindingSessionId returning a value) is the
// exact condition that used to gate the removed drain call, so force it here to exercise
// that code path.
vi.mock("../cli-session-history.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../cli-session-history.js")>();
  return {
    ...actual,
    resolveClaudeCliBindingSessionId: vi.fn(() => "mock-cli-session-id"),
    readChatHistoryCliSessionImportSnapshot: vi.fn(async () => ({ messages: [], imported: false })),
    resolveChatHistoryWithCliSessionImports: vi.fn(() => ({ messages: [], imported: false })),
  };
});

// Avoid touching real session storage: the tail read only needs to resolve to an empty page.
vi.mock("../session-transcript-readers.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../session-transcript-readers.js")>();
  return {
    ...actual,
    readRecentSessionMessagesWithStatsAsync: vi.fn(async () => ({
      messages: [],
      totalMessages: 0,
    })),
    readSessionMessagesAsync: vi.fn(async () => []),
  };
});

const { enrichChatHistoryCompactionMarkers, readChatHistoryPage } =
  await import("./chat-history-pages.js");

describe("enrichChatHistoryCompactionMarkers", () => {
  it("joins checkpoint token metrics to the matching transcript marker", () => {
    const marker = {
      role: "system",
      __openclaw: { kind: "compaction", id: "compact-entry-1", seq: 4 },
    };
    const entry = {
      compactionCheckpoints: [
        {
          checkpointId: "checkpoint-1",
          sessionKey: "main",
          sessionId: "session-1",
          createdAt: 1_000,
          reason: "auto-threshold",
          tokensBefore: 900_000,
          tokensAfter: 24_700,
          preCompaction: { sessionId: "session-1" },
          postCompaction: { sessionId: "session-1", entryId: "compact-entry-1" },
        },
      ],
    } as SessionEntry;

    const result = enrichChatHistoryCompactionMarkers([marker], entry);

    expect(result[0]).toEqual({
      ...marker,
      __openclaw: {
        ...marker["__openclaw"],
        tokensBefore: 900_000,
        tokensAfter: 24_700,
      },
    });
    expect(marker["__openclaw"]).not.toHaveProperty("tokensBefore");
  });

  it("preserves message identity without a matching checkpoint", () => {
    const marker = {
      role: "system",
      __openclaw: { kind: "compaction", id: "compact-entry-1" },
    };

    const result = enrichChatHistoryCompactionMarkers([marker], undefined);

    expect(result[0]).toBe(marker);
  });
});

describe("readChatHistoryPage — history-serve must not reconcile (issue #14, Route C)", () => {
  it("never calls reconcileCliTranscript on a mid-turn history read, even for a CLI-bound session", async () => {
    const entry = {
      sessionId: "session-1",
      sessionStartedAt: 1_000,
    } as SessionEntry;

    await readChatHistoryPage({
      entry,
      provider: "claude-cli",
      sessionId: "session-1",
      storePath: "/tmp/mock-store",
      sessionAgentId: "agent-1",
      canonicalKey: "agent:main:session-1",
      max: 50,
      maxHistoryBytes: 1024 * 1024,
      effectiveMaxChars: 4000,
      offset: undefined,
      messageId: undefined,
    });

    // A read path must not write: history-serve draining the CLI transcript here would
    // race the live mirror's end-of-turn append and re-append a turn already written,
    // producing the duplicate-turn-on-resume bug this test guards against. Backfill on
    // resume is owned exclusively by crash-recovery dispatch.
    expect(reconcileCliTranscriptMock).not.toHaveBeenCalled();
  });
});
