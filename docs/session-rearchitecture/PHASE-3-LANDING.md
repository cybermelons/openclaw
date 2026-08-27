# Phase 3 — Landing sweep (Columns Become Indexes)

Landing accounting for the Phase 3 PR body. Projected columns on
`session_nodes` and `session_windows` become write-only query indexes. No
logic reads a projected column back as a fact. Logic reads the `entry_json`
blob. SQL still filters and sorts on columns.

All numbers are measured on branch `rearch/session-store`. No commit is
pushed. No commit runs against the live store. All census and backfill runs
use a read-only copy of the production database in `/tmp`.

## What Phase 3 does

Phase 2 made the read/projection side single-sourced (one parser, one
pipeline, row quarantine). Phase 3 removes the last hazard: a projected
COLUMN read back as a fact.

- **Reader audit** (CS-1) classifies every projected-column read: (a) a
  SQL-only filter or sort stays; (b) a value read into logic moves to the
  blob; (c) an authoritative column write is a hazard to resolve first.
- **Backfill** (CS-2) folds the 31 class-(c) historical column values that
  the blob lacks (`archived_at` 13, `last_activity_at` 18) into the blob
  through the canonical `writeSessionEntry` path. Fixture and copy only.
- **§8c hazard fixes** (CS-3, CS-4) re-route the three side-effect-gating
  reads (`hasSessionEntriesByStatusReadOnly`, the orphan-cleanup delete
  plan, `readSessionEntriesByStatus`) to re-verify against the blob.
- **Test wall + fences** (CS-5) proves the discipline: zero-cache, corrupt
  row quarantine, the demoted-column lint fence, and the soak tripwire.
- **Divergence-check + trigger deletion** (CS-6) removes the dead divergence
  checks and the `entry_valid` triggers, gated on a zero census.
- **Column drop** (CS-7) archives then drops the shrunk `session_windows`
  columns. It lands last, behind a migration version, after the soak.

## Changeset ledger

| CS  | Commit        | Content                                                                          |
| --- | ------------- | -------------------------------------------------------------------------------- |
| 1   | `232647cd7d1` | Phase 3 spec + reader audit + divergence-census tool                             |
| 2   | `01c16be6b07` | Backfill `archived_at`/`last_activity_at` into the blob (fixture-only)           |
| 4   | `dec9ce2908c` | `readSessionEntriesByStatus` membership re-verified against the blob             |
| 3   | `7f62d071c6c` | Status probe + orphan-owner re-verified against the blob                         |
| 5   | `8d22f63463c` | Phase 3 test wall + demoted-column lint fence + soak tripwire                    |
| 6   | DEFERRED      | Delete divergence checks + `entry_valid` triggers — see "CS-6 and CS-7 deferral" |
| 7   | DEFERRED      | Archive-then-drop migration — post-soak, post-merge — see below                  |

Commit order note: CS-4 landed before CS-3 because their files are disjoint
(`sqlite-status.ts` versus `sqlite-entry.ts` + `sqlite-lifecycle-state.ts`)
and CS-4 gated first. The dependency chain still holds: both depend only on
CS-2, and neither depends on the other.

## Gate evidence (all independently re-run by the landing agent)

The landing agent re-ran every gate. It did not trust a builder's report.

| CS   | Gate                                                  | Result                                                                                                                                                |
| ---- | ----------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------- |
| CS-2 | Census on a fresh production copy                     | before `archived_at`=13 `last_activity_at`=18; dry-run wrote nothing; apply → 0/0; second apply → 0 (idempotent); 9 corrupt rows skipped, not aborted |
| CS-2 | Writer hardening typecheck                            | `tsgo` reports no error in `doctor-session-incognito-key-repair.ts` (documented no-gap branch)                                                        |
| CS-4 | Pin `session-status-window-membership.phase3.test.ts` | 2 passed                                                                                                                                              |
| CS-3 | Pin `session-status-blob-membership.phase3.test.ts`   | 2 passed                                                                                                                                              |
| CS-3 | Orphan-path regression                                | `lifecycle.test.ts` + `session-accessor.readonly.test.ts` — 18 passed                                                                                 |
| CS-3 | Typecheck (core project, host OOM workaround)         | `tsgo -p tsconfig.core.json` introduces zero new errors; 3 pre-existing `openclaw-agent-db.ts` `walMaintenance` errors are unchanged                  |
| all  | Equivalence oracle (byte-identical)                   | `session-projection-equivalence.phase2.test.ts` — 30 passed, expectations unchanged, on every commit                                                  |
| all  | T-A3a wall pin                                        | `sessions-patch.phase0.test.ts` — 3 passed, still RED-PINNED, on every commit                                                                         |
| all  | T-SH read-back                                        | `parent-spawned-by-readback.phase0.test.ts` — unmodified (`git status` clean), on every commit                                                        |

