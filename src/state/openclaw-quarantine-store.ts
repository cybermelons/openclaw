// Dedicated quarantine decisions stay available when primary databases fail.
import { existsSync, mkdirSync } from "node:fs";
import path from "node:path";
import type { DatabaseSync } from "node:sqlite";
import { openNodeSqliteDatabase } from "../infra/node-sqlite.js";
import { applyPrivateModeSync } from "../infra/private-mode.js";
import {
  parseSqliteFileGeneration,
  readStableSqliteFileGeneration,
  sameSqliteFileGeneration,
  serializeSqliteFileGeneration,
  type SqliteFileGeneration,
} from "../infra/sqlite-file-generation.js";
import { VERSION } from "../version.js";
import { resolveOpenClawStateSqliteDir } from "./openclaw-state-db.paths.js";

const OPENCLAW_QUARANTINE_SCHEMA_VERSION = 4;
const OPENCLAW_QUARANTINE_BUSY_TIMEOUT_MS = 5_000;
const OPENCLAW_QUARANTINE_DIR_MODE = 0o700;
const OPENCLAW_QUARANTINE_FILE_MODE = 0o600;

/**
 * Row-level quarantine key space (PHASE-2.md §6), keyed by `session_key`
 * rather than the database-level `path`. Same store, separate table — added
 * at schema version 4. UNUSED by any write path until CS-4.
 */
const CREATE_QUARANTINED_SESSION_ROWS_TABLE_SQL = `
      CREATE TABLE IF NOT EXISTS quarantined_session_rows (
        session_key TEXT NOT NULL PRIMARY KEY,
        reason TEXT NOT NULL,
        quarantined_at INTEGER NOT NULL
      ) STRICT;`;

type OpenClawDatabaseKind = "agent" | "state";

export type OpenClawDatabaseQuarantine = {
  kind: OpenClawDatabaseKind;
  quarantinedAt: number;
  reason: string;
  /** The failing check name (e.g. "integrity_check", "SqliteSchemaVersionError"). Sticky-marker only. */
  failingCheck?: string;
  /** Where the quarantined corrupt file was moved. Sticky-marker only. */
  quarantinedFilePath?: string;
};

function resolveQuarantineStorePath(env: NodeJS.ProcessEnv): string {
  return path.join(resolveOpenClawStateSqliteDir(env), "openclaw-quarantine.sqlite");
}

function ensureQuarantineStoreDirectory(storePath: string): void {
  const dir = path.dirname(storePath);
  mkdirSync(dir, { recursive: true, mode: OPENCLAW_QUARANTINE_DIR_MODE });
  applyPrivateModeSync(dir, OPENCLAW_QUARANTINE_DIR_MODE);
}

function configureQuarantineWriter(database: DatabaseSync, storePath: string): void {
  database.exec(`
    PRAGMA busy_timeout = ${OPENCLAW_QUARANTINE_BUSY_TIMEOUT_MS};
    PRAGMA journal_mode = DELETE;
    PRAGMA synchronous = FULL;
  `);
  const userVersion = readQuarantineSchemaVersion(database, storePath);
  if (userVersion > OPENCLAW_QUARANTINE_SCHEMA_VERSION) {
    throw new Error(
      `OpenClaw quarantine store ${storePath} uses newer schema version ${userVersion}.`,
    );
  }
  if (userVersion === OPENCLAW_QUARANTINE_SCHEMA_VERSION) {
    return;
  }
  if (userVersion === 1) {
    database.exec(`
      BEGIN IMMEDIATE;
      ALTER TABLE quarantined_databases ADD COLUMN verified_generation TEXT;
      ALTER TABLE quarantined_databases ADD COLUMN failing_check TEXT;
      ALTER TABLE quarantined_databases ADD COLUMN quarantined_file_path TEXT;
      ${CREATE_QUARANTINED_SESSION_ROWS_TABLE_SQL}
      PRAGMA user_version = ${OPENCLAW_QUARANTINE_SCHEMA_VERSION};
      COMMIT;
    `);
    return;
  }
  if (userVersion === 2) {
    database.exec(`
      BEGIN IMMEDIATE;
      ALTER TABLE quarantined_databases ADD COLUMN failing_check TEXT;
      ALTER TABLE quarantined_databases ADD COLUMN quarantined_file_path TEXT;
      ${CREATE_QUARANTINED_SESSION_ROWS_TABLE_SQL}
      PRAGMA user_version = ${OPENCLAW_QUARANTINE_SCHEMA_VERSION};
      COMMIT;
    `);
    return;
  }
  if (userVersion === 3) {
    database.exec(`
      BEGIN IMMEDIATE;
      ${CREATE_QUARANTINED_SESSION_ROWS_TABLE_SQL}
      PRAGMA user_version = ${OPENCLAW_QUARANTINE_SCHEMA_VERSION};
      COMMIT;
    `);
    return;
  }
  database.exec(`
    BEGIN IMMEDIATE;
    CREATE TABLE IF NOT EXISTS quarantined_databases (
      path TEXT NOT NULL PRIMARY KEY,
      kind TEXT NOT NULL,
      reason TEXT NOT NULL,
      quarantined_at INTEGER NOT NULL,
      writer_app_version TEXT,
      verified_generation TEXT,
      failing_check TEXT,
      quarantined_file_path TEXT
    ) STRICT;
    ${CREATE_QUARANTINED_SESSION_ROWS_TABLE_SQL}
    PRAGMA user_version = ${OPENCLAW_QUARANTINE_SCHEMA_VERSION};
    COMMIT;
  `);
}

