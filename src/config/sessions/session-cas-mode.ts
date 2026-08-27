/**
 * Backward-compat parachute for the primary `session_nodes` entry-CAS compare
 * predicate (PHASE-1.md §7). Default OFF: revision-integer CAS is the default
 * from day one. Setting `OPENCLAW_SESSION_CAS_VALUE_COMPARE=1` reverts the two
 * primary entry-CAS assert functions in `session-accessor.sqlite-entry-store.ts`
 * to legacy value-compare while the `revision` column keeps bumping on every
 * write in both modes. One-release parachute — removed with the flag-removal
 * changeset (§7).
 */
export function sessionCasValueCompareEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return env.OPENCLAW_SESSION_CAS_VALUE_COMPARE === "1";
}