> Host note: a bare full-project `tsgo -p tsconfig.json` OOM-kills on this
> 15 GB host (exit 137). The landing agent typechecks with
> `tsconfig.core.json` at a 12 GB heap cap, which covers `src/**` including
> every Phase 3 file, and diffs the error set against the pre-changeset tree
> to prove zero new errors. The 3 pre-existing `walMaintenance` errors in
> `src/state/openclaw-agent-db.ts` predate Phase 3 and are out of scope.

## CS-2 census — the class-(c) backfill, in full

The census ran on a read-only copy of the production store
(`/tmp/phase3-census/live-copy.sqlite`, from live DB size 773668864 bytes,
never mutated). Only two fields are genuine class-(c) backfill targets:

| Field                            | Rows | Class | Resolution                                                     |
| -------------------------------- | ---- | ----- | -------------------------------------------------------------- |
| `session_nodes.archived_at`      | 13   | (c)   | Column holds a timestamp the blob lacks → folded into the blob |
| `session_nodes.last_activity_at` | 18   | (c)   | Column holds a timestamp the blob lacks → folded into the blob |

All other census divergences are derived-column or stale-generation
artifacts, not backfill targets (see `phase-3-reader-audit.md` §10):
`session_windows` `status`/`parent_session_key`/`spawned_by`/`display_name`
compare each window row against its owning node's CURRENT blob, so a
stale-generation window row always shows a false divergence;
`session_nodes.parent_session_key` is the `?? spawnedBy` derived fallback.
No field shows a two-writer value conflict (`col=X blob=Y`, both non-null and
different), so the one sanctioned Phase 3 escalation-stop is NOT triggered.

## Census run 2 — the CS-6 gate

Census run 2 ran on a fresh read-only copy of the production store
(`/tmp/phase3-census/run2.sqlite`, from live DB size 773668864 bytes, never
mutated), with the CS-2 backfill applied to the copy first. This is the state
the divergence checks must see zero real conflicts against before CS-6 removes
them.

Result after backfill:

| Table           | Column               | Rows | Reading                                                                                                                                                                                                                                                 |
| --------------- | -------------------- | ---- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| session_nodes   | `archived_at`        | 0    | class-(c) backfill cleared it (was 13)                                                                                                                                                                                                                  |
| session_nodes   | `last_activity_at`   | 0    | class-(c) backfill cleared it (was 18)                                                                                                                                                                                                                  |
| session_nodes   | `parent_session_key` | 1    | derived-fallback artifact — column holds the `parentSessionKey ?? spawnedBy` projection; the one row has blob `parentSessionKey` undefined and `spawnedBy` set, and column === (blob.parentSessionKey ?? blob.spawnedBy) is TRUE. Not a value conflict. |
| session_windows | `display_name`       | 178  | generation artifact — census compares each window against its owning node's CURRENT blob; stale-generation window rows hold a prior blob's value                                                                                                        |
| session_windows | `status`             | 44   | same generation artifact                                                                                                                                                                                                                                |
| session_windows | `parent_session_key` | 40   | same generation artifact                                                                                                                                                                                                                                |
| session_windows | `spawned_by`         | 12   | same generation artifact                                                                                                                                                                                                                                |

No `session_nodes` field shows a two-writer value conflict (both column and
blob non-null and genuinely different). The one sanctioned Phase 3
escalation-stop is NOT triggered. Nodes scanned 286 (9 corrupt, skipped not
aborted); windows scanned 521 (18 owner-corrupt, skipped).

The `session_windows` artifacts are exactly why CS-7 archives before it drops:
those columns are not corruption, they are retained prior-generation rows whose
truth is the owning node's blob at that generation, not the current blob.

Census run 3 (CS-7 gate) is recorded in that changeset below when it lands.

## §7 wall matrix — holds

| Wall test | Required state                   | Actual (every Phase 3 commit)                                   |
| --------- | -------------------------------- | --------------------------------------------------------------- |
| T-A3a     | RED-PINNED (agentStatus clobber) | 3 passed, clobber intact — Phase 3 touched the reader side only |
| T-SH      | GREEN + file unmodified          | unmodified, `git status` clean                                  |

Scope-leak check: T-A3a is fixed only by the later read-receipt split. If any
Phase 3 changeset had flipped it green, scope leaked into the split → reject
that changeset. None did.

## Exemptions held in force

`owner_*`, `primary_conversation_id`, and `transcript_*` columns are EXEMPT
from the divergence-check deletion (CS-6) and the column drop (CS-7). They are
not projected-fact columns in the Phase 3 sense.

## CS-6 and CS-7 deferral (named, with reason — not faked done)

CS-6 and CS-7 are NOT landed in this PR. The reason is a precondition that the
tree does not yet meet, not incomplete effort. The evidence below was measured,
not assumed.

### CS-6 — the divergence checks and the `entry_valid` triggers are still live

CS-6's own precondition (PHASE-3.md §3.1) is: ALL class-(b)/(c) readers of a
projected column re-routed to blob-truth FIRST. That re-route is not in the
tree. Concretely:

1. **The two divergence checks are not dead code — they are repair triggers.**
   - `session-entry-json.ts:26-31` (the `current_session_id`/`updated_at`
     column-vs-blob veto) fires on 0 of 286 rows in the census run-2 fixture,
     but it is a validity gate feeding 6 live callers, including the
     `entry_valid` backfill classifier
     (`openclaw-agent-db-session-migrations.ts:338`,
     `parseSqliteSessionEntryRecord(row) ? 1 : -1`) and two doctor repair paths
     (`doctor-session-delivery-state.ts`, `doctor-session-entry-rewrite.ts`).
   - `session-canonical-key.ts:178-187` (the lineage column-vs-blob veto) also
     fires on 0 of 286 valid rows, but `doctor-session-canonical-keys.test.ts`
     (around line 676) constructs a diverged `parent_session_key` column by
     direct SQL and asserts `repairCanonicalSessionKeys` finds and repairs it
     (`foundGroups: 1, repairedGroups: 1`). The repair path detects the
     divergence through this check throwing `migration-required`. A repair guard
     that fires 0 times on a HEALTHY snapshot is not dead — it exists to catch
     states that a healthy snapshot does not contain. Deleting it is the §8d
     regression the spec forbids.
   - The coordinator's stated delete range `session-canonical-key.ts:124-194`
     is too greedy regardless: lines 188-225 are the LIVE
     `resolveDeliveryProvenCanonicalSessionKey` check plus the key-shape and
     lineage-normalization audit, which must be preserved.

2. **The `entry_valid` triggers are load-bearing.** `entry_valid` has 4 live
   logic readers that gate real behavior:
   `session-canonical-key.ts:161,166` (throw repair-required),
   `session-accessor.sqlite-entry-availability.ts:154,169,186,189`
   (current/absent/unknown verdict),
   `session-accessor.sqlite-canonical-inventory.ts:162,200` (valid-key filter),
   `session-accessor.sqlite-transcript-state.ts:115` (throw repair-required).
   Deleting the three maintenance triggers while those readers still gate on
   `entry_valid` is the §8d hazard. It also breaks a test THIS PR just landed:
   CS-5's `session-corrupt-row-quarantine.phase3.test.ts:72-83` performs a raw
   `entry_json` UPDATE and depends on the `after_entry_update` trigger resetting
   `entry_valid` to 0.

The correct fix is a reader-reroute changeset (make the 4 readers derive
validity from the blob, not the column) BEFORE the deletion. That re-route is
itself unbuilt scope larger than a single deletion, and it must ship and be
verified before CS-6 can delete anything. Landing CS-6 now would regress the
repair tooling and break the wall. This is escalated to the orchestrator as a
spec-vs-tree ordering conflict.

### CS-7 — structurally post-merge (soak-gated)

CS-7 (PHASE-3.md §4.2 step 3, §4.3, §5) requires a production soak of at least
one full release cycle of the re-routed build, with zero tripwire hits, plus
census run 3 = zero, plus recorded orchestrator sign-off, before the
irreversible drop. "One changeset cannot contain a soak." CS-7 cannot land in
this PR by the spec's own design. It also depends on CS-6, which is deferred.

## Post-merge human steps (not in this PR)

1. **Live backfill.** Run `tmp_phase3-backfill.ts <live-db> --apply` against
   the production store during a maintenance window, AFTER a full backup. The
   tool is idempotent and resumable. Expect `archived_at` 13 and
   `last_activity_at` 18 fixed on the first apply, 0 on the second.
2. **Soak.** Run the CS-6 build in production for at least one full release
   cycle. The CS-5 tripwire must log zero SELECTs of a droppable column
   outside the writer allow-list.
3. **Column drop.** Only after a zero-hit soak and census run 3 = zero, and
   with recorded orchestrator sign-off, land CS-7. This is the irreversible
   step; the archive table is the one-release backstop.

## Net-LOC accounting

Measured across the landed Phase 3 commits (`7b325e14007..HEAD`):

| CS    | Commit        | Files | +ins | -del |
| ----- | ------------- | ----- | ---- | ---- |
| CS-1  | `232647cd7d1` | 3     | 935  | 0    |
| CS-2  | `01c16be6b07` | 3     | 257  | 0    |
| CS-4  | `dec9ce2908c` | 2     | 104  | 1    |
| CS-3  | `7f62d071c6c` | 3     | 162  | 14   |
| CS-5  | `8d22f63463c` | 4     | 611  | 0    |
| Total | —             | 14    | 2069 | 15   |

The insertions are dominated by the spec + reader audit (CS-1, 935), the test
wall and fences (CS-5, 611), the backfill and census tools (CS-2, 257), and the
per-reader blob-truth re-verifications (CS-3, CS-4). The 15 deletions are the
column-read lines that CS-3 and CS-4 replaced with blob-projection reads. The
larger subtractive win (deleting the divergence checks, the `entry_valid`
triggers, and the two `session_windows` columns) is deferred to CS-6/CS-7 and
lands only after the reader re-route and the production soak.
