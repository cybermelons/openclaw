# Session Management Re-Architecture (openclaw-src)

Date: 2026-08-26. Author: Fable (design only, no code).
Supersedes: `tmp_plan-session-store-architecture.md` (narrower, issue-13-scoped).
Evidence: two code-survey maps (storage layer; lifecycle/API/writers). File:line refs below come from those surveys against current main.
Companion: `./PONYTAIL-AUDIT.md` — independent reduction audit of the same scope. Confirms this plan from the deletion side; its findings #1/#3/#5 are Phases 1–3 measured in call sites. Finding numbers (#N) below refer to that report.
Companion: the harness-research report (`./HARNESS-RESEARCH.md`) — benchmarks this plan against other coding-agent harnesses (Claude Code, Codex, Cursor, Goose, Aider, Amp); confirms P1/P5 as field-leading and informs the refinements and stolen patterns below.

---

## Verdict on the accretion hypothesis

Confirmed, with nuance. The subsystem is not uniformly bad — it is **a decent skeleton buried under accreted compensation layers**.

Well-designed core (keep):

- `session-lifecycle-admission.ts` — total lock ordering, admission vs lifecycle-mutation separation, AsyncLocalStorage self-vs-competitor detection. Genuinely structural.
- Typed errors where they exist (`SessionWorkStartInvalidatedError`); zero string-matched error sniffing repo-wide.
- No-channel tombstone path is truly transactional.

Accreted rot (the instability you feel):

- `src/config/sessions/` = **73,184 LOC, ~240 files; 82 `session-accessor.*` files**.
- Same fact stored **3×** (entry_json blob → 24 projected columns on `session_nodes` → ~10 duplicated again on `session_windows`); divergence check covers 2 of 24 columns and returns silent `null` (`session-entry-json.ts:26-31`).
- **CAS primitive is `JSON.stringify` on projected objects** (`sqlite-entry-equality.ts:8`) — key-order sensitive, no field merge possible. **30+ throw sites** of bare `new Error("...changed before...")`; only 2 are typed. Callers cannot distinguish retryable race from real fault.
- **Two parsers for one column** (participant-less silent-null vs participant-full throwing), aliased under a second name in 3 files. Five distinct entry shapes counting cache/list projections.
- Three retry idioms in one module; sleep-based projection-lag retry (`session-history.ts:499-562`) papering a read-after-write race.
- **Dated incident carve-outs as architecture**: 2026-07-26 permanently-unadmittable-session incident produced `hasOrphanedMainRestartRecoveryFences` — a garbage collector for the state machine's own invariants (`main-session-recovery-state.ts:185-203`).
- Correctness-critical orderings enforced only by statement sequence, zero tests: startup orphan-marking before channel start (`server-startup-post-attach.ts:626`, `:1464-1466`); recovery drain after dispatch (issue 13 addendum); five unrelated drain timeouts (2s/5s/15s/300s/1s) with no nesting invariant.
- Uncoordinated satellite writers: participants have **no concurrency control at all** (6 fire-and-forget call sites); a Control-UI read-receipt patch **deletes live `agentStatus`** written by a running turn (`sessions-patch.ts:397-399`); maintenance-vs-turn safety is a two-sided prose convention split across two files.
- Debt is untagged: 3 TODOs total in 73k lines. The real markers are "changed before", "best-effort", and dated comments.

Root pattern, stated once: **state is duplicated across representations, compared by value instead of version, and ordered by call sequence instead of by commit.** Every incident (rename CAS, N-1 resumption, 2026-07-26 unadmittable sessions, projection-lag) is an instance of that one pattern.

Independent confirmation: the ponytail audit found **zero dead code and near-zero YAGNI in scope** — the bloat is structural duplication, not removable modules, which is why the fix is collapse-to-one-truth (net-negative LOC via consolidation), not deletion.

---

## Target architecture — five principles

### P1. One truth, versioned

`session_nodes` gains `revision INTEGER NOT NULL`. Every write bumps it inside the write transaction. All concurrency control compares **revision**, never entry values.

- `sqliteSessionEntriesEqual` deleted. The participants-stripping hack becomes unnecessary — satellites never enter the compare because the compare is an integer.
- One typed error: `SessionConflictError { key, expectedRevision, actualRevision, retryable: true }`. All 30+ bare-string throws replaced.
- One retry helper (`withSessionRetry(fn, budget)`) replaces the three idioms. Retry-as-value union collapses into it.
- Field position (harness research): no surveyed harness publishes an optimistic-concurrency scheme as rigorous as revision-int + typed `SessionConflictError` — the field mostly avoids the problem by single-writer-per-file construction, which we cannot: we have genuine multi-writer sessions (subagents + satellites).

### P2. Columns are indexes, not truth