function readQuarantineSchemaVersion(database: DatabaseSync, storePath: string): number {
  const row = database.prepare("PRAGMA user_version").get() as
    | { user_version?: unknown }
    | undefined;
  const userVersion = row?.user_version;
  if (typeof userVersion !== "number" || !Number.isInteger(userVersion)) {
    throw new Error(`OpenClaw quarantine store ${storePath} has an invalid schema version.`);
  }
  return userVersion;
}

function withQuarantineWriter<T>(env: NodeJS.ProcessEnv, operation: (db: DatabaseSync) => T): T {
  const storePath = resolveQuarantineStorePath(env);
  const existed = existsSync(storePath);
  ensureQuarantineStoreDirectory(storePath);
  const database = openNodeSqliteDatabase(storePath);
  let completed = false;
  try {
    if (!existed) {
      applyPrivateModeSync(storePath, OPENCLAW_QUARANTINE_FILE_MODE);
    }
    configureQuarantineWriter(database, storePath);
    const result = operation(database);
    completed = true;
    return result;
  } finally {
    database.close();
    if (completed || !existed) {
      applyPrivateModeSync(storePath, OPENCLAW_QUARANTINE_FILE_MODE);
    }
  }
}

/** Read one authoritative quarantine decision without creating the store. */
export function readOpenClawDatabaseQuarantine(
  pathname: string,
  options: { env?: NodeJS.ProcessEnv } = {},
): OpenClawDatabaseQuarantine | undefined {
  const storePath = resolveQuarantineStorePath(options.env ?? process.env);
  // Clean installs pay one existence check. No directory or SQLite work.
  if (!existsSync(storePath)) {
    return undefined;
  }
  const database = openNodeSqliteDatabase(storePath);
  try {
    database.exec(`PRAGMA busy_timeout = ${OPENCLAW_QUARANTINE_BUSY_TIMEOUT_MS};`);
    const userVersion = readQuarantineSchemaVersion(database, storePath);
    if (userVersion === 0) {
      return undefined;
    }
    if (userVersion > OPENCLAW_QUARANTINE_SCHEMA_VERSION) {
      throw new Error(
        `OpenClaw quarantine store ${storePath} uses newer schema version ${userVersion}.`,
      );
    }
    const generationColumn = userVersion >= 2 ? ", verified_generation" : "";
    const markerColumns = userVersion >= 3 ? ", failing_check, quarantined_file_path" : "";
    const row = database
      .prepare(
        `SELECT kind, reason, quarantined_at${generationColumn}${markerColumns} FROM quarantined_databases WHERE path = ? LIMIT 1`,
      )
      .get(path.resolve(pathname)) as
      | {
          kind?: unknown;
          quarantined_at?: unknown;
          reason?: unknown;
          verified_generation?: unknown;
          failing_check?: unknown;
          quarantined_file_path?: unknown;
        }
      | undefined;
    if (!row) {
      return undefined;
    }
    if (
      (row.kind !== "agent" && row.kind !== "state") ||
      typeof row.reason !== "string" ||
      typeof row.quarantined_at !== "number" ||
      !Number.isInteger(row.quarantined_at) ||
      (row.verified_generation !== undefined &&
        row.verified_generation !== null &&
        typeof row.verified_generation !== "string") ||
      (row.failing_check !== undefined &&
        row.failing_check !== null &&
        typeof row.failing_check !== "string") ||
      (row.quarantined_file_path !== undefined &&
        row.quarantined_file_path !== null &&
        typeof row.quarantined_file_path !== "string")
    ) {
      throw new Error(`OpenClaw quarantine store ${storePath} contains an invalid row.`);
    }
    // The sticky corrupt-marker (failing_check/quarantined_file_path set) is
    // deliberately NOT generation-gated: it must survive a later clean open of
    // a restored/reinitialized file until an operator or verified restore
    // clears it (CORRUPTION-FALLBACK Item 3). Generation-gating below applies
    // only to the background-verifier quarantine path, which predates it.
    const isStickyMarker = typeof row.failing_check === "string";
    if (!isStickyMarker && typeof row.verified_generation === "string") {
      let verifiedGeneration: SqliteFileGeneration;
      try {
        verifiedGeneration = parseSqliteFileGeneration(row.verified_generation);
      } catch {
        throw new Error(`OpenClaw quarantine store ${storePath} contains an invalid row.`);
      }
      try {
        const currentGeneration = readStableSqliteFileGeneration(path.resolve(pathname));
        if (!sameSqliteFileGeneration(verifiedGeneration, currentGeneration)) {
          return undefined;
        }
      } catch {
        return undefined;
      }
    }
    return {
      kind: row.kind,
      quarantinedAt: row.quarantined_at,
      reason: row.reason,
      ...(typeof row.failing_check === "string" ? { failingCheck: row.failing_check } : {}),
      ...(typeof row.quarantined_file_path === "string"
        ? { quarantinedFilePath: row.quarantined_file_path }
        : {}),
    };
  } finally {
    database.close();
  }
}

