# PHASE-3.md — Columns Become Indexes

Status: SPEC — ready for implementation
Depends on: Phase 0, Phase 1, Phase 2 (all committed)
Risk class: HIGHEST in the re-architecture. This phase contains the first subtractive schema migration.

---

## 1. Objective

Phase 2 moved WHERE assembly code lives. Phase 3 moves WHICH storage logic reads.

After Phase 3:

- Projected columns on `session_nodes` and `session_windows` are WRITE-ONLY query indexes.
- The write path writes the columns in the same transaction as `entry_json`. This does not change.
- NO logic path reads a projected column back as a fact. Logic reads the blob plus `revision` only. All blob reads go through `projectSessionEntry` or `parseSessionEntryBlob`.
- SQL may still FILTER and SORT on projected columns. That is the index job.

Phase 3 deletes (PLAN deletion table rows):

| Deleted artifact                                                                              | Why deletion is safe after Phase 3                                                                                                             |
| --------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------- |
| Silent 2-of-24-column divergence check (`session-entry-json.ts:26-31`)                        | Columns are never read back as truth. Divergence is unobservable. A check on an unobservable condition is dead code.                           |
| `entry_valid` trigger + compensating-UPDATE dance                                             | Validity derives from the `revision` write that completes in-transaction (Phase 1 truth). The trigger guards a state that can no longer occur. |
| ~10 duplicated `session_windows` columns (status/model/etc) that no query filters or sorts on | No reader remains. A column with no reader is dead weight and a divergence surface.                                                            |

Phase 3 does NOT do:

- The read-receipt split. T-A3a stays RED-PINNED. Phase 5 fixes it.
- Any change to the `parentSessionKey` / `spawnedBy` contract. T-SH stays green and unmodified.
- Any change to the parser, the projection pipeline, or the quarantine ledger.

---

## 2. The Reader Audit Method

Every access to a projected column gets a classification. The implementer runs this procedure BEFORE any re-routing changeset. The output is a checked-in audit table: `docs/session-rearchitecture/phase-3-reader-audit.md`. Every later changeset cites rows of this table. No re-route lands without an audit row.

### 2.1 Enumeration procedure

1. List the projected columns. Source: the projection tables named in SQL, which the Phase 2 lint fence already restricts to the accessor allow-list. The allow-list IS the enumeration seed.
2. For each column, grep the full source tree for the column name. Grep both the SQL string form and any generated-binding form. Include tests. Include migrations.
3. For each hit, record: file, line, statement kind (SELECT / WHERE / ORDER BY / GROUP BY / UPDATE / INSERT / trigger), and the consumer of the value if it is a SELECT.
4. A SELECT hit requires one more step: trace the selected value to its use. If the value only names the row (key, rowid), it is not a fact-read. If the value enters a branch, a computation, a returned object, or a log that drives behavior, it IS a fact-read.

### 2.2 Classification

Each access gets exactly one class:

**(a) SQL-only filter/sort — STAYS.** The column appears only in WHERE, ORDER BY, GROUP BY, or an index definition. The value never crosses into logic. This is the column doing its index job. No change.

**(b) Value-into-logic — MOVE TO BLOB.** The column value is selected and used as a fact. Re-route: the query keeps its filter, returns the row key plus `entry_json` plus `revision`, and the value comes from `projectSessionEntry`. One equivalence pin per moved reader (see §6.3).

**(c) Authoritative-column-write — HAZARD. RESOLVE TRUTH FIRST.** Some writer updates this column WITHOUT updating `entry_json` in the same transaction. For that field, the column may hold data the blob does not. Moving a reader of this field to the blob LOSES DATA. No re-route of this field lands until the hazard is resolved (§2.4).

### 2.3 Class (c) detection procedure

Class (c) is a property of WRITERS, not readers. Detect it independently of the reader grep:

1. For each projected column, enumerate every UPDATE and INSERT that touches it. Include triggers. Include migrations that backfill.
2. For each write site, verify: does the same transaction also write `entry_json` with the same field value, through the canonical write path?
3. Any write site that fails this check marks the column class (c). One failing site is enough.
4. Additionally, run the divergence census (§2.5) against a production-shaped database. Any field with nonzero divergence count is treated as class (c) until the cause is found, even if step 2 found no writer. The census catches historical writers that no longer exist in the source.