Projected columns on `session_nodes`/`session_windows` become **write-only query indexes**: written in the same transaction as `entry_json`, but _no logic path reads them back as facts_. Logic reads blob + revision only.

- Divergence becomes structurally impossible to observe → the silent-null 2-of-24 check deleted.
- `session_windows` duplicated status/model/etc columns shrink to what queries actually filter on.
- The `entry_valid` trigger-plus-compensating-UPDATE dance is replaced: validity derived from revision write completing in-transaction. Triggers deleted.

### P3. One projection pipeline

Exactly one `projectSessionEntry(row, satellites)`: shape → owner → participants, always all three, `participants: []` when none (absent≠empty bug dies). One parser with one failure contract: corrupt row → typed `SessionRowCorruptError`, always, never silent null.

- Deleted: `parseSessionEntryJson` vs `parseReadableSqliteSessionEntryRow` split, the `parseSessionEntryRow` aliases, per-call `tableHasColumn` feature detection (resolve once at DB open), the cache layer's fifth shape (cache stores the canonical shape).
- Lint fence: only the accessor module may import the parser or touch session tables in SQL.

### P4. Satellites with explicit contracts

Participants, read receipts, heartbeat outcomes, progress cards stay separate tables (correct instinct already in code) but get formalized:

- Each satellite: own revision or last-write-wins, declared in one contract file, not scattered comments.
- **Read receipts split from the entry**: `last_read_at` moves out of the patch path that can touch `agentStatus`. Marking read may never mutate turn-owned fields — enforced by the satellite API surface, not reviewer vigilance.
- Participant writes get a tiny typed API (insert-or-bump, idempotent); still fire-and-forget-safe because ordering vs entry no longer matters (P1 excludes them from CAS by construction).
- Right-sizing rule (harness research): size contract weight per writer count. Single-writer satellites (e.g. progress cards, written only by the owning turn) use last-write-wins and skip revision; multi-writer satellites (e.g. participants, concurrent fire-and-forget) get the full contract. Do not over-apply revision to every satellite.

### P5. Ordering by commit, not by sequence

- **Resumption**: interrupted-turn tail drain + `resume_epoch` marker commit in one transaction _before_ dispatch; history reseed refuses a drain-pending epoch with a typed error. Projection-lag sleep-retry then deleted (it exists only because this ordering is absent).
- **Startup**: explicit phase machine — ordered list `[markOrphans, captureRecoveryCutoff, unlockMethods, startChannels, scheduleRecovery]` executed by a runner that asserts order; a unit test pins the sequence. Reordering edits stop compiling silently.
- **Drains**: one budget tree — restart drain (300s) owns session_end drain (2s) and admission drain (15s) as named children; child budgets derived, relationship documented in one place.
- Chunk-skew hazard in admission shared state (`session-lifecycle-admission.ts:56-80`): move the fence's source of truth into SQLite (a lease row keyed by process generation — machinery recovery already has) so two bundle generations coordinate through the DB, not a versioned globalThis object.
- Field validation (harness research): Codex validates P5's spirit cheaply via append-and-flush-before-ack — the append IS the commit. Our heavier apparatus (resume_epoch, drain-before-dispatch, phase-ordered startup) is warranted only where we have concurrent writers + process restarts, which Codex's single-process model never faces.

---

## Stolen patterns (from harness research)

Ranked, concrete:

1. **Append-and-flush-before-ack** (Codex) — the cheapest ordering-by-commit primitive for naturally-sequential single-writer log paths. Use it instead of epoch/CAS scaffolding wherever it suffices; reserve the heavy machinery for genuinely multi-writer surfaces.
2. **Corruption-detect + restore-from-last-known-good at DB-open**, with a corrupt-marker → quarantine path (never crash-loop) — insurance below CAS. Claude Code's `.claude.json` corruption (5 open issues incl. a resume crash-loop, #32160) shows the cost of having no escape hatch.
3. **Zero-cache discipline check** (Aider re-reads every turn) — during Phase 2/3, assert no path caches a projected entry across a turn boundary. This is the discipline test that P2 actually killed every stale-read path.
4. **Self-contained-record acceptance test** (Codex) — after Phase 2, a corrupt `entry_json` blob must be judgable alone, never needing cross-row reference. An explicit `SessionRowCorruptError` test case.

---

## What gets deleted (the point of the exercise)

