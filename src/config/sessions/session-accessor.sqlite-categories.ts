import { executeSqliteQuerySync } from "../../infra/kysely-sync.js";
import { withOpenClawAgentDatabaseReadOnly } from "../../state/openclaw-agent-db-readonly.js";
import {
  getSessionKysely,
  resolveSqliteAgentScope,
  toDatabaseOptions,
} from "./session-accessor.sqlite-scope.js";
import type { SessionEntryListScope } from "./session-accessor.types.js";

/**
 * The category catalog: the distinct set of category names that have at least
 * one un-archived session row. Excludes null and empty/whitespace-only values.
 * Returned sorted and deduplicated.
 */
export function listSqliteLiveSessionCategories(scope: SessionEntryListScope = {}): string[] {
  const resolved = resolveSqliteAgentScope(scope);
  const databaseOptions = toDatabaseOptions(resolved);
  const result = withOpenClawAgentDatabaseReadOnly((database) => {
    const db = getSessionKysely(database.db);
    const rows = executeSqliteQuerySync(
      database.db,
      db
        .selectFrom("session_nodes")
        .select("category")
        .distinct()
        .where("archived_at", "is", null)
        .where("category", "is not", null),
    ).rows;
    return rows;
  }, databaseOptions);
  const rows = result.found ? result.value : [];

  const categories = new Set<string>();
  for (const row of rows) {
    const value = row.category;
    if (typeof value !== "string") continue;
    const trimmed = value.trim();
    if (trimmed.length === 0) continue;
    categories.add(trimmed);
  }
  return Array.from(categories).sort();
}