/** Persist one authoritative quarantine decision. */
export function recordOpenClawDatabaseQuarantine(options: {
  env?: NodeJS.ProcessEnv;
  generation?: SqliteFileGeneration;
  kind: OpenClawDatabaseKind;
  path: string;
  reason: string;
  /** Set only for the sticky corrupt-marker path (CORRUPTION-FALLBACK Item 3). */
  failingCheck?: string;
  quarantinedFilePath?: string;
}): boolean {
  const serializedGeneration = options.generation
    ? serializeSqliteFileGeneration(options.generation)
    : null;
  try {
    return withQuarantineWriter(options.env ?? process.env, (database) => {
      database.exec("BEGIN IMMEDIATE;");
      try {
        database
          .prepare(
            `
              INSERT INTO quarantined_databases (
                path, kind, reason, quarantined_at, writer_app_version, verified_generation,
                failing_check, quarantined_file_path
              ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
              ON CONFLICT(path) DO UPDATE SET
                kind = excluded.kind,
                reason = excluded.reason,
                quarantined_at = excluded.quarantined_at,
                writer_app_version = excluded.writer_app_version,
                verified_generation = excluded.verified_generation,
                failing_check = excluded.failing_check,
                quarantined_file_path = excluded.quarantined_file_path
            `,
          )
          .run(
            path.resolve(options.path),
            options.kind,
            options.reason,
            Date.now(),
            VERSION,
            serializedGeneration,
            options.failingCheck ?? null,
            options.quarantinedFilePath ?? null,
          );
        database.exec("COMMIT;");
        return true;
      } catch (error) {
        database.exec("ROLLBACK;");
        throw error;
      }
    });
  } catch {
    return false;
  }
}

/**
 * True when a quarantine row is the sticky corrupt-marker (CORRUPTION-FALLBACK
 * Item 3) rather than the background-verifier's generation-gated quarantine.
 * Startup recovery guards consult this to decide whether to skip a session's
 * database rather than every quarantine reason.
 */
export function isOpenClawDatabaseCorruptMarker(
  quarantine: Pick<OpenClawDatabaseQuarantine, "failingCheck"> | undefined,
): boolean {
  return typeof quarantine?.failingCheck === "string";
}

/** Clear one authoritative quarantine decision. */
export function clearOpenClawDatabaseQuarantine(
  pathname: string,
  options: { env?: NodeJS.ProcessEnv } = {},
): boolean {
  const env = options.env ?? process.env;
  if (!existsSync(resolveQuarantineStorePath(env))) {
    return true;
  }
  try {
    return withQuarantineWriter(env, (database) => {
      database.exec("BEGIN IMMEDIATE;");
      try {
        database
          .prepare("DELETE FROM quarantined_databases WHERE path = ?")
          .run(path.resolve(pathname));
        database.exec("COMMIT;");
        return true;
      } catch (error) {
        database.exec("ROLLBACK;");
        throw error;
      }
    });
  } catch {
    return false;
  }
}