| Deleted                                                                                                 | Why possible                                                      |
| ------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------- |
| `sqliteSessionEntriesEqual` + participant strip/re-add round trip                                       | revision CAS                                                      |
| Silent 2-column divergence null-check                                                                   | columns never read back                                           |
| `entry_valid` triggers + compensating UPDATEs                                                           | in-transaction validity                                           |
| One of two parsers + 3 aliases + cache's fifth shape (26 call sites across both names, per ponytail #2) | single pipeline                                                   |
| Projection-lag retry loop (`session-history.ts:499-562`)                                                | commit-ordered resumption                                         |
| ~28 bare-string CAS throws (~24 sites call-site-verified across 14 files, per ponytail #1)              | typed SessionConflictError                                        |
| 2 of 3 retry idioms                                                                                     | one helper                                                        |
| Residue GC (`hasOrphanedMainRestartRecoveryFences`) — eventually                                        | states it cleans become unreachable once fences live in DB leases |

Success metric per phase: net-negative LOC in `src/config/sessions/` with green gates.

---

## Migration — seven phases (plus a 0.5 warm-up), each lands alone

**Phase 0 — characterization wall (before any refactor).**
Tests that pin current behavior at the untested seams: shutdown drain (currently ZERO tests), startup ordering, cross-writer interleaves (unread-clear vs live turn; participant write vs archive/delete; maintenance vs admission), the `prepare.ts:1629` three-state reseed decision (caller side — the recorded bug was there, tests are on the callee). These tests survive the refactor; they are the safety net.
Investigation item (ponytail #8): `isSqliteTranscriptTarget` dead export at `paths.ts:50` — doc comment says callers "must branch on this," zero call sites. Verify whether it is a missing guard (latent bug) or truly dead before touching.
Design item (stolen pattern 2): spec the corruption fallback — boot-time integrity check at DB-open, restore-from-last-known-good, corrupt-marker → quarantine path so a bad row/DB can never produce a resume crash-loop.

**Phase 0.5 — mechanical warm-ups (safe now, zero behavior change).**
The ponytail audit's safe-anytime shrinks, landed before revision-CAS. Net-negative LOC, test-protected, no behavior change; they shrink the surface the later phases must touch.

- #2: kill the `parseSessionEntryRow` alias of `parseSessionEntryJson` (8 files).
- #4: extract `buildSessionParticipantUpsert()` — byte-identical conflict-merge logic (3 sites).
- #6: extract `upsertSessionConversationLink()` — repeated onConflict/doUpdateSet tuple (3 sites).
- #7: unify the `parent_session_key`/`spawned_by` fallback computed two ways in `bindSessionNode` (1 file).

**Phase 1 — revision + typed conflict.** `ALTER TABLE ADD COLUMN revision DEFAULT 0`; bump on write; CAS sites compare revision; `SessionConflictError` + one retry helper. Value-compare kept behind flag one release. Kills the rename-bug class permanently.
Measured by ponytail #1 (4 conflict-error classes + ~24 bare-throw sites across 14 files) and #5 (3 ad-hoc entry comparators).

**Phase 2 — projection consolidation.** One parser, one pipeline, participants always present, aliases deleted, lint fence up. Safe because Phase 1 made CAS projection-agnostic.
Measured by ponytail #3 (inline projection re-assembly, 6 files) and #2 (parser alias — remainder if not fully cleared in Phase 0.5).

**Phase 3 — columns demoted to indexes.** Audit readers of projected columns; route logic reads through blob; delete divergence check + `entry_valid` triggers. Schema migration for `session_windows` column shrink.

**Phase 4 — resumption ordering.** Drain-before-dispatch + `resume_epoch`; delete sleep-retry. (Issue 13 addendum Fix 1a, done structurally.)

**Phase 5 — satellite contracts.** Read-receipt split (fixes agentStatus clobber), participant API, contract file per satellite.

**Phase 6 — process-seam hardening.** Startup phase machine, drain budget tree, admission fence into DB leases. Then retire the residue GC.

Order rationale: 1 before 2 (CAS must stop caring about projections before projections move); 0 before everything; 6 last (highest blast radius, needs the wall).

Over-build check (harness research): the Phase 6 DB-lease admission fence and the Phase 0 characterization wall are NOT over-built — the research found no simpler proven field pattern for two-process-generation handoff, and the field's absence of a Phase-0-style safety wall is exactly why the Claude Code corruption bugs linger across 4 duplicate issues.

Rough scale: phases 0-4 = the stability payoff, each an evening-to-weekend PR cluster for the Opus/Sonnet pipeline. Phases 5-6 are optional-but-recommended hardening.

## Roles

Fable: this doc. Opus: per-phase changesets, Sonnet implementers, landing agent per phase, one PR per phase on the fork. Gates: targeted vitest + oxlint + the Phase-0 wall.

## Decisions ruled

- **Scope: fork-only.** All work stays on `cybermelons/openclaw`. No upstreaming attempt for Phases 1–2 (Marc, 2026-08-26).

## Decisions needed from Marc

1. Green-light Phase 0 + 1 now? (Lowest risk, highest payoff pair.)
2. Fork-only, or attempt upstreaming phases 1-2 (they are upstream-palatable; 3+ likely too invasive)?
3. Post this design as an issue on the fork for tracking?
