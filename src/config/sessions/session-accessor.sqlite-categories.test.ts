import { afterEach, describe, expect, it } from "vitest";
import { closeOpenClawAgentDatabasesForTest } from "../../state/openclaw-agent-db.js";
import { withOpenClawTestState } from "../../test-utils/openclaw-test-state.js";
import { upsertSessionEntryCore } from "./session-accessor.js";
import { listSqliteLiveSessionCategories } from "./session-accessor.sqlite-categories.js";

afterEach(() => {
  closeOpenClawAgentDatabasesForTest();
});

describe("listSqliteLiveSessionCategories", () => {
  it("returns distinct live categories, excluding archived and null-category rows", async () => {
    await withOpenClawTestState({ scenario: "minimal" }, async (state) => {
      const scope = (sessionKey: string) => ({
        agentId: "main",
        env: state.env,
        sessionKey,
      });

      await upsertSessionEntryCore(scope("agent:main:live-a"), {
        sessionId: "session-live-a",
        updatedAt: 1,
        category: "Gita",
      });
      await upsertSessionEntryCore(scope("agent:main:live-a-dup"), {
        sessionId: "session-live-a-dup",
        updatedAt: 1,
        category: "Gita",
      });
      await upsertSessionEntryCore(scope("agent:main:live-b"), {
        sessionId: "session-live-b",
        updatedAt: 1,
        category: "Work",
      });
      await upsertSessionEntryCore(scope("agent:main:archived"), {
        sessionId: "session-archived",
        updatedAt: 1,
        category: "Archived Only",
        archivedAt: 12345,
      });
      await upsertSessionEntryCore(scope("agent:main:no-category"), {
        sessionId: "session-no-category",
        updatedAt: 1,
      });

      const categories = listSqliteLiveSessionCategories({ agentId: "main", env: state.env });

      expect(categories).toEqual(["Gita", "Work"]);
    });
  });
});