/**
 * Row-level quarantine marker for a single corrupt `session_nodes` row
 * (PHASE-2.md §6, CORRUPTION-FALLBACK Item 4). Same store as the
 * database-level quarantine (`OpenClawDatabaseQuarantine`), in a sibling
 * table keyed by `sessionKey` instead of a filesystem `path` — the two key
 * spaces never collide because they live in different tables.
 *
 * UNUSED until CS-4: this is API surface only (types + functions) so CS-4's
 * pipeline boundary can call it when it starts writing row-level markers on
 * `SessionRowCorruptError`. No caller exists yet.
 */
export type OpenClawSessionRowQuarantine = {
  sessionKey: string;
  quarantinedAt: number;
  reason: string;
};

/** Read one row-level quarantine marker for `sessionKey`, if any. */
export function readOpenClawSessionRowQuarantine(
  sessionKey: string,
  options: { env?: NodeJS.ProcessEnv } = {},
): OpenClawSessionRowQuarantine | undefined {
  const storePath = resolveQuarantineStorePath(options.env ?? process.env);
  if (!existsSync(storePath)) {
    return undefined;
  }
  const database = openNodeSqliteDatabase(storePath);
  try {
    database.exec(`PRAGMA busy_timeout = ${OPENCLAW_QUARANTINE_BUSY_TIMEOUT_MS};`);
    const userVersion = readQuarantineSchemaVersion(database, storePath);
    if (userVersion === 0) {
      return undefined;
    }
    if (userVersion > OPENCLAW_QUARANTINE_SCHEMA_VERSION) {
      throw new Error(
        `OpenClaw quarantine store ${storePath} uses newer schema version ${userVersion}.`,
      );
    }
    // Pre-v4 stores predate the sessionKey key-space; the table does not
    // exist yet and no marker can have been written.
    if (userVersion < 4) {
      return undefined;
    }
    const row = database
      .prepare(
        "SELECT reason, quarantined_at FROM quarantined_session_rows WHERE session_key = ? LIMIT 1",
      )
      .get(sessionKey) as { reason?: unknown; quarantined_at?: unknown } | undefined;
    if (!row) {
      return undefined;
    }
    if (
      typeof row.reason !== "string" ||
      typeof row.quarantined_at !== "number" ||
      !Number.isInteger(row.quarantined_at)
    ) {
      throw new Error(`OpenClaw quarantine store ${storePath} contains an invalid row.`);
    }
    return { sessionKey, quarantinedAt: row.quarantined_at, reason: row.reason };
  } finally {
    database.close();
  }
}

/** Persist one row-level quarantine marker for `sessionKey`. Never auto-cleared. */
export function recordOpenClawSessionRowQuarantine(options: {
  env?: NodeJS.ProcessEnv;
  sessionKey: string;
  reason: string;
}): boolean {
  try {
    return withQuarantineWriter(options.env ?? process.env, (database) => {
      database.exec("BEGIN IMMEDIATE;");
      try {
        database
          .prepare(
            `
              INSERT INTO quarantined_session_rows (session_key, reason, quarantined_at)
              VALUES (?, ?, ?)
              ON CONFLICT(session_key) DO UPDATE SET
                reason = excluded.reason,
                quarantined_at = excluded.quarantined_at
            `,
          )
          .run(options.sessionKey, options.reason, Date.now());
        database.exec("COMMIT;");
        return true;
      } catch (error) {
        database.exec("ROLLBACK;");
        throw error;
      }
    });
  } catch {
    return false;
  }
}

/** Clear one row-level quarantine marker. Operator (doctor) or verified restore only. */
export function clearOpenClawSessionRowQuarantine(
  sessionKey: string,
  options: { env?: NodeJS.ProcessEnv } = {},
): boolean {
  const env = options.env ?? process.env;
  if (!existsSync(resolveQuarantineStorePath(env))) {
    return true;
  }
  try {
    return withQuarantineWriter(env, (database) => {
      database.exec("BEGIN IMMEDIATE;");
      try {
        database
          .prepare("DELETE FROM quarantined_session_rows WHERE session_key = ?")
          .run(sessionKey);
        database.exec("COMMIT;");
        return true;
      } catch (error) {
        database.exec("ROLLBACK;");
        throw error;
      }
    });
  } catch {
    return false;
  }
}