### 2.4 Per-field truth-decision rule

State the rule once. Apply it per field with no exceptions:

- **Default: the blob is truth.** That is the point of the architecture. Every class (a) and class (b) field uses this default.
- **Class (c) fields: the column is truth for the divergent rows, because a writer put data only there.** Resolution order, per field:
  1. Fix the writer. Route it through the canonical write path so it writes blob + column + revision in one transaction.
  2. Backfill. For every existing row where column ≠ blob for this field, write the column value INTO the blob through the canonical write path. This bumps `revision`. The backfill is a normal CAS write, one row at a time, idempotent, resumable.
  3. Re-run the divergence census. Required result: zero divergence for this field.
  4. Only now re-route the readers of this field.
- If a class (c) field's divergence has two writers with conflicting values (column says X from writer 1, blob says Y from writer 2), do not guess. Stop. Record the field and both writers in the audit table. Escalate to the orchestrator for a per-field decision. This is the one place Phase 3 permits a stop.

### 2.5 Divergence census (one-shot tool)

Build `tmp_phase3-divergence-census.ts`. For every row: parse the blob with `parseSessionEntryBlob`, project every field, compare against every projected column. Output: per-field divergence count plus up to 10 sample keys per field. Corrupt rows go through the Phase 2 quarantine path and count separately. The census runs three times in this phase: before re-routing (detect class c), before the CS-6 truth-read re-route + audit-guard relabel (gate for CS-6), and before the column drop (gate for CS-7). The census proves zero divergence at each gate — and after CS-6 the audit guards stay armed to keep proving it live.

---

## 3. Audit-Guard Relabel + Truth-Read Re-Route + entry_valid-Trigger Deletion

Truth-reads die. Audit-compares live.

The two divergence checks are NOT deleted. They are relabeled as **audit guards**: they never serve column data as truth — they compare column vs blob and refuse/repair on mismatch. That comparison is load-bearing: it powers the live doctor canonical-key repair path (a regression there was caught and fixed). Deleting the checks would blind that command.

- **parseSqliteSessionEntryRecord** — compares `current_session_id`/`updated_at` column vs blob; returns null on divergence. KEEP as audit guard.
- **assertCanonicalSqliteSessionKeysCurrent** — compares `parent_session_key`/`spawned_by`/`fork_source_session_key` column vs blob; throws on divergence. KEEP as audit guard; powers doctor repair.

Both get audit-guard doc headers stating the rule (compare-only, never truth). Function renames are skipped — importer surface is too wide; the doc header carries the contract.

The one genuine surviving truth-read — a timestamp read that took the raw column instead of the audited blob field — is re-routed to the blob. That plus the two audit-guard doc headers is the whole of CS-6.

**entry_valid trigger deletion is deferred — NOT in CS-6.** The original plan assumed the three `session_nodes_entry_valid_*` triggers guarded a Phase-1-dead state with only compensating-UPDATE consumers. The code disproves that: `entry_valid` is a live validity flag read across seven source files — the availability classifier (`session-accessor.sqlite-entry-availability.ts`), the canonical-inventory scan, and `assertCanonicalSqliteSessionKeysCurrent` itself all branch on it, and the write path sets `-1`/`1` on mutation. No compensating-UPDATE code exists. Deleting the triggers while those readers stand would strand the column and silently break availability + the audit guard — the exact regression class Phase 3 exists to prevent. `entry_valid` retirement, if wanted, needs its own reader-audit + re-route pass (CS-3/CS-4 shape) or the column stays as a kept validity index. Tracked as a follow-up, out of Phase-3 scope as re-scoped here.

### 3.1 Precondition

After the re-route, no read path treats a non-exempt column as truth; the audit guards remain the only column readers, and they read to compare, not to serve.

### 3.2 Gate

1. The surviving truth-read is re-routed to the blob; no truth-read of a non-exempt column remains.
2. Both audit guards present with audit-guard doc headers; behavior unchanged (null-return / throw semantics intact).
3. Doctor canonical-key repair tests green.
4. Census run 2, executed immediately before landing, reports zero divergence — the safety proof that no OTHER writer bypasses the canonical path.

(The `entry_valid` trigger deletion is NOT part of this gate — see §3 lead: deferred as a separate column-retirement pass.)

---

