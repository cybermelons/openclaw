// Phase 2 CS-2 characterization harness (Delta B, PHASE-2.md §8 T-P2d / §11 CS-2 row).
//
// Records the PRE-COLLAPSE outputs of the 2 named projection functions that
// CS-3/CS-4 will consolidate into one parser + one pipeline:
//   - parseSessionEntryJson              (session-accessor.sqlite-status.ts)
//   - parseReadableSqliteSessionEntryRow (session-accessor.sqlite-entry-store.ts)
//
// This is a SAFETY NET, not a design test: it asserts exact current behavior,
// including current quirks (e.g. `parseReadableSqliteSessionEntryRow` throwing
// on some inputs where `parseSessionEntryJson` silently returns null). CS-3/CS-4
// must reproduce these recorded outputs field-for-field (or explicitly note a
// documented divergence) — this file is the frozen baseline they gate against.
//
// Zero production changes. Test + fixtures only.
import { beforeEach, describe, expect, it } from "vitest";
import type { OpenClawAgentDatabase } from "../../state/openclaw-agent-db.js";
import { useTempSqliteSessionStore } from "./phase0-fixtures.test-support.js";
import {
  parseSessionEntryBlob,
  readCanonicalSqliteSessionEntryRow,
  type SessionEntryBlobRow,
} from "./session-entry-parse.js";
import type { SessionEntry } from "./types.js";

// Local shims reproducing the exact pre-collapse call contracts this oracle
// pins (Delta B): CS-3/CS-4 deleted both named functions, routing every real
// caller through `projectSessionEntry`/`readCanonicalSqliteSessionEntryRow`.
// This file's job is to prove the frozen baseline still holds, so the shims
// intentionally do NOT use the new required-`participants`-array pipeline
// boundary (`projectSessionEntry`) — that shape change is real and pinned
// elsewhere (session-accessor.sqlite-data-version.test.ts), not here.

/** Shim for the deleted participant-less, silent-null `parseSessionEntryJson`. */
function parseSessionEntryJson(row: SessionEntryBlobRow): SessionEntry | null {
  const result = parseSessionEntryBlob("shim", row);
  return result.ok ? result.entry : null;
}

/** Shim for the deleted participant-full, throwing `parseReadableSqliteSessionEntryRow`. */
function parseReadableSqliteSessionEntryRow(
  database: Pick<OpenClawAgentDatabase, "db">,
  row: { current_session_id: string; session_key: string } & SessionEntryBlobRow,
): SessionEntry | null {
  return readCanonicalSqliteSessionEntryRow(database, row);
}

type RawSessionNodeRow = {
  current_session_id: string;
  entry_json: string;
  owner_actor_id?: string | null;
  owner_actor_type?: string | null;
  owner_assigned_at?: number | null;
  owner_assigned_by_id?: string | null;
  owner_assigned_by_type?: string | null;
  session_key: string;
  updated_at: number;
};

type ParticipantSeed = {
  actorId: string;
  actorSource?: string;
  actorType: "agent" | "human";
  firstPromptedAt: number;
  lastPromptedAt: number;
};

type RecordedOutcome =
  | { entry: unknown; threw: false }
  | { threw: true; errorMessage: string; errorName: string };

/** One corpus fixture: a session_nodes row shape + optional participant satellite rows,
 * plus the RECORDED pre-collapse output of each of the 2 named functions (the frozen
 * baseline CS-3/CS-4 must reproduce). */
type Fixture = {
  axis: string;
  name: string;
  participants?: ParticipantSeed[];
  /** Recorded current output of parseReadableSqliteSessionEntryRow on this fixture's row. */
  recordedReadable: RecordedOutcome;
  /** Recorded current output of parseSessionEntryJson on this fixture's row. */
  recordedJsonOnly: RecordedOutcome;
  /** Omit owner_* keys entirely to simulate a pre-owner-column database row shape. */
  row: RawSessionNodeRow;
  /** Whether to also seed a matching session_windows row (retained-window branch). */
  seedRetainedWindow?: boolean;
};

const store = useTempSqliteSessionStore();

