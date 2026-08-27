// App-level open-time validation on top of the live SQLite pragma check.
//
// CORRUPTION-FALLBACK.md Item 1, PHASE-1.md §6c. `assertSqliteIntegrity`
// proves page/b-tree/foreign-key health; it cannot prove the canonical
// session invariants the app relies on. This module adds: (a) `user_version`
// matches the migration head, and (b) a bounded smoke-read of `session_nodes`
// (count + parse the newest row's `entry_json`), inside a wall-clock budget.
import type { DatabaseSync } from "node:sqlite";
import { createSubsystemLogger } from "../logging/subsystem.js";

const openValidationLog = createSubsystemLogger("state/agent-db-open-validation");

/** Whole check must finish within this budget for a nominal session DB. */
export const OPENCLAW_AGENT_DB_OPEN_VALIDATION_BUDGET_MS = 750;

/**
 * Above this many session_nodes rows, downgrade the pragma check upstream to
 * `quick_check` territory is the caller's job; here it means: skip counting
 * every row and only smoke-read the single newest one, so validation itself
 * stays near-constant on a large DB.
 */
const OPENCLAW_AGENT_DB_OPEN_VALIDATION_OVERSIZED_ROW_THRESHOLD = 50_000;

export type OpenClawAgentDatabaseOpenValidationResult = {
  elapsedMs: number;
  overBudget: boolean;
  rowCount: number | undefined;
  newestEntryParsed: boolean;
};

/**
 * Bounded smoke-read of `session_nodes`: count (skipped on oversized tables)
 * plus a parse of the newest row's `entry_json`. Never throws for being over
 * budget — callers log a doctor warning and continue booting either way.
 * Throws only when the app-level invariant itself is violated (e.g. the
 * newest row's `entry_json` fails to parse), which is a real corruption
 * signal `integrity_check` cannot see.
 */
export function assertOpenClawAgentDatabaseOpenTimeValidation(
  database: DatabaseSync,
  pathname: string,
  options: { migrationHeadVersion: number },
): OpenClawAgentDatabaseOpenValidationResult {
  const startedAtMs = performance.now();
  const userVersionRow = database.prepare("PRAGMA user_version").get() as
    | { user_version?: unknown }
    | undefined;
  const userVersion = Number(userVersionRow?.user_version ?? 0);
  if (userVersion !== options.migrationHeadVersion) {
    throw new Error(
      `OpenClaw agent database ${pathname} open-time validation found user_version ${userVersion}; expected migration head ${options.migrationHeadVersion}.`,
    );
  }

  const approxRowCountRow = database
    .prepare(
      "SELECT (SELECT COUNT(*) FROM sqlite_master WHERE type = 'table' AND name = 'session_nodes') AS table_exists",
    )
    .get() as { table_exists?: unknown } | undefined;
  const hasSessionNodesTable = Number(approxRowCountRow?.table_exists ?? 0) === 1;

  let rowCount: number | undefined;
  let newestEntryParsed = true;
  if (hasSessionNodesTable) {
    // Cheap upper-bound check before paying for a full COUNT(*): avoid an
    // O(n) scan on an oversized table just to report a row count nobody
    // needs precisely for the budget decision.
    const overThreshold = database
      .prepare(
        `SELECT 1 FROM session_nodes LIMIT 1 OFFSET ${OPENCLAW_AGENT_DB_OPEN_VALIDATION_OVERSIZED_ROW_THRESHOLD}`,
      )
      .get();
    if (!overThreshold) {
      const countRow = database.prepare("SELECT COUNT(*) AS count FROM session_nodes").get() as
        | { count?: unknown }
        | undefined;
      rowCount = Number(countRow?.count ?? 0);
    }

    const newestRow = database
      .prepare("SELECT session_key, entry_json FROM session_nodes ORDER BY updated_at DESC LIMIT 1")
      .get() as { session_key?: unknown; entry_json?: unknown } | undefined;
    if (newestRow && typeof newestRow.entry_json === "string") {
      try {
        JSON.parse(newestRow.entry_json);
      } catch (parseError) {
        newestEntryParsed = false;
        throw new Error(
          `OpenClaw agent database ${pathname} open-time validation found an unparsable entry_json for session ${String(
            newestRow.session_key,
          )}: ${parseError instanceof Error ? parseError.message : String(parseError)}`,
        );
      }
    }
  }

  const elapsedMs = performance.now() - startedAtMs;
  const overBudget = elapsedMs > OPENCLAW_AGENT_DB_OPEN_VALIDATION_BUDGET_MS;
  if (overBudget) {
    // Never blocks boot: this is a doctor-visible signal only.
    openValidationLog.warn("agent database open-time validation exceeded its time budget", {
      budgetMs: OPENCLAW_AGENT_DB_OPEN_VALIDATION_BUDGET_MS,
      elapsedMs,
      path: pathname,
      rowCount,
    });
  }
  return { elapsedMs, overBudget, rowCount, newestEntryParsed };
}
