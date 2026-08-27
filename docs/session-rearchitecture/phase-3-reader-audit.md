# Phase 3 Reader Audit (CS-1)

Status: CS-1 output. Method: PHASE-3.md §2. Census tool: `tmp_phase3-divergence-census.ts`.

---

## 0. Decisions required before CS-2 (read first)

CS-1 is read-only and complete. Three findings block CS-2 (backfill) and CS-7 (drop).
Each needs an orchestrator / owner decision — they cannot be resolved autonomously.
Full detail in the cited sections; this is the decision summary.

1. **`owner_*` columns have no blob field — the Phase 3 remedy does not apply (§7.1, §5).**
   `owner` is stripped from the canonical blob (`store-entry-shape.ts:61` discards the key;
   corroborated at the writer — `session-accessor.sqlite-owner.ts:57-63` `assignSessionOwner`
   sets `owner_*` with no `entry_json` in the transaction, verified). The column is the ONLY
   storage for owner data. "Redirect the reader to the blob" is impossible. **Decision:** exempt
   the five `owner_*` columns permanently from the divergence check + column drop, OR change
   `assignSessionOwner` to also persist owner into the blob. Fable's spec did not anticipate a
   projected column with no blob twin.

2. **Orphan-cleanup DELETE gated on a column, no blob re-check (§6).**
   `planSqliteOrphanLifecycleTranscriptStateDeletes`
   (`session-accessor.sqlite-lifecycle-state.ts:591-597`) filters orphan windows on the
   `plugin_owner_id` COLUMN, then DELETEs — while its sibling `planSessionLifecycleArtifactCleanup`
   (:680-683) re-verifies against `entry.pluginOwnerId` from the blob. A second membership hazard
   of the same shape: `readSessionEntriesByStatus` (`sqlite-status.ts:39`) decides row-set
   membership by `WHERE status IN (...)` on the column, re-projects values from the blob but never
   re-checks membership — a stale-column row enters resume / replacement-projection paths.
   **Decision:** accept (orphan/historical rows may have no live blob to check), or add a blob
   re-verification before the side effect.

3. **CS-2 and CS-7 cross the deploy line.**
   CS-2 backfill mutates live production rows (blob-from-column CAS writes). CS-7 drop requires a
   shipped production soak between re-route and drop. Both require explicit go-ahead per the
   standing "get me before final deploy" instruction. Census drift is real (§8) but concentrated
   in safe reader paths (corruption-recovery + a self-healing detector); CS-2 must trace each
   field's divergence CAUSE to zero before any reader moves.

Nothing is committed. No production file is modified. Tip is still at Phase 2 (`7b325e14007`).

## 1. Method Note

This document follows PHASE-3.md §2.1 through §2.5.

1. The enumeration seed is the column list in `tmp_phase3-divergence-census.ts`
   (`SESSION_NODES_FIELD_MAP`, `SESSION_WINDOWS_FIELD_MAP`). This document
   grep-confirms each seed column against the real `CREATE TABLE` statement.
2. For each seed column, this document greps the whole source tree
   (`src/`, tests, migrations). It records file, line, statement kind, and
   consumer.
3. Writers are enumerated separately from readers, per §2.3. A writer is safe
   only if it writes `entry_json` in the SAME transaction, through the
   canonical write path, or through a proven equivalent (see §4 below for the
   one exception found).
4. The divergence census (§2.5) run 1 numbers are folded in at §8, verbatim,
   as given by the orchestrator. This document did not re-run the census.

### 1.1 Scope note (read this before using the table in §3)

The `CREATE TABLE session_nodes` statement has 28 columns. The
`CREATE TABLE session_windows` statement has 26 columns. The census
field-maps list 23 `session_nodes` columns and 4 `session_windows` columns.
The columns NOT in the census field-maps are one of two kinds:

- **Identity/control columns**: `session_key`, `current_session_id`,
  `entry_json`, `entry_valid`, `updated_at`, `revision` (session_nodes);
  `session_id`, `session_key` (session_windows). These are not duplicated
  business facts. They are the row identity or the write-transaction control
  fields themselves. They are out of the class (a)/(b)/(c) scheme by
  definition — the scheme classifies DUPLICATED fact columns, and these
  columns have no blob duplicate to diverge from.
- **session_windows-only structural/runtime columns** not in
  PHASE-3.md §4's "~10 duplicated columns" set (for example `channel`,
  `account_id`, `model`, `model_provider`, `chat_type`, `reason`,
  `session_scope`, `started_at`, `ended_at`, `primary_conversation_id`,
  `agent_harness_id`, `plugin_owner_id`, `hook_external_content_source`,
  `acp_owned`, `session_entry_provenance`, `transcript_updated_at`,
  `transcript_observed_at`, `previous_session_id`). These ARE written
  alongside `entry_json` inside `writeSessionEntry` (confirmed in §5), and a
  full per-column grep of all of them was NOT run for this document — the
  task scope directs enumeration from the census field-map as the
  authoritative seed. Where this document found direct evidence about one of
  these columns during writer-enumeration (for example
  `session_windows.account_id`/`channel` in `doctor-session-delivery-state.ts`,
  and `session_windows.primary_conversation_id` in
  `doctor-telegram-general-topic-conversations.ts`), it is recorded in §5 for
  completeness, marked "outside census seed."
- Any column access below not directly grep-verified is marked
  **unverified** rather than invented.

---

## 2. Authoritative Column List

Grep-confirmed against `src/state/openclaw-agent-schema.sql`.

### 2.1 `session_nodes` (confirmed CREATE TABLE, `src/state/openclaw-agent-schema.sql:15-45`)

