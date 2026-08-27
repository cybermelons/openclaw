import { writeSessionEntry } from "./src/config/sessions/session-accessor.sqlite-entry-store.js";
// PHASE-3 CS-2 backfill tool (throwaway, one-shot — PHASE-3.md §2.5).
// Fixture/copy use only. NEVER point this at the live agent database.
//
// The census (tmp_phase3-divergence-census.ts) found 31 session_nodes rows
// where a raw column holds real data that `entry_json` lacks entirely:
//   - archived_at: 13 rows, blob has no `archivedAt` key.
//   - last_activity_at: 18 rows, blob has no `lastActivityAt` key.
// All other census divergences are derived-column/stale-generation artifacts,
// not backfill targets, and are left untouched.
//
// This tool takes the projected entry for each diverging row, sets the
// missing field(s) from the column value, and calls the canonical write path
// `writeSessionEntry` so blob + columns + revision are rewritten atomically
// (revision-CAS). One row at a time. Idempotent: after a row is fixed,
// column === blob, so a second run finds zero rows needing backfill for that
// row — no external checkpoint needed, the data itself is the checkpoint.
//
// Usage:
//   node --import tsx tmp_phase3-backfill.ts <db-path>            (dry run, writes nothing)
//   node --import tsx tmp_phase3-backfill.ts <db-path> --apply    (perform writes)
import { getSessionKysely } from "./src/config/sessions/session-accessor.sqlite-scope.js";
import {
  projectSessionEntry,
  type SessionEntryBlobRow,
} from "./src/config/sessions/session-entry-parse.js";
import { isSessionRowCorruptError } from "./src/config/sessions/session-row-corrupt-error.js";
import type { SessionEntry } from "./src/config/sessions/types.js";
import { executeSqliteQuerySync } from "./src/infra/kysely-sync.js";
import { openOpenClawAgentDatabase } from "./src/state/openclaw-agent-db.js";

type BackfillField = "archivedAt" | "lastActivityAt";

const FIELD_MAP: Array<{ column: "archived_at" | "last_activity_at"; field: BackfillField }> = [
  { column: "archived_at", field: "archivedAt" },
  { column: "last_activity_at", field: "lastActivityAt" },
];

function normalize(value: unknown): unknown {
  return value === null ? undefined : value;
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

function main(): void {
  const dbPath = process.argv[2];
  const apply = process.argv.includes("--apply");
  if (!dbPath) {
    console.error(
      "usage: node --import tsx tmp_phase3-backfill.ts <db-path> [--apply]\n" +
        "UNEXECUTED: no DB path was provided.",
    );
    process.exitCode = 1;
    return;
  }

  const database = openOpenClawAgentDatabase({ agentId: "main", path: dbPath });
  const db = getSessionKysely(database.db);

  const nodeRows = executeSqliteQuerySync(database.db, db.selectFrom("session_nodes").selectAll())
    .rows as Array<Record<string, unknown>>;

  const archivedAtFixed: string[] = [];
  const lastActivityAtFixed: string[] = [];
  let scanned = 0;
  let corrupt = 0;

  for (const row of nodeRows) {
    scanned += 1;
    const sessionKey = String(row.session_key);
    const blobRow: SessionEntryBlobRow = {
      current_session_id: row.current_session_id as string | undefined,
      entry_json: row.entry_json as string,
      updated_at: row.updated_at as number | undefined,
      owner_actor_type: row.owner_actor_type as string | null | undefined,
      owner_actor_id: row.owner_actor_id as string | null | undefined,
      owner_assigned_by_type: row.owner_assigned_by_type as string | null | undefined,
      owner_assigned_by_id: row.owner_assigned_by_id as string | null | undefined,
      owner_assigned_at: row.owner_assigned_at as number | null | undefined,
    };

    let entry: SessionEntry;
    try {
      entry = projectSessionEntry(sessionKey, blobRow);
    } catch (error) {
      if (isSessionRowCorruptError(error)) {
        corrupt += 1;
        continue;
      }
      throw error;
    }

    const needsBackfill: BackfillField[] = [];
    for (const { column, field } of FIELD_MAP) {
      const columnValue = row[column];
      const blobValue = (entry as unknown as Record<string, unknown>)[field];
      const normalizedColumn = normalize(columnValue);
      const normalizedBlob = normalize(blobValue);
      if (normalizedColumn !== normalizedBlob && isFiniteNumber(normalizedColumn)) {
        needsBackfill.push(field);
      }
    }

    if (needsBackfill.length === 0) {
      continue;
    }

    for (const field of needsBackfill) {
      if (field === "archivedAt") {
        archivedAtFixed.push(sessionKey);
      } else {
        lastActivityAtFixed.push(sessionKey);
      }
    }

    if (apply) {
      const updatedEntry: SessionEntry = { ...entry };
      for (const field of needsBackfill) {
        const column = field === "archivedAt" ? "archived_at" : "last_activity_at";
        const columnValue = row[column] as number;
        (updatedEntry as unknown as Record<string, unknown>)[field] = columnValue;
      }
      writeSessionEntry(database, sessionKey, updatedEntry);
    }
  }

  const report = {
    dbPath,
    [apply ? "applied" : "dryRun"]: true,
    archivedAtFixed,
    lastActivityAtFixed,
    counts: {
      scanned,
      corrupt,
      archivedAtFixed: archivedAtFixed.length,
      lastActivityAtFixed: lastActivityAtFixed.length,
    },
  };

  console.log(JSON.stringify(report, null, 2));
}

main();
