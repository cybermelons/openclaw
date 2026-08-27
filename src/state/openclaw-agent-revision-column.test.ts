import { afterEach, expect, test } from "vitest";
import { writeSessionEntry } from "../config/sessions/session-accessor.sqlite-entry-store.js";
import type { SessionEntry } from "../config/sessions/types.js";
import { createOpenClawTestState } from "../test-utils/openclaw-test-state.js";
import { OPENCLAW_AGENT_SCHEMA_VERSION } from "./openclaw-agent-db-contract.js";
import { ensureSessionRevisionColumn } from "./openclaw-agent-db-session-migrations.js";
import {
  closeOpenClawAgentDatabasesForTest,
  openOpenClawAgentDatabase,
  runOpenClawAgentWriteTransaction,
} from "./openclaw-agent-db.js";
import { closeOpenClawStateDatabaseForTest } from "./openclaw-state-db.js";

afterEach(() => {
  closeOpenClawAgentDatabasesForTest();
  closeOpenClawStateDatabaseForTest();
});

test("current-version agent databases lazily add the revision column at DEFAULT 0", async () => {
  const state = await createOpenClawTestState({ layout: "state-only", prefix: "agent-revision-" });
  try {
    const options = { agentId: "main", env: state.env };
    const initial = openOpenClawAgentDatabase(options);
    initial.db.exec("ALTER TABLE session_nodes DROP COLUMN revision;");
    initial.db
      .prepare(
        `INSERT INTO session_nodes
          (session_key, current_session_id, entry_json, entry_valid, updated_at)
         VALUES (?, ?, ?, ?, ?)`,
      )
      .run(
        "agent:main:pre-revision-era",
        "session-pre-revision-era",
        JSON.stringify({ sessionId: "session-pre-revision-era", updatedAt: 1 }),
        1,
        1,
      );
    closeOpenClawAgentDatabasesForTest();

    const reopened = openOpenClawAgentDatabase(options);
    const columns = reopened.db.prepare("PRAGMA table_info(session_nodes)").all() as Array<{
      name: string;
      notnull: number;
      type: string;
    }>;
    expect(columns.find((column) => column.name === "revision")).toMatchObject({
      type: "INTEGER",
      notnull: 1,
    });
    expect(reopened.db.prepare("PRAGMA user_version").get()?.user_version).toBe(
      OPENCLAW_AGENT_SCHEMA_VERSION,
    );
    // Pre-existing row migrated with no explicit backfill reads revision = 0 ("pre-revision era").
    expect(
      reopened.db
        .prepare("SELECT revision FROM session_nodes WHERE session_key = ?")
        .get("agent:main:pre-revision-era"),
    ).toEqual({ revision: 0 });

    // Re-running the additive migration directly against the already-migrated DB is a no-op.
    expect(() => ensureSessionRevisionColumn(reopened.db)).not.toThrow();
    expect(() => ensureSessionRevisionColumn(reopened.db)).not.toThrow();
    expect(
      reopened.db
        .prepare("SELECT revision FROM session_nodes WHERE session_key = ?")
        .get("agent:main:pre-revision-era"),
    ).toEqual({ revision: 0 });
  } finally {
    await state.cleanup();
  }
});

test("writing a session entry strictly increases session_nodes.revision", async () => {
  const state = await createOpenClawTestState({ layout: "state-only", prefix: "agent-revision-" });
  try {
    const options = { agentId: "main", env: state.env };
    const key = "agent:main:revision-write-target";
    const entry: SessionEntry = { sessionId: "session-revision-write-target", updatedAt: 100 };

    runOpenClawAgentWriteTransaction((database) => {
      writeSessionEntry(database, key, entry, {
        allowStoredAliases: true,
        previousEntry: null,
      });
    }, options);

    const database = openOpenClawAgentDatabase(options);
    const row = database.db
      .prepare("SELECT revision FROM session_nodes WHERE session_key = ?")
      .get(key) as { revision: number } | undefined;
    expect(row?.revision).toBeGreaterThanOrEqual(1);

    const firstWriteRevision = row?.revision ?? 0;
    const updatedEntry: SessionEntry = { ...entry, updatedAt: 200, label: "renamed" };
    runOpenClawAgentWriteTransaction((writeDatabase) => {
      writeSessionEntry(writeDatabase, key, updatedEntry, {
        allowStoredAliases: true,
        previousEntry: entry,
      });
    }, options);

    const rowAfterSecondWrite = database.db
      .prepare("SELECT revision FROM session_nodes WHERE session_key = ?")
      .get(key) as { revision: number } | undefined;
    expect(rowAfterSecondWrite?.revision ?? 0).toBeGreaterThan(firstWriteRevision);
  } finally {
    await state.cleanup();
  }
});