| Column                  | In census seed?          |
| ----------------------- | ------------------------ |
| session_key (PK)        | identity — out of scheme |
| current_session_id      | identity — out of scheme |
| entry_json              | identity — out of scheme |
| entry_valid             | control — out of scheme  |
| updated_at              | identity — out of scheme |
| status                  | yes                      |
| created_at              | yes                      |
| created_via             | yes                      |
| created_actor_type      | yes                      |
| created_actor_id        | yes                      |
| owner_actor_type        | yes                      |
| owner_actor_id          | yes                      |
| owner_assigned_by_type  | yes                      |
| owner_assigned_by_id    | yes                      |
| owner_assigned_at       | yes                      |
| project_id              | NOT in census seed       |
| parent_session_key      | yes                      |
| spawned_by              | yes                      |
| fork_source_session_key | yes                      |
| fork_source_session_id  | yes                      |
| fork_source_entry_id    | yes                      |
| label                   | yes                      |
| display_name            | yes                      |
| category                | yes                      |
| icon                    | yes                      |
| pinned_at               | yes                      |
| archived_at             | yes                      |
| last_read_at            | yes                      |
| last_interaction_at     | yes                      |
| last_activity_at        | yes                      |
| revision                | control — out of scheme  |

Note: `project_id` is a real `session_nodes` column (added by
`ensureSessionProjectColumn`, `src/state/openclaw-agent-db-session-migrations.ts:273-280`)
but is NOT in the census tool's `SESSION_NODES_FIELD_MAP`. This document did
not audit `project_id` readers/writers in depth. Flagged **unverified /
out of census seed**.

### 2.2 `session_windows` (confirmed CREATE TABLE, `src/state/openclaw-agent-schema.sql:113-141`)

| Column                       | In census seed?          |
| ---------------------------- | ------------------------ |
| session_id (PK)              | identity — out of scheme |
| session_key                  | identity — out of scheme |
| previous_session_id          | NOT in census seed       |
| reason                       | NOT in census seed       |
| session_scope                | NOT in census seed       |
| created_at                   | NOT in census seed       |
| updated_at                   | identity — out of scheme |
| transcript_updated_at        | NOT in census seed       |
| transcript_observed_at       | NOT in census seed       |
| session_entry_provenance     | NOT in census seed       |
| acp_owned                    | NOT in census seed       |
| plugin_owner_id              | NOT in census seed       |
| hook_external_content_source | NOT in census seed       |
| started_at                   | NOT in census seed       |
| ended_at                     | NOT in census seed       |
| status                       | yes                      |
| chat_type                    | NOT in census seed       |
| channel                      | NOT in census seed       |
| account_id                   | NOT in census seed       |
| primary_conversation_id      | NOT in census seed       |
| model_provider               | NOT in census seed       |
| model                        | NOT in census seed       |
| agent_harness_id             | NOT in census seed       |
| parent_session_key           | yes                      |
| spawned_by                   | yes                      |
| display_name                 | yes                      |

PHASE-3.md §4 calls the census-seed set (`status`, `parent_session_key`,
`spawned_by`, `display_name`) "the ~10 duplicated session_windows columns."
The literal census seed for `session_windows` has 4 entries, not ~10. This
document records the discrepancy rather than guessing at the other 6. Marked
**unverified — census seed count is 4, PHASE-3.md §4 estimate is ~10**.

---

## 3. Per-Column Access Table

Grep scope: whole tree, files referencing `session_nodes` or
`session_windows` (115 files matched). Column matches were filtered to SQL
statement contexts (`.select(`, `.selectAll()`, `.where(`, `.orderBy(`,
`.groupBy(`, `.set(`, `.values(`, `insertInto`, `updateTable`, `onConflict`,
`CREATE TRIGGER`, `ALTER TABLE`). Generic-English column names (`status`,
`label`, `category`, `icon`, `created_at`) produce very large raw hit counts
in non-SQL contexts (variable names, comments); those non-SQL hits are
excluded below as not being column accesses.

