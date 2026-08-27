# Phase 1 — Revision + Typed Conflict (#18)

Author: Fable (design, planned + one adversarial revision pass). Executor: Opus. Implementers: Sonnet.
Branch: `rearch/session-store`, worktree `/home/kiri/.openclaw/worktrees/rearch-session-store`.
Status: FINAL. On top of landed Phase 0 wall (33 tests green) + Phase 0.5 shrinks.
Source authority: `PLAN.md` P1 (:41-48), Phase 1 (:127-128), deletion table (:95-108);
`PONYTAIL-AUDIT.md` #1 (~24 bare-throw sites, 14 files; 4 conflict classes), #5 (3 comparators);
`CORRUPTION-FALLBACK.md` Items 1-3 + 7; `PHASE-0.md` (the wall).

**One sentence:** every `session_nodes` write bumps an integer `revision` inside its write
transaction; all CAS compares that integer and nothing else; every conflict is one typed retryable
error behind one retry helper; a sticky corrupt-marker plus skip-resume guard makes a bad DB unable
to crash-loop boot. Permanently kills the rename-CAS bug class (fork #13): value-compare CAS is
key-order-sensitive and satellite-polluted (PLAN.md:25); an integer is neither.

---

## 1. Schema migration

```sql
ALTER TABLE session_nodes ADD COLUMN revision INTEGER NOT NULL DEFAULT 0;
```

- Runs through the existing migration mechanism (schema layer under `src/state/`; wire where
  existing `user_version` migrations live; bump `user_version` to new head). No new framework.
- `ADD COLUMN ... DEFAULT <constant>` is online-safe in SQLite: metadata-only, no rewrite.
- **Backfill: none.** Every pre-existing row reads `revision = 0` via DEFAULT (`0` = "pre-revision
  era"). First write after migration bumps to 1. The DEFAULT *is* the backfill.
- **Migration-boundary CAS (constraint 1):** migration runs at DB-open in the schema-assert path,
  before any session write in that process (all callers funnel through `openOpenClawAgentDatabase`;
  schema asserts run at open). No CAS is "in flight across" the migration within one process — the
  column exists before the first read of any read-modify-write (RMW) cycle. Rule for Sonnet: a CAS
  cycle reads `expectedRevision` and commits compare-and-bump in the same process lifetime against
  the same opened DB; no value-era read ever feeds a revision-era compare. Old rows: first
  revision-era CAS reads expected=0 like any other read — correct by construction.
- **Rollback:** no `DROP COLUMN`. Rollback = the flag (§7): set `OPENCLAW_SESSION_CAS_VALUE_COMPARE=1`,
  CAS reverts to value-compare while the column sits inert (still bumped, ignored). Old binary
  predating the column ignores it (SQLite ignores unknown columns for old queries).

---

## 2. Write-path change

**Rule:** every statement mutating a `session_nodes` row sets `revision = revision + 1` in the same
SQL statement / same transaction. Never a follow-up UPDATE; never bumped outside the mutating
transaction.

- **Which functions:** every writer of `session_nodes` — grep `session_nodes` UPDATE/INSERT/upsert
  sites in `src/config/sessions/` (`session-accessor.*` family) + the schema layer in `src/state/`.
- **INSERT:** new rows start at `revision = 1` (explicit) — distinguishes "never written in-era" (0)
  from "written once" (1).
- **Projected columns still written** exactly as today, same transaction (§3 boundary).
- **Satellites** (`session_participants`, read receipts) get NO revision and do NOT bump the node's
  revision — P4/Phase 5 territory. They simply stop polluting CAS; participant writes stay
  fire-and-forget (PLAN.md:45).
- **Transaction boundary:** revision bump rides the enclosing transaction the code already uses.
  Phase 1 does not restructure transactions.

### 2a. Write-site classification rule (revision-pass Delta 1)

Before touching any write, CS-3 classifies every `session_nodes` write site into exactly one class
and records the table in the PR body:

| Class | Definition | Phase 1 rule |
|---|---|---|
| **CAS (read-modify-write)** | compares before writing today — the ~24 "changed before" sites + 3-comparator sites (ponytail #1/#5) | atomic `WHERE key AND revision = :expected` + bump (§3) |
| **Blind UPDATE** | writes fields with no compare today (fire-and-forget; satellite-adjacent node touches, read-receipt patch path, maintenance stamps — PLAN.md:30) | **bump revision, add NO expected-revision guard.** No fake CAS. Lost-update semantics stay byte-identical to today — pinned by T-A3a/T-A3b |
| **Upsert / INSERT** | row creation or insert-or-replace | INSERT starts at `revision = 1` (§2); the conflict-update arm bumps like a blind UPDATE |

**Key correction (Delta 1):** a blind write that bumps revision does NOT silently invalidate a
concurrent CAS holder — it makes the holder's compare fail, which **surfaces** `SessionConflictError`
(strictly better than today's value-compare, which can miss the interleave). The genuinely
unsurfaced direction — a blind write losing a CAS holder's committed data (blind-write lost-update)
— is *today's* behavior, unchanged by Phase 1, and pinned: the agentStatus clobber
(`sessions-patch.ts:397-399`) IS a blind-write lost-update, red-pinned by T-A3a until Phase 5.

**No blind write becomes a CAS in Phase 1.** Conversion changes interleave outcomes the wall pins as
current behavior; if a conversion made T-A3a stop clobbering, that is the §9 scope-leak rejection.
Blind→CAS conversions are Phase 5 (satellite contracts). Phase 1's invariant: **revision counts
every write of every class**, so no CAS holder is invalidated without a surfaced conflict. Sonnet
notes any blind site that "should" be CAS as a Phase 5 candidate in the table; no conversion lands.

---

## 3. CAS change — the core

One shape everywhere:

```
UPDATE session_nodes
SET <mutation...>, revision = revision + 1
WHERE key = :key AND revision = :expectedRevision
```

`changes === 0` → re-read the row's actual revision, throw
`SessionConflictError { key, expectedRevision, actualRevision, retryable: true }` (§4).
Compare-and-bump is atomic in one statement — no read-then-write window.

**Every compare site moves to revision.** Locate via two fingerprints: (a) every
`throw new Error("...changed before...")`; (b) every call into the 3 comparators (ponytail #5, 3
files) used for concurrency decisions.

**Deletions (PLAN.md:95-108 rows 1, 6):**
- `sqliteSessionEntriesEqual` (the `JSON.stringify` primitive, PLAN.md:25) — moved into the
  flag-gated fallback branch as its only remaining caller; full delete completes at flag removal (§7).
- **Participant strip/re-add round trip — deleted from the new path** (satellites structurally cannot
  enter the compare). Flag's fallback branch keeps the strip logic only inside itself.
- Ponytail #5's 3 comparators: the two used purely for CAS die with the compare change. Any
  comparator call serving a non-concurrency purpose (e.g. "skip no-op write") is out of scope —
  leave it, note for Phase 2/3. Sonnet classifies each call site CAS vs non-CAS before deleting.

**Boundary (constraint 2, PLAN.md:141):** CAS stops *reading* projections/entry values. The 24
projected columns on `session_nodes` + ~10 on `session_windows` are still *written* every write, same
transaction, byte-identical to today. Divergence check, `entry_valid` triggers, parsers, projection
pipeline — untouched (Phases 2-3). **Any diff hunk in a projection-write or parser path is scope leak
→ reject.**

---

## 4. `SessionConflictError` + throw-site replacement

```ts
class SessionConflictError extends Error {
  readonly key: string;
  readonly expectedRevision: number;
  readonly actualRevision: number;
  readonly retryable = true as const;
}
```

One file in the sessions module; the ONLY conflict type callers may catch; `instanceof`-checkable
(kills substring matching, ponytail #1).

**Existing 4 typed classes:**
- `SqliteSessionMutationConflictError` + `SqliteTranscriptMutationConflictError` (its entry-CAS throw
  sites) — **subsumed**: throw sites now throw `SessionConflictError`; old classes become deprecated
  aliases (`extends SessionConflictError`) one release, then die with the flag.
- `TranscriptTurnAdmissionConflictError` + `SessionWorkStartInvalidatedError` — **not entry-CAS**
  (admission/lifecycle; `SessionWorkStartInvalidatedError` is well-designed core, PLAN.md:17-18).
  **Keep untouched.** Full "one base + kind discriminant" unification deferred.

**~24 bare-string sites, 14 files (Delta 6 — repo-wide):**
- Sweep: `grep -rn "changed before"` across the **entire repo** (exclude test fixtures that
  intentionally assert the old string, and docs). Expected concentration `src/config/sessions/`,
  `src/state/`, gateway session methods — an *expectation to verify*, not the search boundary. Any
  hit outside those dirs is still a replacement site (or gets explicit not-entry-CAS classification).
- Each hit → (a) `SessionConflictError` with real `expectedRevision`/`actualRevision` when it is an
  entry-CAS failure, or (b) explicit not-entry-CAS classification with one-line justification in
  changeset notes.
- **Gate:** repo-wide grep for a bare-string `"changed before"` **throw** returns zero. Allow-list of
  surviving occurrences: test files asserting the new error's absence, docs, changelog — each listed
  in the PR body.

---

## 5. `withSessionRetry` — the 3-idiom collapse (hardened, Delta 3)

- **Signature:** `withSessionRetry(fn: (attempt: number) => Promise<T>, budget)`. Helper passes
  **only the attempt number** — it holds no snapshot, no expectedRevision, no entry; nothing stale it
  *can* pass. Retries on `SessionConflictError` (and only `retryable === true`); on exhaustion
  rethrows the last one. Small backoff/jitter matching the strongest existing idiom — steal.
- **Hard rule (doc-commented on the helper):** `fn` MUST perform its own fresh read (row + current
  revision) inside its body **every attempt**, then apply the caller's intended mutation to that
  fresh state. A `fn` closing over a pre-read snapshot/expectedRevision is a review-reject.
- **Stale-closure tripwire:** helper compares consecutive `SessionConflictError.expectedRevision`.
  Two consecutive conflicts with the **same** expectedRevision ⇒ `fn` did not re-read → stop
  immediately, rethrow wrapped non-retryable "stale closure — fn must re-read per attempt". Never
  burns the budget on an unwinnable loop.

**The 3 idioms (PLAN.md:27):**
1. Loop-with-recompare retry around entry CAS → **replaced** by `withSessionRetry`.
2. Retry-as-value union (functions returning a "retry" sentinel) → **collapsed**: callee throws
   `SessionConflictError`, caller wraps; the union type dies.
3. Sleep-based projection-lag retry (`session-history.ts:499-562`) → **NOT touched** (PLAN.md:103 →
   Phase 4; papers a read-after-write race revision CAS does not fix). Named out-of-scope in the
   changeset so nobody collapses it. Matches deletion-table row 7 ("2 of 3 deleted").

---

## 6. Corruption marker + skip-resume guard (Phase 1's CORRUPTION-FALLBACK slice)

Phase 1 owns exactly three CORRUPTION-FALLBACK rows (Item 7 table):

**6a. Sticky corrupt-marker + skip-resume guard (Item 3 — crash-loop killer).**
- Extend the catch at `openclaw-agent-db.ts:349-359` (today only latches via
  `recordOpenClawAgentDatabaseOpenFailure`): on terminal integrity/schema failure, write a
  **persistent marker** into the existing quarantine ledger (`readOpenClawDatabaseQuarantine` :280 /
  `clearOpenClawDatabaseQuarantine` :164 — extend, no parallel store), move the corrupt file to a
  quarantine path, restore from LKG if present (6b) else init empty. Marker records timestamp,
  failing check, quarantined-file path.
- **Guard:** `markStartupOrphanedMainSessionsForRecovery` (`server-startup-post-attach.ts:634`) and
  `scheduleRestartAbortedMainSessionRecovery` (:1452) consult the marker before acting; a marked DB's
  sessions are **skipped**, never re-resumed. Marker cleared only by operator (doctor) or a verified
  successful restore — never auto-cleared by a later clean open.
- **Ordering interlock (Item 6):** check/restore/marker sits before :634; the 4-step startup order
  T-A2 pins is NOT reordered (a pre-step + two in-step consultations) → T-A2 stays green.

**6b. Whole-DB LKG snapshot + restore (Item 2).** Publish via `createVerifiedSqliteSnapshot`
(`sqlite-snapshot.ts:633`) + `publishVerifiedSqliteFile` (:414) after clean startup (post
`unlockStartupMethods`) and at most hourly; `sessions.db.lkg` beside the DB; retention = 2
generations + the quarantined corrupt file. Restore logs the lossy-rewind caveat — never silent.
- **Restore→re-migrate interlock (Delta 5):** a restore never yields a usable handle directly. After
  `publishVerifiedSqliteFile` installs the LKG copy, the restore path **re-enters the full open
  funnel** (`openOpenClawAgentDatabase` :218). Re-open finds `user_version` below head → **re-runs
  the Phase 1 migration**; `ALTER TABLE ADD COLUMN` runs only when version < head (idempotent by
  `user_version` gating), never re-executes against a migrated file. A pre-Phase-1 LKG restores →
  migrates → opens; the column exists before any read/write, preserving §1's boundary on the restore
  path. Restored old-schema rows read `revision = 0` per DEFAULT — identical to first-deploy.

**6c. App-level open-time validation + budget (Item 1).** On top of the live pragma check at :332:
verify `user_version == migration head` (composes with Phase 1's own migration) + bounded smoke-read
of `session_nodes` (count + parse newest `entry_json`). Whole check ≤ 750 ms; oversized DBs downgrade
to `quick_check` + smoke-read; over-budget logs a doctor warning, never blocks boot.

**Not Phase 1** (Item 7): row-quarantine / `SessionRowCorruptError` (Phase 2 — needs one-parser
pipeline); consolidated doctor view (Phase 6 — Phase 1 ships only structured log lines).

---

## 7. Backward-compat flag (constraint 4; Delta 4 contract fix)

- **Name:** `OPENCLAW_SESSION_CAS_VALUE_COMPARE` (env var; register in the repo's flag registry if one
  exists, same name).
- **Default: off** — revision CAS is the default from day one. The flag is a parachute, not a
  gradual rollout.
- **Gates the compare predicate only:** flag on → CAS sites use legacy value-compare
  (`sqliteSessionEntriesEqual` + participant strip/re-add), throwing the same-**shape**
  `SessionConflictError` (`actualRevision` read from the row). Revision **still bumps on every write
  in both modes** (mid-release flag flip is safe — revisions never stop counting). Marker/guard and
  retry helper are unconditional.
- **Contract shared by both modes is SHAPE-ONLY (Delta 4):** every entry-CAS write either succeeds or
  throws `SessionConflictError` with correct fields. **NO conflict-detection parity.** Flag-ON
  conflicts on value inequality and can **miss** a real interleave (same value, different revision =
  ABA — the exact value-compare weakness, PLAN.md:25); flag-OFF conflicts on revision inequality and
  may conflict on a no-op value rewrite. ABA-masking under flag-ON is *the reason* flag-OFF is the
  default.
- **Removal criterion: one release** (PLAN.md:127). The next release ships a changeset deleting the
  flag, the value-compare branch, `sqlite-entry-equality.ts`, the strip/re-add remnant, and the
  deprecated alias classes (§4). Opus files that removal ticket during Phase 1 landing so it can't be
  forgotten.

---

## 8. NEW Phase 1 test wall (green-by-design; constraint 5)

- **T-P1a (property, conflict-contract):** for arbitrary generated session shapes + arbitrary
  `sessions.patch` mutations, every patch either succeeds or rejects with
  `err instanceof SessionConflictError` (assert `retryable === true`, `actualRevision > expectedRevision`,
  error chain never contains a bare `"changed before"`). Run **flag-off AND flag-on** — the
  both-modes clause asserts the error **shape** contract ONLY (Delta 4). Generator must NOT assert
  *which* interleaves conflict under flag-ON; a flag-ON ABA case may legitimately succeed where
  flag-OFF conflicts.
- **T-P1f (writer-inventory bump, NEW — Delta 2):** for **each row of the §2a classification table**
  (archive, delete/tombstone, maintenance stamp, admission-path node write, read-receipt blind patch,
  entry-patch upsert), perform that write against a fixture row and assert `revision` strictly
  increased. Iterates the classification table — a write class found in CS-3 but not exercised here
  fails review by table/test mismatch. Satellites excluded (not `session_nodes` writes).
  **Static gate companion:** CS-3 grep-asserts every `UPDATE`/upsert on `session_nodes` in scope
  contains the `revision` bump expression.
- **T-P1b (concurrency):** two connections, one DB file. A reads (captures expectedRevision); B lands
  a participant write AND an entry patch interleaved; A patches with stale expectation. Assert:
  (i) A fails with `SessionConflictError` (correct expected/actual) when B's *entry patch* intervened;
  (ii) a participant-only interleave does NOT conflict A (satellites excluded — pins the exact
  improvement over value-compare); (iii) `withSessionRetry(A.patch, 3)` then succeeds.
- **T-P1c (retry helper):** (i) a correct `fn` (re-reads each attempt) succeeds after N-1 injected
  conflicts; does not retry non-retryable errors; rethrows on exhausted budget; (ii) **NEW** a
  deliberately stale-closure `fn` (fixed expectedRevision) terminates on attempt 2 via the tripwire,
  not at budget exhaustion.
- **T-P1d (migration boundary):** open a fixture DB at pre-Phase-1 schema; migrate; assert all rows
  read revision 0; write one; assert revision 1 and CAS-from-0 works.
- **T-P1e (corrupt marker):** fabricate a terminally-corrupt DB → open → assert marker written, file
  quarantined, LKG restored (or empty init), resume path skips marked sessions (drive :634/:1452 or
  the A2-style fixture). Second boot on the same marker: still skipped (sticky, anti-#32160). Marker
  survives a clean open; clears only via the clear API. **NEW case (Delta 5):** restore a fixture LKG
  built at pre-Phase-1 schema; assert re-opened DB has the `revision` column at head `user_version`,
  rows read 0, subsequent CAS-from-0 succeeds.

---

## 9. Wall-preservation matrix (constraint 3)

| Test | Post-Phase-1 | Why |
|---|---|---|
| T-A1a/b/c (drain ×3) | **green, unchanged** | drains untouched (Phase 6) |
| T-A2 (startup ordering) | **green, unchanged** | corruption interlock is pre-step + in-step consultation; 4-step order not reordered (CORRUPTION-FALLBACK Item 6) |
| T-A3a (agentStatus clobber) | **RED-PINNED — still clobbers** | clobber lives in the read-receipt blind-write path (`sessions-patch.ts:397-399`), fixed only by Phase 5. Phase 1 changes *how patch CAS-compares*, not *what fields it writes*. **If T-A3a flips green, Phase 1 leaked into Phase 5 — reject.** `// PINNED-BUG: Phase 5` stays |
| T-A3b (participant interleave) | **green** (pinned outcomes unchanged) | participants stay fire-and-forget; revision CAS excludes them from entry-compare but does not change their own write behavior |
| T-A3c (maintenance vs admission) | **green, unchanged** | admission untouched (PLAN.md:17) |
| T-A4 (reseed, 3 cases) | **green, unchanged** | resumption ordering is Phase 4 |
| T-WS (subagent attribution) | **as Phase 0 recorded** (green; or red-via-`test.fails`, non-gating) | #24, untouched |
| T-SH (parent/spawnedBy read-back) | **green** | only #24 may flip it (PHASE-0.md §C); Phase 1 changes no projection/read-back |

Gate rule per changeset: full Phase 0 wall runs; any deviation from this matrix fails the gate.

---

## 10. Dispatch (Opus → Sonnet)

Order: error type first (pure, everything imports it) → migration → write/CAS core → satellites.

| CS | Contents | Depends | Gate |
|---|---|---|---|
| **CS-1** | `SessionConflictError` + `withSessionRetry` (fn-re-reads contract + stale-closure tripwire) + T-P1c. Pure additions, no call-site changes. Deprecated-alias shims for the 2 subsumed classes (unused until CS-3). | — | new tests green; oxlint; full session suite green |
| **CS-2** | Schema migration: DDL, `user_version` bump, INSERT-starts-at-1 documented in accessor; T-P1d. Revision column exists and **bumps on write** from here on (inert until CS-3 reads it). | — | T-P1d green; Phase 0 wall green; migration idempotent on re-open |
| **CS-3** | **The core.** §2a classification table (in PR body); CAS sites → revision compare (atomic `WHERE key AND revision` + bump); flag gating the legacy predicate branch; `sqliteSessionEntriesEqual` → flag-branch-only; participant strip/re-add deleted from new path; ~24 "changed before" → `SessionConflictError` (repo-wide grep-driven, per-site CAS/not-CAS classification); retry idioms 1-2 → `withSessionRetry`; idiom 3 (`session-history.ts:499-562`) untouched; T-P1a/b/f + static bump grep. Opus may split 3a (accessor write leaves) / 3b (throw-site sweep) / 3c (retry collapse) if the diff exceeds review appetite, landing in that order. | CS-1, CS-2 | T-P1a/b green flag-off AND flag-on; T-P1f + static grep pass; repo-wide `"changed before"` throw grep = zero; **wall matrix §9 holds exactly — T-A3a still red-pinned**; oxlint; full suite |
| **CS-4** | Corruption slice: marker in :349-359 catch, quarantine-ledger extension, skip guards :634/:1452, LKG publish post-`unlockStartupMethods` + hourly, restore re-enters open funnel, app-level open validation + 750ms budget, structured logs; T-P1e (incl. pre-Phase-1 LKG restore case). | CS-1 | T-P1e green; **T-A2 green unchanged**; restore path demonstrably re-enters `openOpenClawAgentDatabase`; full suite |
| **CS-5** | Landing sweep: flag-removal ticket filed (§7); deletion-table rows 1/6/7 accounting + net-negative LOC in `src/config/sessions/` (excl. tests, PLAN.md:108); §2a classification table + §9 wall matrix pasted in PR body with per-test evidence. | CS-3, CS-4 | all above green; one Phase 1 PR on the fork |

CS-1 ∥ CS-2. CS-4 ∥ CS-3 after CS-1. One PR per phase on the fork (PLAN.md:149), stacked commits.

---

## 11. Out of scope — reject on sight

- **No projection consolidation** (Phase 2): parsers, aliases, inline re-assembly, lint fence,
  `SessionRowCorruptError`, row quarantine. Projected columns still written everywhere.
- **No column demotion** (Phase 3): no reader audit, no divergence-check deletion, no `entry_valid`
  trigger removal, no `session_windows` shrink.
- **No resumption ordering** (Phase 4): `resume_epoch`, drain-before-dispatch, `session-history.ts:499-562`
  sleep-retry all stay.
- **No read-receipt split / satellite contracts** (Phase 5): agentStatus clobber stays; participants
  get no revision, no API, no concurrency control; **no blind-write→CAS conversion**.
- **No admission/drain/startup-machine work** (Phase 6); no doctor consolidation beyond log lines.
- **No unification** of `TranscriptTurnAdmissionConflictError` / `SessionWorkStartInvalidatedError`.
- Success metric: net-negative LOC in `src/config/sessions/` (excl. new tests), all gates green.
