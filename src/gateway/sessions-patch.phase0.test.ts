// Phase-0 characterization test: unread-clear vs live turn (agentStatus clobber).
// Pins current (buggy) behavior of projectSessionsPatchEntry: a read-receipt patch
// ({ unread: false }) unconditionally deletes agentStatus, even when that status
// reflects an actively-running turn rather than a stale/expired notice.
import { describe, expect, test } from "vitest";
import type { OpenClawConfig } from "../config/config.js";
import type { SessionEntry } from "../config/sessions.js";
import { projectSessionsPatchEntry } from "./sessions-patch.js";

const MAIN_SESSION_KEY = "agent:main:main";
const EMPTY_CFG = {} as OpenClawConfig;

describe("gateway sessions patch phase0: unread-clear vs live turn", () => {
  test("PINNED-BUG: marking a session read deletes agentStatus even while a turn is actively running", async () => {
    // Simulate an entry with agentStatus set as if a turn is currently in progress
    // (a live "working" note, not yet expired), per the shape used elsewhere for
    // agentStatus in sessions-patch.test.ts (note/attention/expiresAt).
    const store: Record<string, SessionEntry> = {
      [MAIN_SESSION_KEY]: {
        sessionId: "sess",
        updatedAt: 1,
        agentStatus: {
          note: "Working: running the build",
          expiresAt: Date.now() + 60_000,
        },
      } as SessionEntry,
    };

    const result = await projectSessionsPatchEntry({
      cfg: EMPTY_CFG,
      existingEntry: store[MAIN_SESSION_KEY],
      isLabelInUse: () => false,
      storeKey: MAIN_SESSION_KEY,
      patch: { key: MAIN_SESSION_KEY, unread: false },
    });

    expect(result.ok).toBe(true);
    if (!result.ok) {
      throw new Error(result.error.message);
    }

    // PINNED-BUG: #18 Phase 5 read-receipt split.
    // Current code (src/gateway/sessions-patch.ts ~lines 393-400) deletes
    // next.agentStatus unconditionally on { unread: false }, clobbering a
    // live-turn status. This asserts that CURRENT buggy behavior, not the fix.
    expect(result.entry.agentStatus).toBeUndefined();
  });
});