| Column                                                                                                                                                                                             | File:line                                                                                                                                                           | Statement kind                                 | Consumer                                                                                                                                                         | Class                                                                                  | Gates side effect?                                                                                                                                                                                     |
| -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| status                                                                                                                                                                                             | `src/config/sessions/session-accessor.sqlite-status.ts:39`                                                                                                          | WHERE                                          | Row set filter; returned rows re-projected through `projectSessionEntry` (blob)                                                                                  | (b)-adjacent per §8(c)                                                                 | y — narrows the row set handed to `applySqliteSessionEntryReplacementProjection` (a write path), no membership re-check against blob afterward                                                         |
| status                                                                                                                                                                                             | `src/config/sessions/session-accessor.sqlite-entry.ts:320` (`hasSessionEntriesByStatusReadOnly`)                                                                    | WHERE + boolean existence                      | Boolean return, consumed directly as fact (not re-verified)                                                                                                      | (b)-adjacent per §8(c)                                                                 | **y** — gates `main-session-restart-recovery-shared.ts:157`, which filters store paths eligible for restart-recovery (a resume-class side effect). No blob re-verification after the boolean.          |
| status                                                                                                                                                                                             | `src/config/sessions/session-accessor.sqlite-entry.ts:291` (nearby `.selectFrom("session_nodes")`)                                                                  | SELECT                                         | unverified — not traced in this pass                                                                                                                             | unverified                                                                             | unverified                                                                                                                                                                                             |
| status                                                                                                                                                                                             | `src/config/sessions/legacy-main-session-migration.ts:281`                                                                                                          | SELECT (`["report_json","status"]`)            | unverified — one-time legacy migration reader                                                                                                                    | unverified                                                                             | unverified — likely one-shot migration tool, not a live query path                                                                                                                                     |
| status                                                                                                                                                                                             | `src/state/openclaw-agent-schema.sql:19`                                                                                                                            | column definition (CHECK)                      | n/a                                                                                                                                                              | n/a                                                                                    | n/a                                                                                                                                                                                                    |
| status                                                                                                                                                                                             | `src/state/openclaw-agent-db-session-migrations.ts` (index `idx_agent_session_nodes_status`)                                                                        | index definition                               | n/a                                                                                                                                                              | (a)                                                                                    | n                                                                                                                                                                                                      |
| archived_at                                                                                                                                                                                        | `src/config/sessions/session-accessor.sqlite-maintenance.ts:85`                                                                                                     | WHERE (`archived_at IS NULL`)                  | Row set pre-narrow; each candidate re-verified via `shouldPreserveMaintenanceEntry(entry.archivedAt)` where `entry` is blob-sourced (`store-maintenance.ts:484`) | (a) — filter is a cheap pre-narrow, side effect (row eviction) keys off the blob value | y, but blob-reverified — compliant with §8(c)'s escape clause                                                                                                                                          |
| archived_at                                                                                                                                                                                        | `src/state/openclaw-agent-schema.sql` (index `idx_agent_session_nodes_archived_at`)                                                                                 | index definition                               | n/a                                                                                                                                                              | (a)                                                                                    | n                                                                                                                                                                                                      |
| parent_session_key                                                                                                                                                                                 | `src/commands/doctor-session-incognito-key-repair.ts:223,231`                                                                                                       | SELECT                                         | Used to plan renames; not a runtime fact-read (one-shot doctor repair)                                                                                           | (b), doctor-repair-only                                                                | n                                                                                                                                                                                                      |
| parent_session_key                                                                                                                                                                                 | `src/commands/doctor-session-incognito-key-repair.ts:287-288` (session_windows), `305-306` (session_nodes)                                                          | UPDATE + WHERE                                 | Doctor rename write, see §4/§5                                                                                                                                   | writer, see §4                                                                         | n                                                                                                                                                                                                      |
| parent_session_key                                                                                                                                                                                 | `src/config/sessions/session-canonical-key.ts:150,175,188-197` (`assertCanonicalSqliteSessionKeysCurrent`)                                                          | SELECT + fact compare                          | Column value compared against blob-derived `entry.parentSessionKey`; on mismatch THROWS `SessionCanonicalKeyMigrationRequiredError`                              | (b) — explicit divergence detector, not a silent fact-read                             | y — the throw itself IS the side effect (refuses further operation until doctor repair). By design, not a hazard: this check treats divergence as fatal, which is the opposite of trusting the column. |
| parent_session_key                                                                                                                                                                                 | `src/state/openclaw-agent-schema.sql` (index `idx_agent_session_nodes_parent_session_key`)                                                                          | index definition                               | n/a                                                                                                                                                              | (a)                                                                                    | n                                                                                                                                                                                                      |
| spawned_by                                                                                                                                                                                         | `src/commands/doctor-session-incognito-key-repair.ts:223,231,293-294,311-312`                                                                                       | SELECT / UPDATE / WHERE                        | Same doctor-repair writer as parent_session_key                                                                                                                  | writer, see §4/§5                                                                      | n                                                                                                                                                                                                      |
| spawned_by                                                                                                                                                                                         | `src/config/sessions/session-canonical-key.ts:150,176,188-197`                                                                                                      | SELECT + fact compare                          | Same as parent_session_key above                                                                                                                                 | (b), fatal-divergence detector                                                         | y (throw is the side effect)                                                                                                                                                                           |
| spawned_by                                                                                                                                                                                         | `src/state/openclaw-agent-schema.sql` (index `idx_agent_session_nodes_spawned_by`)                                                                                  | index definition                               | n/a                                                                                                                                                              | (a)                                                                                    | n                                                                                                                                                                                                      |
| fork_source_session_key                                                                                                                                                                            | `src/commands/doctor-session-incognito-key-repair.ts:231,317-318`                                                                                                   | SELECT / UPDATE / WHERE                        | Doctor-repair writer                                                                                                                                             | writer, see §4/§5                                                                      | n                                                                                                                                                                                                      |
| fork_source_session_key                                                                                                                                                                            | `src/config/sessions/session-canonical-key.ts:151,177,197-198`                                                                                                      | SELECT + fact compare                          | Same fatal-divergence detector pattern                                                                                                                           | (b), fatal-divergence detector                                                         | y (throw)                                                                                                                                                                                              |
| owner_actor_type / owner_actor_id / owner_assigned_by_type / owner_assigned_by_id / owner_assigned_at                                                                                              | `src/config/sessions/session-accessor.sqlite-owner-projection.ts:32-53` (`projectSqliteSessionOwner`)                                                               | SELECT (via `SessionEntryBlobRow`) → fact-read | Builds `entry.owner` directly from these 5 columns                                                                                                               | **special case — see §7.1**                                                            | n                                                                                                                                                                                                      |
| owner_actor_type / owner_actor_id / owner_assigned_by_type / owner_assigned_by_id / owner_assigned_at                                                                                              | `src/config/sessions/session-accessor.sqlite-owner.ts:54-66` (`assignSessionOwner`)                                                                                 | UPDATE                                         | Sole writer; never touches `entry_json`                                                                                                                          | writer, see §7.1                                                                       | n                                                                                                                                                                                                      |
| owner_actor_type / owner_actor_id / owner_assigned_by_type / owner_assigned_by_id / owner_assigned_at                                                                                              | `src/config/sessions/session-accessor.sqlite-entry-store.ts:530-538` (`clearSqliteSessionEntryPreservingWindows`)                                                   | INSERT/UPDATE (nulls out on clear)             | writer                                                                                                                                                           | writer, see §7.1                                                                       | n                                                                                                                                                                                                      |
| display_name                                                                                                                                                                                       | grep hits inside SQL context: none found beyond the writer set in §5 (`writeSessionEntry` onConflict set, `doUpdateSet`) and the doctor canonical-repair copy in §5 | UPDATE/INSERT only                             | no SELECT-as-fact site found in this pass                                                                                                                        | (a) by absence of readers, pending confirmation                                        | n                                                                                                                                                                                                      |
| revision (control, not in scheme)                                                                                                                                                                  | throughout `session-accessor.sqlite-*` files                                                                                                                        | SELECT/WHERE/UPDATE (CAS)                      | row-name/CAS use only, not a business fact                                                                                                                       | n/a — CAS token, not a duplicated column                                               | n                                                                                                                                                                                                      |
| created_at, created_via, created_actor_type, created_actor_id, label, category, icon, pinned_at, last_read_at, last_interaction_at, last_activity_at, fork_source_session_id, fork_source_entry_id | No SQL-context SELECT/WHERE/ORDER BY/GROUP BY hits found beyond the `writeSessionEntry` writer set (§5) and index definitions                                       | UPDATE/INSERT/index only                       | none found                                                                                                                                                       | (a) by absence of fact-reads, pending confirmation                                     | n                                                                                                                                                                                                      |

### 3.1 Coverage caveat