function insertRow(fixture: Fixture): void {
  const db = store.database().db;
  const hasOwnerColumns = Object.hasOwn(fixture.row, "owner_actor_type");
  if (hasOwnerColumns) {
    db.prepare(
      `INSERT INTO session_nodes
         (session_key, current_session_id, entry_json, updated_at,
          owner_actor_type, owner_actor_id, owner_assigned_by_type, owner_assigned_by_id, owner_assigned_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      fixture.row.session_key,
      fixture.row.current_session_id,
      fixture.row.entry_json,
      fixture.row.updated_at,
      fixture.row.owner_actor_type ?? null,
      fixture.row.owner_actor_id ?? null,
      fixture.row.owner_assigned_by_type ?? null,
      fixture.row.owner_assigned_by_id ?? null,
      fixture.row.owner_assigned_at ?? null,
    );
  } else {
    // Pre-feature-column shape: row object literally lacks owner_* keys, exercising
    // the same "undefined field" path a tableHasColumn=false SELECT would produce.
    db.prepare(
      `INSERT INTO session_nodes (session_key, current_session_id, entry_json, updated_at)
       VALUES (?, ?, ?, ?)`,
    ).run(
      fixture.row.session_key,
      fixture.row.current_session_id,
      fixture.row.entry_json,
      fixture.row.updated_at,
    );
  }
  if (fixture.seedRetainedWindow) {
    db.prepare(
      `INSERT INTO session_windows
         (session_id, session_key, session_scope, created_at, updated_at)
       VALUES (?, ?, 'conversation', ?, ?)`,
    ).run(
      fixture.row.current_session_id,
      fixture.row.session_key,
      fixture.row.updated_at,
      fixture.row.updated_at,
    );
  }
  if (fixture.participants && fixture.participants.length > 0) {
    db.exec(`
      CREATE TABLE IF NOT EXISTS session_participants (
        session_key TEXT NOT NULL,
        actor_type TEXT NOT NULL,
        actor_id TEXT NOT NULL,
        actor_source TEXT,
        first_prompted_at INTEGER NOT NULL,
        last_prompted_at INTEGER NOT NULL,
        PRIMARY KEY (session_key, actor_type, actor_id)
      )`);
    for (const participant of fixture.participants) {
      db.prepare(
        `INSERT INTO session_participants
           (session_key, actor_type, actor_id, actor_source, first_prompted_at, last_prompted_at)
         VALUES (?, ?, ?, ?, ?, ?)`,
      ).run(
        fixture.row.session_key,
        participant.actorType,
        participant.actorId,
        participant.actorSource ?? null,
        participant.firstPromptedAt,
        participant.lastPromptedAt,
      );
    }
  }
}

/** Recorded shape of `canonicalSessionKeyMigrationRequiredError`'s "invalid persisted session
 * row requires repair" throw, as produced by parseReadableSqliteSessionEntryRow today. */
function recordedMigrationRequiredThrow(sessionKey: string): RecordedOutcome {
  return {
    threw: true,
    errorName: "SessionCanonicalKeyMigrationRequiredError",
    errorMessage: `invalid persisted session row requires repair for ${sessionKey}; stop the Gateway and run openclaw doctor --fix`,
  };
}

function readRawRow(sessionKey: string) {
  const db = store.database().db;
  return db.prepare(`SELECT * FROM session_nodes WHERE session_key = ?`).get(sessionKey) as Record<
    string,
    unknown
  >;
}

// --- Corpus (§8 T-P2d): entry_valid states x pre-feature-column x participants ---

const CORPUS: Fixture[] = [
  {
    axis: "valid / owner-present / no-participants",
    name: "valid-owner-no-participants",
    row: {
      session_key: "agent:main:valid-owner",
      current_session_id: "sess-valid-owner",
      entry_json: JSON.stringify({ sessionId: "sess-valid-owner", updatedAt: 100 }),
      updated_at: 100,
      owner_actor_type: "human",
      owner_actor_id: "user-1",
      owner_assigned_by_type: null,
      owner_assigned_by_id: null,
      owner_assigned_at: null,
    },
    recordedJsonOnly: {
      threw: false,
      entry: {
        sessionId: "sess-valid-owner",
        updatedAt: 100,
        owner: { actor: { type: "human", id: "user-1" } },
      },
    },
    recordedReadable: {
      threw: false,
      entry: {
        sessionId: "sess-valid-owner",
        updatedAt: 100,
        owner: { actor: { type: "human", id: "user-1" } },
      },
    },
  },
  {
    axis: "valid / owner-present-with-assignedBy / no-participants",
    name: "valid-owner-assigned-by",
    row: {
      session_key: "agent:main:valid-owner-assigned",
      current_session_id: "sess-valid-owner-assigned",
      entry_json: JSON.stringify({ sessionId: "sess-valid-owner-assigned", updatedAt: 200 }),
      updated_at: 200,
      owner_actor_type: "agent",
      owner_actor_id: "agent-1",
      owner_assigned_by_type: "human",
      owner_assigned_by_id: "user-2",
      owner_assigned_at: 150,
    },
    recordedJsonOnly: {
      threw: false,
      entry: {
        sessionId: "sess-valid-owner-assigned",
        updatedAt: 200,
        owner: {
          actor: { type: "agent", id: "agent-1" },
          assignedBy: { type: "human", id: "user-2" },
          assignedAt: 150,
        },
      },
    },
    recordedReadable: {
      threw: false,
      entry: {
        sessionId: "sess-valid-owner-assigned",
        updatedAt: 200,
        owner: {
          actor: { type: "agent", id: "agent-1" },
          assignedBy: { type: "human", id: "user-2" },
          assignedAt: 150,
        },
      },
    },
  },
  {
    axis: "valid / owner-columns-null / no-participants",
    name: "valid-no-owner",
    row: {
      session_key: "agent:main:valid-no-owner",
      current_session_id: "sess-valid-no-owner",
      entry_json: JSON.stringify({ sessionId: "sess-valid-no-owner", updatedAt: 300 }),
      updated_at: 300,
      owner_actor_type: null,
      owner_actor_id: null,
      owner_assigned_by_type: null,
      owner_assigned_by_id: null,
      owner_assigned_at: null,
    },
    recordedJsonOnly: {
      threw: false,
      entry: { sessionId: "sess-valid-no-owner", updatedAt: 300 },
    },
    recordedReadable: {
      threw: false,
      entry: { sessionId: "sess-valid-no-owner", updatedAt: 300 },
    },
  },
  {
    axis: "pre-feature-column (owner_* absent from row entirely)",
    name: "pre-feature-no-owner-columns",
    row: {
      session_key: "agent:main:pre-feature",
      current_session_id: "sess-pre-feature",
      entry_json: JSON.stringify({ sessionId: "sess-pre-feature", updatedAt: 400 }),
      updated_at: 400,
    },
    recordedJsonOnly: {
      threw: false,
      entry: { sessionId: "sess-pre-feature", updatedAt: 400 },
    },
    recordedReadable: {
      threw: false,
      entry: { sessionId: "sess-pre-feature", updatedAt: 400 },
    },
  },
  {
    axis: "valid / participant-empty (no satellite rows)",
    name: "participant-empty",
    row: {
      session_key: "agent:main:participant-empty",
      current_session_id: "sess-participant-empty",
      entry_json: JSON.stringify({
        sessionId: "sess-participant-empty",
        updatedAt: 500,
        createdActor: { type: "human", id: "user-1" },
      }),
      updated_at: 500,
      owner_actor_type: "human",
      owner_actor_id: "user-1",
      owner_assigned_by_type: null,
      owner_assigned_by_id: null,
      owner_assigned_at: null,
    },
    participants: [],
    recordedJsonOnly: {
      threw: false,
      entry: {
        sessionId: "sess-participant-empty",
        updatedAt: 500,
        createdActor: { type: "human", id: "user-1" },
        owner: { actor: { type: "human", id: "user-1" } },
      },
    },
    recordedReadable: {
      threw: false,
      entry: {
        sessionId: "sess-participant-empty",
        updatedAt: 500,
        createdActor: { type: "human", id: "user-1" },
        owner: { actor: { type: "human", id: "user-1" } },
      },
    },
  },
  {
    axis: "valid / participant-full (multiple, one equals owner and is excluded)",
    name: "participant-full",
    row: {
      session_key: "agent:main:participant-full",
      current_session_id: "sess-participant-full",
      entry_json: JSON.stringify({
        sessionId: "sess-participant-full",
        updatedAt: 600,
        createdActor: { type: "human", id: "owner-actor" },
      }),
      updated_at: 600,
      owner_actor_type: "human",
      owner_actor_id: "owner-actor",
      owner_assigned_by_type: null,
      owner_assigned_by_id: null,
      owner_assigned_at: null,
    },
    participants: [
      {
        actorType: "human",
        actorId: "owner-actor",
        firstPromptedAt: 10,
        lastPromptedAt: 20,
      },
      {
        actorType: "agent",
        actorId: "helper-agent",
        actorSource: "agent",
        firstPromptedAt: 30,
        lastPromptedAt: 40,
      },
      {
        actorType: "human",
        actorId: "other-human",
        actorSource: "channel",
        firstPromptedAt: 50,
        lastPromptedAt: 60,
      },
    ],
    recordedJsonOnly: {
      // parseSessionEntryJson does not read the participants satellite table at all.
      threw: false,
      entry: {
        sessionId: "sess-participant-full",
        updatedAt: 600,
        createdActor: { type: "human", id: "owner-actor" },
        owner: { actor: { type: "human", id: "owner-actor" } },
      },
    },
    recordedReadable: {
      // parseReadableSqliteSessionEntryRow projects participants and excludes the
      // one whose actor matches the effective owner (owner-actor).
      threw: false,
      entry: {
        sessionId: "sess-participant-full",
        updatedAt: 600,
        createdActor: { type: "human", id: "owner-actor" },
        owner: { actor: { type: "human", id: "owner-actor" } },
        participants: [
          { type: "agent", id: "helper-agent", source: "agent" },
          { type: "human", id: "other-human", source: "channel" },
        ],
        participantCount: 2,
      },
    },
  },
  {
    axis: "entry_valid divergence: current_session_id mismatch vs blob sessionId",
    name: "divergence-session-id-mismatch",
    row: {
      session_key: "agent:main:divergence-sessionid",
      current_session_id: "sess-different-from-blob",
      entry_json: JSON.stringify({ sessionId: "sess-blob-value", updatedAt: 700 }),
      updated_at: 700,
    },
    recordedJsonOnly: { threw: false, entry: null },
    recordedReadable: recordedMigrationRequiredThrow("agent:main:divergence-sessionid"),
  },
  {
    axis: "entry_valid divergence: updated_at mismatch vs blob updatedAt",
    name: "divergence-updated-at-mismatch",
    row: {
      session_key: "agent:main:divergence-updatedat",
      current_session_id: "sess-divergence-updatedat",
      entry_json: JSON.stringify({ sessionId: "sess-divergence-updatedat", updatedAt: 111 }),
      updated_at: 999,
    },
    recordedJsonOnly: { threw: false, entry: null },
    recordedReadable: recordedMigrationRequiredThrow("agent:main:divergence-updatedat"),
  },
  {
    axis: "corrupt: not valid JSON",
    name: "corrupt-not-json",
    row: {
      session_key: "agent:main:corrupt-not-json",
      current_session_id: "sess-corrupt-not-json",
      entry_json: "not-json",
      updated_at: 800,
    },
    recordedJsonOnly: { threw: false, entry: null },
    recordedReadable: recordedMigrationRequiredThrow("agent:main:corrupt-not-json"),
  },
  {
    axis: "corrupt: JSON array (not an object)",
    name: "corrupt-json-array",
    row: {
      session_key: "agent:main:corrupt-json-array",
      current_session_id: "sess-corrupt-json-array",
      entry_json: "[1,2,3]",
      updated_at: 810,
    },
    recordedJsonOnly: { threw: false, entry: null },
    recordedReadable: recordedMigrationRequiredThrow("agent:main:corrupt-json-array"),
  },
  {
    axis: "corrupt: missing sessionId/updatedAt identity",
    name: "corrupt-missing-identity",
    row: {
      session_key: "agent:main:corrupt-missing-identity",
      current_session_id: "sess-corrupt-missing-identity",
      entry_json: JSON.stringify({ foo: "bar" }),
      updated_at: 820,
    },
    recordedJsonOnly: { threw: false, entry: null },
    recordedReadable: recordedMigrationRequiredThrow("agent:main:corrupt-missing-identity"),
  },
  {
    axis: "empty-object blob ('{}') with NO retained window row",
    name: "empty-object-no-window",
    row: {
      session_key: "agent:main:empty-object-no-window",
      current_session_id: "sess-empty-object-no-window",
      entry_json: "{}",
      updated_at: 900,
    },
    recordedJsonOnly: { threw: false, entry: null },
    recordedReadable: recordedMigrationRequiredThrow("agent:main:empty-object-no-window"),
  },
  {
    axis: "empty-object blob ('{}') WITH a matching retained window row",
    name: "empty-object-with-window",
    row: {
      session_key: "agent:main:empty-object-with-window",
      current_session_id: "sess-empty-object-with-window",
      entry_json: "{}",
      updated_at: 910,
    },
    seedRetainedWindow: true,
    recordedJsonOnly: { threw: false, entry: null },
    recordedReadable: { threw: false, entry: null },
  },
];

describe("Phase 2 CS-2: pre-collapse projection-function equivalence fixtures", () => {
  beforeEach(() => {
    for (const fixture of CORPUS) {
      insertRow(fixture);
    }
  });

  describe.each(CORPUS)("$name ($axis)", (fixture) => {
    it("matches the recorded pre-collapse output of parseSessionEntryJson", () => {
      const row = readRawRow(fixture.row.session_key) as {
        current_session_id?: string;
        entry_json: string;
        owner_actor_id?: string | null;
        owner_actor_type?: string | null;
        owner_assigned_at?: number | null;
        owner_assigned_by_id?: string | null;
        owner_assigned_by_type?: string | null;
        updated_at?: number;
      };
      let outcome: RecordedOutcome;
      try {
        outcome = { entry: parseSessionEntryJson(row), threw: false };
      } catch (error) {
        outcome = {
          threw: true,
          errorName: error instanceof Error ? error.constructor.name : typeof error,
          errorMessage: error instanceof Error ? error.message : String(error),
        };
      }
      expect(outcome).toEqual(fixture.recordedJsonOnly);
    });

    it("matches the recorded pre-collapse output of parseReadableSqliteSessionEntryRow", () => {
      const database = store.database();
      const row = readRawRow(fixture.row.session_key) as {
        current_session_id: string;
        entry_json: string;
        owner_actor_id?: string | null;
        owner_actor_type?: string | null;
        owner_assigned_at?: number | null;
        owner_assigned_by_id?: string | null;
        owner_assigned_by_type?: string | null;
        session_key: string;
        updated_at: number;
      };
      let outcome: RecordedOutcome;
      try {
        outcome = { entry: parseReadableSqliteSessionEntryRow(database, row), threw: false };
      } catch (error) {
        outcome = {
          threw: true,
          errorName: error instanceof Error ? error.constructor.name : typeof error,
          errorMessage: error instanceof Error ? error.message : String(error),
        };
      }
      expect(outcome).toEqual(fixture.recordedReadable);
    });
  });

  // Explicit pins for the current divergence between the two parsers, so the
  // characterization is legible without cross-referencing the corpus table above.
  // If any of these fail, current behavior changed — CS-3/CS-4 must account for the
  // delta, not silently absorb it.
  it("pins: participant-full row differs between the two functions (participants field)", () => {
    const database = store.database();
    const fixture = CORPUS.find((entry) => entry.name === "participant-full");
    if (!fixture) {
      throw new Error("participant-full fixture missing from corpus");
    }
    const row = readRawRow(fixture.row.session_key) as never;
    const jsonOnly = parseSessionEntryJson(row);
    const readable = parseReadableSqliteSessionEntryRow(database, row);
    expect(jsonOnly?.participants).toBeUndefined();
    expect(readable?.participants).toHaveLength(2);
    expect(readable?.participantCount).toBe(2);
  });

  it("pins: '{}' blob without a retained window throws for parseReadableSqliteSessionEntryRow but returns null for parseSessionEntryJson", () => {
    const database = store.database();
    const fixture = CORPUS.find((entry) => entry.name === "empty-object-no-window");
    if (!fixture) {
      throw new Error("empty-object-no-window fixture missing from corpus");
    }
    const row = readRawRow(fixture.row.session_key) as never;
    expect(parseSessionEntryJson(row)).toBeNull();
    expect(() => parseReadableSqliteSessionEntryRow(database, row)).toThrow();
  });

  it("pins: '{}' blob WITH a retained window returns null for both functions (no throw)", () => {
    const database = store.database();
    const fixture = CORPUS.find((entry) => entry.name === "empty-object-with-window");
    if (!fixture) {
      throw new Error("empty-object-with-window fixture missing from corpus");
    }
    const row = readRawRow(fixture.row.session_key) as never;
    expect(parseSessionEntryJson(row)).toBeNull();
    expect(parseReadableSqliteSessionEntryRow(database, row)).toBeNull();
  });

  it("pins: pre-feature-column row (owner_* absent) projects no owner from either function", () => {
    const database = store.database();
    const fixture = CORPUS.find((entry) => entry.name === "pre-feature-no-owner-columns");
    if (!fixture) {
      throw new Error("pre-feature-no-owner-columns fixture missing from corpus");
    }
    const row = readRawRow(fixture.row.session_key) as never;
    expect(parseSessionEntryJson(row)?.owner).toBeUndefined();
    expect(parseReadableSqliteSessionEntryRow(database, row)?.owner).toBeUndefined();
  });
});