## 4. session_windows Shrink

### 4.1 Column disposition

The audit (§2) produces the exact list. The rule for disposition:

- **KEEP:** every column that appears in a class (a) access — WHERE, ORDER BY, GROUP BY, or an index — in any shipped query. Expected keepers: the key/identity columns, `revision`, and the small set of columns real list queries filter or sort on (for example status-for-listing, ordering timestamp). The audit table is authoritative, not this expectation.
- **DROP:** every column with zero class (a) accesses after all class (b) re-routes land. The ~10 duplicated status/model/etc columns are the expected candidates.
- A column that is class (a) in even ONE query is kept. Cheap to keep, fatal to drop wrong.
- Audit-guard columns — `current_session_id`, `updated_at`, `parent_session_key`, `spawned_by`, `fork_source_session_key` — and all `owner_*` columns: permanent keepers; the audit guards compare them against the blob and doctor repair depends on them.

### 4.2 Ordering — re-route, soak, then drop

1. All re-routes land (CS-3, CS-4).
2. The columns stay WRITTEN. The write path does not change until the drop. A column that is written but never read is safe. A column dropped while any reader remains is corruption.
3. **Soak:** the re-routed build runs in production for a minimum of one full release cycle. During the soak, a runtime tripwire (CS-5) logs any SELECT of a droppable column outside the allow-listed writers. Required soak result: zero tripwire hits.
4. Only then does CS-7 drop the columns.

### 4.3 The drop is its own changeset, landed last

The drop is CS-7, a separate changeset behind a migration version, the final changeset of Phase 3. Reasons:

- It is the only irreversible step. Everything before it reverts by `git revert`. Keeping it isolated means the whole phase minus the drop is revertible at any time.
- The soak needs a shipped, running build between re-route and drop. One changeset cannot contain a soak.
- If the soak trips, only CS-7 is postponed. CS-1 through CS-6 stand.

Drop-migration safety inside CS-7:

1. In one transaction: create `session_windows_col_archive` (key, revision, one column per dropped column), copy all values in, then drop the columns from `session_windows`.
2. The write path stops writing the dropped columns in this same changeset. Additive-then-subtractive ends here, atomically with the drop.
3. The archive table is the revert path for the "irreversible" step. A follow-up cleanup (Phase 4 or later) deletes the archive after one further release with no incident.
4. The migration is forward-only. A pre-shrink database opens and migrates. A post-shrink database on pre-shrink code is NOT supported — the migration version fence refuses the downgrade with a clear error, which is the existing migration-versioning behavior.

---

## 5. Changeset Table

| CS   | Name                                                         | Contents                                                                                                                                                                                                                                                                                                                                                                           | Depends on  | Gate                                                                                                                                  |
| ---- | ------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------- | ------------------------------------------------------------------------------------------------------------------------------------- |
| CS-1 | Reader audit + census tool                                   | Build `tmp_phase3-divergence-census.ts`. Produce `phase-3-reader-audit.md` with every access classified (a)/(b)/(c). Census run 1. No production code change.                                                                                                                                                                                                                      | —           | Audit table reviewed by orchestrator. Every projected-column grep hit has exactly one class. Census run 1 results recorded per field. |
| CS-2 | Class (c) resolution                                         | Per hazard field: fix writer to canonical path, backfill blob from column via CAS writes, re-census the field to zero. Conflicting-writer fields escalate and block.                                                                                                                                                                                                               | CS-1        | Census shows zero divergence for every former class (c) field. T-SH green. CS-2 oracle green (backfill corrections recorded per §7).  |
| CS-3 | Re-route `session_nodes` fact-reads                          | Every class (b) reader of a `session_nodes` projected column reads blob via `projectSessionEntry`. One equivalence pin per moved reader (§6.3), added in the same commit as its move.                                                                                                                                                                                              | CS-2        | All per-reader pins green. Full wall green (T-A3a red-pinned). Audit table updated with commit hashes.                                |
| CS-4 | Re-route `session_windows` fact-reads                        | Same method for `session_windows`. Queries keep WHERE/ORDER BY on columns, return key + `entry_json` + `revision`, values come from the blob.                                                                                                                                                                                                                                      | CS-2        | Same gate shape as CS-3.                                                                                                              |
| CS-5 | Test wall + fences                                           | Zero-cache discipline test (§6.1). Self-contained-record extension (§6.2). Migration tests (§6.4). Lint fence extension: SELECT of a demoted column value outside the writer allow-list fails lint. Runtime soak tripwire on droppable columns.                                                                                                                                    | CS-3, CS-4  | All new tests green by design. Lint fence red on a planted violation, green on tree.                                                  |
| CS-6 | Re-route last truth-read + audit-guard the divergence checks | Re-route the one surviving blob-truth timestamp read (`readSessionUpdatedAtCore`) to the blob. Add audit-guard doc headers to parseSqliteSessionEntryRecord and assertCanonicalSqliteSessionKeysCurrent (KEEP both; renames skipped). Census run 2 immediately before landing. entry_valid trigger deletion deferred (see §3 — live column, out of scope).                         | CS-5        | §3.2 gate in full. Zero divergence on census run 2. Doctor canonical-key repair tests green.                                          |
| CS-7 | Drop write-only index columns (post-soak)                    | Final subtractive drop of columns with no remaining reader. EXEMPT from the drop: audit-guard columns (current_session_id, updated_at, parent_session_key, spawned_by, fork_source_session_key) — an audit guard needs its column to compare against — plus owner_* columns (permanently exempt), joining the existing keep-list (key/identity, revision, list-query filter/sort). | CS-6 + soak | Census run 3 zero. Both audit guards intact and their exempt columns retained.                                                        |