The two `selectAll()` sites on `session_nodes` —
`src/config/sessions/session-accessor.sqlite-entry-store.ts:224`
(`readExactSessionEntryRow`) and
`src/config/sessions/session-accessor.sqlite-canonical-repair.ts:71`
(`readExactSessionEntryRowForCanonicalRepair`) — return every column,
including every census-seed column, on the raw row object. Both call sites
immediately pass the row into `readCanonicalSqliteSessionEntryRow` /
`projectSessionEntry`, which uses ONLY `current_session_id`, `entry_json`,
`updated_at`, and the 5 `owner_*` columns (§7.1) to build the returned
`SessionEntry`. The remaining raw-row columns (`status`, `display_name`,
`parent_session_key`, and so on) are present on the row object returned to
`ResolvedSessionEntryRow.row` but this document did NOT trace every caller
of `.row` to prove none of them reads a raw column as a fact instead of
`.entry`. This is a residual gap: `ResolvedSessionEntryRow.row` is a
`selectAll()`-shaped object available to any caller holding it, and a caller
reading `.row.status` instead of `.entry.status` would be an unaudited
fact-read. Flagged **unverified — needs a targeted grep of `.row.<column>`
call sites in a follow-up pass**, not fabricated as either safe or unsafe
here.

---

## 4. Writer-Enumeration Table

Per §2.3: every UPDATE/INSERT/trigger/backfill that touches a census-seed
column, and whether it writes `entry_json` in the same transaction through
the canonical path.

| Column(s)                                                                                                                                                                                                                                                                                      | Writer                                                                                                                           | File:line                                                                                                                                                                                                                   | Same-transaction entry_json via canonical path?                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| status, created_at, created_via, created_actor_type, created_actor_id, parent_session_key, spawned_by, fork_source_session_key, fork_source_session_id, fork_source_entry_id, label, display_name, category, icon, pinned_at, archived_at, last_read_at, last_interaction_at, last_activity_at | `writeSessionEntry`                                                                                                              | `src/config/sessions/session-accessor.sqlite-entry-store.ts:642-764` (session_nodes insert/onConflict) and `:765-797` (session_windows insert/onConflict, for `parent_session_key`, `spawned_by`, `display_name`, `status`) | **y** — canonical writer, same transaction as `entry_json`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| all session_nodes census-seed columns (nulled)                                                                                                                                                                                                                                                 | `clearSqliteSessionEntryPreservingWindows`                                                                                       | `src/config/sessions/session-accessor.sqlite-entry-store.ts:500-558`                                                                                                                                                        | y — writes `entry_json: "{}"` in the same INSERT/UPDATE, plus `entry_valid = -1` (marks the row invalid, not authoritative)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| owner_actor_type, owner_actor_id, owner_assigned_by_type, owner_assigned_by_id, owner_assigned_at                                                                                                                                                                                              | `assignSessionOwner`                                                                                                             | `src/config/sessions/session-accessor.sqlite-owner.ts:54-66`                                                                                                                                                                | **n — by design, see §7.1.** No `entry_json` write in this transaction. This is NOT a class (c) hazard because `entry_json` never carries `owner` as persisted truth (proven in §7.1); there is no blob value to diverge from.                                                                                                                                                                                                                                                                                                                                                                                                                               |
| session_key, parent_session_key, spawned_by, fork_source_session_key (session_nodes); session_key, parent_session_key, spawned_by (session_windows)                                                                                                                                            | `updateSessionKeyColumns` (raw column UPDATE) + `rewriteSessionEntryJsonReferences` (via `writeValidatedDoctorSessionEntryJson`) | `src/commands/doctor-session-incognito-key-repair.ts:274-356` (columns), `:358-383` (entry_json)                                                                                                                            | **y, but not via the canonical `writeSessionEntry` path.** Both functions run inside the SAME `runOpenClawAgentWriteTransaction` call (`doctor-session-incognito-key-repair.ts:110-114`, `applyReservedIncognitoKeyRenames`). `rewriteSessionEntryJsonReferences` uses `writeValidatedDoctorSessionEntryJson` (`src/commands/doctor-session-entry-rewrite.ts:18-52`), which the task's ground truth confirms writes `entry_json` + settles `entry_valid` together — the documented "non-canonical but non-hazardous" writer, not class (c). See §7.2 for the residual risk this raises.                                                                      |
| status, account_id, channel (session_windows) — **account_id/channel outside census seed**                                                                                                                                                                                                     | `doctor-session-delivery-state.ts` (`applyDeliveryRewrites`)                                                                     | `src/commands/doctor-session-delivery-state.ts:131-145`                                                                                                                                                                     | Writes `account_id`/`channel` via raw UPDATE on `session_windows`, in the SAME loop iteration as `writeValidatedDoctorSessionEntryJson(database, rewrite.row, rewrite.entryJson)` immediately before it (line 135), but as two separate statements, not proven to share one transaction from this excerpt alone. **Unverified whether both statements are inside one `runOpenClawAgentWriteTransaction` call** — needs the caller of `applyDeliveryRewrites` traced. Recorded because it touches `session_windows` state alongside an entry_json rewrite; `account_id`/`channel` are outside the census seed so no census divergence signal exists for them. |
| primary_conversation_id (session_windows) — **outside census seed**                                                                                                                                                                                                                            | `doctor-telegram-general-topic-conversations.ts`                                                                                 | `src/commands/doctor-telegram-general-topic-conversations.ts:291-292`                                                                                                                                                       | Raw UPDATE, outside census seed, not further traced in this pass.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| session_nodes insert placeholder (`entry_json: "{}"`, `entry_valid: -1`)                                                                                                                                                                                                                       | `session-accessor.sqlite-transcript-state.ts` (window/node bootstrap)                                                            | `src/config/sessions/session-accessor.sqlite-transcript-state.ts:130-165`                                                                                                                                                   | y — inserts `entry_json: "{}"` in the same INSERT; census-seed columns are omitted (default NULL), so no divergence is introduced                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| session_windows column copy during canonical-repair merge (including `parent_session_key`, `spawned_by`, `display_name` if present on the copied row)                                                                                                                                          | `session-accessor.sqlite-canonical-repair.ts` (`rehomeLegacySessionNodeArtifacts`-adjacent window merge)                         | `src/config/sessions/session-accessor.sqlite-canonical-repair.ts:395-431`                                                                                                                                                   | The values copied originate from an existing `session_windows` row that was itself written by `writeSessionEntry` for its own owning node — this is a row RELOCATION, not a new fact write. Not classified as an independent hazard; flagged **unverified** for whether the copy can ever run without also rehoming the owning node's `entry_json` in the same transaction.                                                                                                                                                                                                                                                                                  |

