// Covers the unguarded fallback stat on a `sqlite:` sentinel sessionFile.
import { describe, expect, it } from "vitest";
import { hasCliSessionTranscript } from "../../agents/cli-runner/session-history.js";

describe("isSqliteTranscriptTarget guard (unwired)", () => {
  it(// PINNED-BUG: paths.ts isSqliteTranscriptTarget() is never called by any reader;
  // hasCliSessionTranscript falls through to fsp.lstat() on the raw `sqlite:` sentinel
  // when the SQLite store read comes back empty, silently reporting "no transcript"
  // instead of explicitly recognizing a SQLite-backed session. Follow-up: wire the
  // guard into session-history.ts loadCliSessionEntries/hasCliSessionTranscript
  // (cybermelons/openclaw#27).
  "reports no transcript for a sqlite-backed session when the store read is empty, via the unguarded lstat catch rather than an explicit sqlite-target check", async () => {
    const result = await hasCliSessionTranscript({
      sessionId: "pinned-bug-missing-store-rows",
      sessionFile: "sqlite:main:pinned-bug-missing-store-rows:/nonexistent/store.sqlite",
      agentId: "main",
    });

    // Buggy-but-current behavior: the sentinel string hits fsp.lstat() unguarded,
    // throws ENOENT, and the outer catch collapses it to `false` — indistinguishable
    // from a session that genuinely has no transcript at all.
    expect(result).toBe(false);
  });
});