Every CS is independently gate-able. CS-1 through CS-6 are independently revertible with `git revert`. CS-7 reverts through the archive table only. Nothing subtractive precedes the reader re-routing that makes it safe: CS-6 requires CS-5, CS-7 requires CS-6 plus soak.

---

## 6. Phase 3 Test Wall (green-by-design)

### 6.1 T-P3-ZC — Zero-cache discipline (stolen pattern #3)

Asserts NO path serves a projected entry across a turn boundary, and no projected column value survives as a cached fact. Method: load an entry, complete a turn that bumps `revision`, then read again through every public read accessor. Each read must reflect the post-bump blob. Then the hostile half: mutate a projected column DIRECTLY in SQL (bypass the write path) without touching the blob, and read through every accessor. Required result: every accessor returns the blob value, not the mutated column value. If any accessor returns the mutated value, a fact-read survived the audit. This test is the executable proof of the whole phase.

### 6.2 T-P3-SCR — Self-contained-record extension (stolen pattern #4)

For each moved reader: corrupt the target row's `entry_json`, then drive the moved reader. Required behavior: `SessionRowCorruptError` from the single throw boundary, row quarantined into the ledger, no cross-row read occurs during the judgment, and boot guards skip-resume the row. The judgment of corruption uses that row alone.

### 6.3 T-P3-EQ-`<reader>` — Per-moved-reader equivalence pins

One pin per class (b) re-route, committed WITH the re-route. Before the move: capture the reader's output on a fixture set that includes every field the reader consumes. After the move: output is byte-identical. Because CS-2 forced field-level divergence to zero before any move, byte-identical is achievable and any pin failure means either an audit miss or a live writer bypassing the canonical path — both are bugs to fix, not pins to update.

### 6.4 T-P3-MIG — Migration tests

1. A pre-shrink database fixture opens on post-CS-6 (pre-drop) code. All wall tests pass against it. This proves the additive period is safe.
2. The CS-7 migration applies to the pre-shrink fixture: archive table populated with correct values, columns dropped, all wall tests pass after migration.
3. The CS-7 migration is idempotent-guarded: applying to an already-shrunk database is a no-op with no error.
4. A post-shrink database on pre-shrink code is refused by the migration version fence with the standard downgrade error.

---

## 7. Wall Matrix