---

## 5. Class (c) Hazard List

Per §2.4, the per-field truth-decision rule applies here.

**Prime-suspect fields from census run 1 (nonzero divergence):**
`display_name`, `status`, `parent_session_key`, `spawned_by`,
`last_activity_at`, `archived_at` (session_nodes: `last_activity_at`,
`archived_at`, `parent_session_key`; session_windows: `display_name`,
`status`, `parent_session_key`, `spawned_by`).

| Field              | Table           | Bypassing writer (file:line) or "no source writer"                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  | Two writers conflict (§2.4 ESCALATE)?                                                                            |
| ------------------ | --------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------- |
| last_activity_at   | session_nodes   | **No source writer found in this pass that bypasses the canonical path.** `writeSessionEntry` is the only writer found (§4). Census run 1 shows 18 divergent rows. Per §2.3 step 4, this is treated as class (c) on the census signal alone: "the census catches historical writers that no longer exist in the source." Working hypothesis: a retired writer (pre-dating this source tree) wrote `last_activity_at` directly, or a field-shape rename left old rows stale. **Not confirmed — flagged for CS-2 investigation, not resolved here.**                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  | Not evaluated — no second writer identified                                                                      |
| archived_at        | session_nodes   | Same as above: no bypassing writer found in the source tree. Census run 1 shows 13 divergent rows. Class (c) by census signal (§2.3 step 4), cause unconfirmed.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     | Not evaluated                                                                                                    |
| parent_session_key | session_nodes   | Two writer candidates: (1) `writeSessionEntry` (canonical, §4); (2) `updateSessionKeyColumns` in `src/commands/doctor-session-incognito-key-repair.ts:302-307` (raw column UPDATE, same-transaction `entry_json` rewrite via a non-canonical path, §4/§7.2). Census run 1 shows 1 divergent row. Given the doctor-repair writer is same-transaction and value-consistent by construction (it renames the SAME string in both the column and the blob), the 1-row divergence is more likely explained by a case the doctor path does not cover, OR a stale row from before the doctor path existed. **Not confirmed — flagged for CS-2 investigation.**                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              | Not evaluated — insufficient evidence to call this a genuine two-writer value conflict rather than one stale row |
| display_name       | session_windows | **No source writer found that bypasses the canonical path.** `writeSessionEntry`'s `session_windows` onConflict set (`session-accessor.sqlite-entry-store.ts:794`) is the only writer found. Census run 1 shows 175 divergent rows — the largest divergence in the census. This magnitude is inconsistent with "one stale row"; it suggests either a systematic historical writer no longer in the tree, or a semantic mismatch between what `session_windows.display_name` is populated FROM at write time versus what the census computes as the "true" blob value for a `session_windows` row (recall: the census projects the OWNING NODE's blob for every window row it owns, per the census tool's own comment at `tmp_phase3-divergence-census.ts:90-94`). Given a session_key can own many session_windows rows (many `session_id` generations under one node), and `display_name` is written per-window at `writeSessionEntry` time from that specific write's `entry.displayName`, an OLDER window row will retain whatever `displayName` was current at ITS OWN write time, while the census compares it against the node's CURRENT blob `displayName`. **This is a strong candidate for a false-positive divergence caused by the census's comparison design (current blob vs. historical per-window write), not a genuine writer bypass.** Flagged for CS-2 to distinguish "stale-by-design old generation" from "true divergence" before backfilling. | Not evaluated                                                                                                    |
| status             | session_windows | Same writer as above (`writeSessionEntry`, `session-accessor.sqlite-entry-store.ts:784`). Census run 1 shows 44 divergent rows. Same historical-generation caveat as `display_name` applies: an old `session_windows` row for a superseded generation keeps the `status` value from when THAT generation was written, while the census compares against the node's CURRENT blob status. **Flagged for CS-2 to confirm whether this is genuine divergence or a per-generation staleness artifact of the census's owning-node comparison.**                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           | Not evaluated                                                                                                    |
| parent_session_key | session_windows | Two writer candidates, same as the session_nodes case: `writeSessionEntry` (canonical) and `updateSessionKeyColumns` (`doctor-session-incognito-key-repair.ts:280-283` for `session_key`, `:286-289` for `parent_session_key` on `session_windows`). Census run 1 shows 40 divergent rows. Same historical-generation caveat as `display_name`/`status` may apply. **Flagged for CS-2.**                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            | Not evaluated                                                                                                    |
| spawned_by         | session_windows | Same as `parent_session_key` above (`writeSessionEntry` canonical; `doctor-session-incognito-key-repair.ts:292-295` non-canonical rename). Census run 1 shows 12 divergent rows. Same historical-generation caveat may apply. **Flagged for CS-2.**                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 | Not evaluated                                                                                                    |

**This document does not resolve any class (c) field.** Per PHASE-3.md §2.4,
resolution (fix writer, backfill, re-census to zero) is CS-2 work, out of
scope for CS-1. The finding this document contributes is: for the
`session_windows` fields, the leading hypothesis is a census-design artifact
(current-blob-vs-historical-per-window-write), not a live writer bypass —
CS-2 should verify this hypothesis against sample keys before writing any
backfill.

---

## 6. §8(c) Trap Findings

Every WHERE/ORDER BY found in this pass that could gate a side effect
(send/delete/resume/notify), per PHASE-3.md §8(c):

| Location                                                                                                | Filter                                                                                                   | Side effect gated                                                                                                                                                                       | Blob re-verified before the side effect?                                                                                                                                                                                                                                                                                                                                                                     |
| ------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `src/config/sessions/session-accessor.sqlite-entry.ts:320` (`hasSessionEntriesByStatusReadOnly`)        | `WHERE status IN (...)` (session_nodes)                                                                  | Gates `main-session-restart-recovery-shared.ts:157` — filters which session-store paths are eligible for restart recovery (a resume-class action)                                       | **No.** The function returns a bare boolean from the column filter; no blob load happens before the caller acts on the boolean.                                                                                                                                                                                                                                                                              |
| `src/config/sessions/session-accessor.sqlite-status.ts:39` (`readSessionEntriesByStatus`)               | `WHERE status IN (...)` (session_nodes)                                                                  | Gates the row SET handed to `applySqliteSessionEntryReplacementProjection` (`session-accessor.sqlite-replacement-projection.ts:74-77`), which performs session-entry replacement writes | Partially. Each returned row IS re-projected through `projectSessionEntry` (blob-sourced `entry`), so the VALUE used downstream is blob-correct. But the SET MEMBERSHIP (which rows appear at all) is decided by the raw column filter with no independent blob-side re-verification of exclusion — a row whose blob status matches but column diverges would be silently excluded from the replacement set. |
| `src/config/sessions/session-accessor.sqlite-maintenance.ts:85` (`hasStaleSqliteSessionEntryCandidate`) | `WHERE archived_at IS NULL` (session_nodes)                                                              | Gates candidacy for session-entry pruning (deletion)                                                                                                                                    | **Yes.** `shouldPreserveMaintenanceEntry` (`store-maintenance.ts:484`) re-checks `entry.archivedAt` from the blob-sourced `entry` before allowing eviction. Compliant with §8(c)'s escape clause.                                                                                                                                                                                                            |
| `src/config/sessions/session-canonical-key.ts:188-208` (`assertCanonicalSqliteSessionKeysCurrent`)      | Compares `parent_session_key`/`spawned_by`/`fork_source_session_key` columns against blob-derived values | Gates ALL further session-store operations — on mismatch it throws `SessionCanonicalKeyMigrationRequiredError`, which halts the Gateway process path until doctor repair runs           | **Yes, by construction.** This check IS the blob re-verification; a mismatch is fatal rather than silently trusted. This is the opposite of a hazard — it is the mechanism the audit's ground truth calls out as "Divergence check #2 (spec omitted it)."                                                                                                                                                    |

No send/notify-class side effect gated on a raw projected-column WHERE was
found in this pass. The two live hazards are the resume-class gate
(`hasSessionEntriesByStatusReadOnly` → restart recovery) and the
write-set-membership gate (`readSessionEntriesByStatus` → replacement
projection). Both should get the §8(c) treatment (keep the SQL pre-narrow,
add blob re-verification, side effect keys off the blob value) before their
readers are re-routed in CS-3/CS-4.

---

## 7. Corrected Ground-Truth Locations

### 7.1 The `owner_*` columns are not class (c) — they are the one designed exception to "blob is truth"

`projectCanonicalSessionEntryShape` (`src/config/sessions/store-entry-shape.ts:61`)
explicitly destructures and DISCARDS any `owner` key found in the parsed
`entry_json` blob (`owner: _projectedOwner` — an intentionally unused
binding). This means `entry_json` NEVER carries `owner` as persisted truth.
`owner` on the returned `SessionEntry` is built ENTIRELY from the 5
`owner_*` columns by `projectSqliteSessionOwner`
(`src/config/sessions/session-accessor.sqlite-owner-projection.ts:32-53`),
called from `parseSessionEntryBlob`
(`src/config/sessions/session-entry-parse.ts:78`).

Consequence: the census tool's `owner_*` entries in `SESSION_NODES_FIELD_MAP`
can never show divergence, by construction — the "blob value" the census
computes for `owner_actor_type` etc. is itself derived from those SAME
columns via `projectSqliteSessionOwner`. This matches census run 1 showing
no `owner_*` divergence. `owner_*` is column-primary by design, not a
divergence hazard, and is OUT OF SCOPE for the "move fact-reads to the blob"
re-route in CS-3/CS-4 — there is no blob value to move a reader to.

### 7.2 Divergence check #1 — location confirmed, scope narrower than PHASE-3.md guessed

`parseSqliteSessionEntryRecord`,
`src/config/sessions/session-entry-json.ts:12-31` (task brief cited
`:26-31`; the full function spans `:12-31`). Confirmed: it checks ONLY
`current_session_id` against `record.sessionId` and `updated_at` against
`record.updatedAt`. It does NOT compare 2-of-24 projected columns as
PHASE-3.md's deletion-table row guessed. This is a narrow identity check,
not a fact-column divergence check.

### 7.3 Divergence check #2 — PHASE-3.md omitted this one