| Wall                              | Phase 3 disposition                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| --------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| T-A3a (agentStatus clobber)       | RED-PINNED, unchanged. If any Phase 3 changeset flips it green, scope leaked into the read-receipt split — revert that changeset. The pin is a scope tripwire, not just a bug marker.                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| T-SH (parentSessionKey/spawnedBy) | GREEN, test file unmodified. Any CS that touches this test fails its gate.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| CS-2 equivalence oracle           | Default: KEPT GREEN and byte-identical. The design forces this: CS-2 (this phase's changeset 2) drives field divergence to zero BEFORE any read moves, so blob-sourced output equals column-sourced output at move time. Legitimate exception: a class (c) backfill corrects a blob value (column was authoritative, blob was stale). For exactly those rows and fields, the oracle expectation updates, with a per-field entry in the audit table recording: field name, writer that caused it, row count, and why the column value is correct. An oracle change with no matching audit entry is a regression — reject it. |
| T-P2-* (Phase 2 wall)             | GREEN, unchanged.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| T-P3-* (this phase)               | Green by design per §6, added at the CS stated in §5.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |

---

## 8. §-Adversarial Pass

Attack the plan. Four MUST-catch failures, each with detection and the ordering that prevents it.

**(a) A silently authoritative column — moving to blob loses data.**
Attack: field F is written by a maintenance script directly to the column. The blob never sees it. CS-3 re-routes F's reader to the blob. The data is gone from every read path, and after CS-7 it is gone from storage.
Detection: two independent nets. Net 1 is writer enumeration (§2.3 steps 1–2): every column write site must prove it writes the blob in-transaction. Net 2 is the divergence census on production-shaped data (§2.5), which catches writers that no longer exist in source, external scripts, and manual UPDATEs — divergence count > 0 flags the field regardless of what the source tree says.
Ordering guard: CS-3/CS-4 depend on CS-2, and CS-2's gate is census-zero per field. A reader of F cannot move while F diverges. CS-7's archive table is the final backstop: even if both nets fail, the dropped values survive in `session_windows_col_archive` for one release.

**(b) A column dropped while a reader survives.**
Attack: an obscure reader — a rarely-run report query, a debug endpoint, a migration helper — was missed by the grep and still SELECTs a dropped column. After CS-7 it throws, or worse, silently returns nothing.
Detection: three layers. Layer 1: the audit grep includes tests, migrations, and generated bindings, not just src. Layer 2: the CS-5 lint fence makes a demoted-column SELECT a build failure, so no NEW reader appears between audit and drop. Layer 3: the runtime soak tripwire (§4.2) logs any live SELECT of a droppable column for a full release cycle — it catches readers that grep cannot see, including dynamic SQL.
Ordering guard: CS-7 lands last, requires zero tripwire hits across the soak, and requires census run 3. A drop cannot precede its own evidence of safety.

**(c) A WHERE/ORDER BY that is secretly a fact-read.**
Attack: `WHERE status = 'active'` looks like class (a). But the caller then executes a side effect that ASSUMES the row is active — the filter smuggled the value into logic without a SELECT. If the column diverges from the blob, the side effect fires on wrong facts.
Detection: the audit procedure §2.1 step 4 plus this rule, stated as a hard classification test: **a filter is class (a) only if the caller's later behavior does not depend on the filtered predicate being a true fact — or the caller re-verifies the predicate against the blob after loading the row.** Any filter that GATES a side effect (send, delete, resume, notify) is classified (b)-adjacent: keep the SQL filter as a cheap pre-narrowing index use, but add a blob re-verification after `projectSessionEntry`, and the side effect keys off the blob value. The audit table has a column "gates side effect? y/n" to force the question on every WHERE hit.
Ordering guard: this classification happens in CS-1, before any code moves, and the T-P3-ZC hostile half (§6.1) executes exactly this attack — mutate the column under SQL, confirm behavior follows the blob.

**(d) A truth-read left un-re-routed serves a stale column as truth.**
The one surviving truth-read (`readSessionUpdatedAtCore`) took `updated_at` off the raw column instead of the audited blob field. If a writer updated the blob but the column lagged, that read served the stale column with no guard firing on the read path. CS-6 re-routes it to `entry.updatedAt`, so the value now flows through the audit guard that nulls on divergence. The guards themselves stay kept and armed through every changeset, including CS-7 — "audit-compares live."

**Residual accepted risk.** A writer that appears for the first time DURING the soak (new feature branch writing a column directly) would bypass census runs 1 and 2. The CS-5 lint fence blocks the read side; the write side is blocked by the Phase 2 rule that only the accessor allow-list names projection tables in SQL, which Phase 3 keeps in force. A writer outside the allow-list cannot merge. This closes the window to direct manual SQL on production, which the archive table (§4.3) and the quarantine ledger bound but cannot prevent. Accepted, recorded.

---

End of PHASE-3.md.