`assertCanonicalSqliteSessionKeysCurrent`,
`src/config/sessions/session-canonical-key.ts:124-194` (task brief's cited
range; confirmed present, function extends to line 224 including the
lineage-key loop). Compares `parent_session_key`, `spawned_by`,
`fork_source_session_key` columns against blob-derived values at boot (once
per `DatabaseSync` connection, via the `validatedDatabases` WeakSet guard).
Throws `SessionCanonicalKeyMigrationRequiredError` on mismatch. PHASE-3.md's
divergence-check deletion-table row (§1, "Silent 2-of-24-column divergence
check") only names `session-entry-json.ts:26-31` (§7.2 above). This second
check is a SEPARATE, un-silent (throwing) divergence check that PHASE-3.md's
CS-6 gate does not mention. **CS-6 must account for this check too** — it is
not scheduled for deletion by the current plan text, and this document takes
no position on whether it should be, since it guards a different
`SessionCanonicalKeyMigrationRequiredError` "invalid persisted session row"
invariant, not general fact-read correctness.

### 7.4 entry_valid triggers — three confirmed, plus the compensating backfill loop

Confirmed in `src/state/openclaw-agent-db-session-migrations.ts:305-334`
(task brief's cited range):

1. `session_nodes_entry_valid_after_insert` — `AFTER INSERT ON session_nodes`
2. `session_nodes_entry_valid_after_entry_update` — `AFTER UPDATE OF entry_json ON session_nodes`
3. `session_nodes_entry_valid_after_identity_update` — `AFTER UPDATE OF current_session_id, updated_at ON session_nodes`

All three set `entry_valid = 0` (pending) on the affected row. The
compensating backfill loop (same file, immediately following, lines
~335-360 in `ensureSessionEntryValidityProjection`) then SELECTs pending
rows in batches of 256 and settles each to `1` (valid) or `-1` (invalid) via
`parseSqliteSessionEntryRecord`. The same trigger definitions are also
present in the static schema file, `src/state/openclaw-agent-schema.sql:52-67`
(these are the "install fresh" copies; the migrations file installs them on
an already-existing pre-trigger database).

### 7.5 The non-canonical, non-hazardous writer — confirmed

`writeValidatedDoctorSessionEntryJson`,
`src/commands/doctor-session-entry-rewrite.ts:18-52`. Confirmed: it updates
`entry_json` then separately settles `entry_valid = 1` in the same function
(two `UPDATE` statements, same caller-provided transaction). This matches
the task's ground truth: "writes entry_json + settles entry_valid together,
not class (c)." Confirmed this function is the SAME mechanism
`doctor-session-incognito-key-repair.ts`'s `rewriteSessionEntryJsonReferences`
uses (§4), meaning the incognito-key-repair writer inherits this
non-hazardous status for `entry_json` itself — the residual question (§5) is
only about the DIRECT column UPDATEs (`updateSessionKeyColumns`) that
precede it in the same transaction, which this document could not fully
rule in or out as the source of the small `parent_session_key`/`spawned_by`
divergence counts.

### 7.6 The real class (b) fact-read in doctor repair — confirmed, and why it is not a hazard

`src/config/sessions/session-accessor.sqlite-canonical-inventory.ts:71`
(task brief's cited line, confirmed:
`...(row.status ? { status: row.status } : {})`, inside
`hydrateCanonicalRepairEntry`). This function only runs on rows whose
`entry_json` FAILED to parse as a canonical shape (the surrounding
`hydrateCanonicalRepairEntry` starts from an empty `record = {}` on a parse
failure, `session-accessor.sqlite-canonical-inventory.ts:36-42`). It is a
genuine class (b) fact-read (`row.status`, and similarly `row.display_name`,
`row.parent_session_key`, `row.archived_at`, `row.last_read_at`,
`row.last_interaction_at`, `row.last_activity_at`, `row.pinned_at`, and
others on the same row), but it is scoped to doctor's already-corrupt-row
repair path, not a live production read of a healthy row. PHASE-3.md's
"NO logic path reads a projected column back as a fact" objective (§1)
should account for this path explicitly when CS-3/CS-4 land: this reader is
not a candidate for "move to blob" (there IS no usable blob — that is why
doctor is reading the columns), so it needs an explicit carve-out in the
lint fence (CS-5), not a re-route.

---

## 8. Census Run 1 Results (verbatim)

session_nodes: 284 scanned, 9 corrupt (quarantine-routed). Diverging fields:
`last_activity_at`=18, `archived_at`=13, `parent_session_key`=1.

session_windows: 516 scanned, 18 corrupt, 0 missingOwner. Diverging fields:
`display_name`=175, `status`=44, `parent_session_key`=40, `spawned_by`=12.

---

## 9. Summary Counts

This count covers the SQL-context access sites this document traced in
depth (§3), not every raw grep hit of every column name in every non-SQL
context (see §1.1 scope note).

- Total distinct access sites traced to a class: **13**
  (status ×4 read sites + 1 index; archived_at ×1 read site + 1 index;
  parent_session_key ×2 fact-compare/doctor sites + 1 index;
  spawned_by ×2 fact-compare/doctor sites + 1 index;
  fork_source_session_key ×1 fact-compare site;
  owner_* ×1 combined special-case site — counted once for all 5 columns).
- Class (a): **3** (archived_at pre-narrow with blob re-verify;
  the 3 index-definition sites are structurally (a) but not counted as
  separate "accesses" — folded into their column's row above).
- Class (b): **6** (session-canonical-key.ts fatal-divergence checks on
  parent_session_key, spawned_by, fork_source_session_key — these are
  explicit divergence detectors, a benign form of (b); plus the
  sqlite-canonical-inventory.ts doctor-repair status/display_name/etc.
  fact-reads, counted once per §7.6; plus readSessionEntriesByStatus's
  blob-sourced entry return).
- Class (c): **0 confirmed by writer-bypass in this pass** — but **6 fields
  flagged class (c) by census signal alone** per §2.3 step 4
  (last_activity_at, archived_at, parent_session_key on session_nodes;
  display_name, status, parent_session_key, spawned_by on session_windows —
  note parent_session_key appears on both tables, giving 6 distinct
  table+field pairs from the 4 distinct field names). None of the 6 has a
  confirmed bypassing writer in the current source tree; CS-2 must
  investigate each (§5).
- Special case, out of the (a)/(b)/(c) scheme entirely: **owner_actor_type,
  owner_actor_id, owner_assigned_by_type, owner_assigned_by_id,
  owner_assigned_at** (5 columns, 1 combined finding, §7.1).
- §8(c) side-effect-gating WHERE clauses found: **2 live hazards**
  (`hasSessionEntriesByStatusReadOnly` gating restart recovery;
  `readSessionEntriesByStatus` gating replacement-projection row-set
  membership) **+ 1 compliant pattern** (`archived_at` maintenance
  pre-narrow, already blob-reverified) **+ 1 by-design fatal-check pattern**
  (`assertCanonicalSqliteSessionKeysCurrent`, not a hazard, is itself the
  re-verification).
- Coverage gaps flagged **unverified** rather than guessed: `.row.<column>`
  call sites downstream of the two `selectAll()` readers (§3.1);
  `project_id` (§2.1); the ~6-column gap between the `session_windows`
  census seed (4 columns) and PHASE-3.md §4's "~10" estimate (§2.2);
  whether `doctor-session-delivery-state.ts`'s `account_id`/`channel` window
  UPDATE shares one transaction with its `entry_json` rewrite (§4);
  whether the canonical-repair window-copy path (§4) can run without
  rehoming the owning node's blob in the same transaction.

---

## 10. CS-2 Resolution (divergence traced to cause; no escalation)

Method: census re-run on a read-only copy of the production store plus a
per-row `current-generation vs stale-generation` and `column vs blob-key`
diagnostic. All seven flagged (field,table) pairs are resolved. NO field has
a two-writer value conflict (no `col=X blob=Y` with both non-null and
different), so the one sanctioned Phase-3 stop (§2.4) is NOT triggered.

### 10.1 session_windows fields — census artifacts, NOT backfill targets

Every `session_windows` divergence is a comparison artifact of the census
design (it compares each historical per-window row against the OWNING NODE's
CURRENT blob), plus derived-column semantics. Diagnostic result:

| Field              | current-gen divergent | stale-gen divergent | verdict                                                                                                                                                                                                                                                                                                                                        |
| ------------------ | --------------------- | ------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| status             | 0                     | 44                  | 100% stale generation — old window rows keep their own write-time status; current window always matches blob. Artifact.                                                                                                                                                                                                                        |
| parent_session_key | 0                     | 40                  | 100% stale generation. Artifact.                                                                                                                                                                                                                                                                                                               |
| spawned_by         | 0                     | 12                  | 100% stale generation. Artifact.                                                                                                                                                                                                                                                                                                               |
| display_name       | 73                    | 104                 | stale-gen = artifact; the 73 "current-gen" are the DERIVED column: `session_windows.display_name = displayName ?? label ?? subject ?? groupId` (`session-accessor.sqlite-session-row.ts:76,175-182`), while the census reads `entry.displayName` (often undefined when only `label` is set, e.g. node "main"). Derived index, not a blob twin. |

Consequence: NO `session_windows` field is backfilled. These columns are
column-derived / historical-generation stores with no authoritative blob
value to route a reader to — the same structural category as `owner_*`
(§7.1). They are the sanctioned column-primary exception for CS-6/CS-7.

### 10.2 session_nodes fields

| Field              | rows | class          | cause (file:line)                                                                                                                                                                                                                                                             | action                           |
| ------------------ | ---- | -------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------- |
| parent_session_key | 1    | (A) derived    | `bindSessionNode` `parent_session_key: normalizeText(entry.parentSessionKey) ?? spawnedBy` (`session-accessor.sqlite-session-row.ts:105`). The one divergent row has `col === spawned_by` exactly — the `?? spawnedBy` fallback, not a real divergence.                       | none (derived)                   |
| archived_at        | 13   | (C) historical | Only writer is `writeSessionEntry` (blob+col atomic) + a one-time migration that reads FROM the blob. No live column-only writer. The 13 rows (all subagent/cron) have a column timestamp their blob's `archivedAt` key never carried — pre-dating reliable blob persistence. | BACKFILL blob-from-column (CS-2) |
| last_activity_at   | 18   | (C) historical | Same: only `writeSessionEntry` writes it; the observer model (`session-observer.ts`) tracks it in-memory only, never a column-only DB write. The 18 rows (dashboard/ios/plugin) have a column value the blob key lacks.                                                       | BACKFILL blob-from-column (CS-2) |

Defensive writer note: `updateSessionKeyColumns`
(`doctor-session-incognito-key-repair.ts:304-307`) is a genuine class-(B)
column-only UPDATE of `parent_session_key`/`spawned_by` on rename, but it
produced ZERO current divergence (the single divergent node is the `??`
fallback above, not a rename stale). CS-2 hardens/annotates it so future
renames keep the blob consistent, but no row requires backfill for it.

CS-2 backfill scope: 31 session_nodes rows (13 archived_at + 18
last_activity_at). Idempotent, resumable, one-row CAS writes via
`writeSessionEntry` (bumps revision). Proven to zero on a `/tmp` copy of the
store; the LIVE backfill is a post-merge human step (§12).

### 10.3 CS-2 oracle disposition

The CS-2 equivalence oracle (`session-projection-equivalence.phase2.test.ts`)
stays byte-identical: its fixtures are hand-built clean entries that do not
reproduce the archived_at/last_activity_at historical divergence, so the
pipeline output is unchanged. No oracle expectation edit and no oracle audit
entry are needed (the sanctioned-exception path in §7 wall matrix is not
exercised).

---

## 11. CS-6 Finding — the three deletion targets are LIVE, not dead

PHASE-3.md §3 assumed the divergence check + `entry_valid` trigger guard "a
state that can no longer occur" post-Phase-1. Verified against the tree, all
THREE CS-6 deletion targets have irreducible LIVE consumers. Deleting them as
specified is the §8(d) hazard (removing a guard that still has readers) — a
regression, not a dead-code removal.

1. **`parseSqliteSessionEntryRecord` (`session-entry-json.ts:12-36`) — LIVE.**
   It IS the JSON-parse + identity-validation primitive the single canonical
   parser is built on (`session-entry-parse.ts:74`, `parseSessionEntryBlob`),
   plus two doctor write-safety gates
   (`doctor-session-entry-rewrite.ts:23`, `doctor-session-delivery-state.ts:109,117`).
   Deleting it breaks every session read.

2. **`assertCanonicalSqliteSessionKeysCurrent` (`session-canonical-key.ts:124-224`)
   — PARTIALLY live.** Lines ~159-187 (entry_valid + lineage-column-vs-blob
   comparison) are the dead-after-reroute divergence portion; lines ~194-225
   are a SEPARATE canonical-key-shape write-safety audit of persisted key
   strings, independent of blob re-routing. All 6 call sites invoke the whole
   function. Deleting the function wholesale removes the boot-time
   non-canonical-persisted-key detection — a regression.

3. **`entry_valid` triggers + compensating backfill
   (`openclaw-agent-db-session-migrations.ts:304-341`) — LIVE.** `entry_valid`
   has runtime readers driving availability/ownership decisions:
   `sqlite-entry-availability.ts:154,169,186,189` (session availability
   resolution), `sqlite-canonical-inventory.ts:162,200` (canonical-owner /
   raw-fallback decisions), `session-canonical-key.ts:161,166`. Deleting the
   triggers strands these readers on a never-updated flag.

**CS-6 disposition (this landing):** CS-6 does NOT delete any of the three.
The §3 premise is refuted by the tree. The safe, in-scope subset of CS-6 is
empty of deletions given the current readers; the divergence-check + trigger
removal is deferred and ESCALATED to the orchestrator with the reader
evidence above. See PHASE-3-LANDING.md §CS-6 and §escalations. This is not a
two-writer stop (§2.4) but a spec-vs-tree safety conflict: landing the
specified deletions would regress availability logic. Per the landing
contract (independent gate, no faked completion), CS-6 is reported blocked
rather than forced.
