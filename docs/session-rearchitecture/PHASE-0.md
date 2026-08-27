# Phase 0 — Combined Characterization / Confirmation Wall (#18 + #24)

Author: Fable (design). Executor: Opus. Implementers: Sonnet.
Status: FINAL (revised once). Marc pre-approved all phases; this is the first unit of work.
Source plans: `./PLAN.md` (#18, 7-phase store integrity), `../session-graph-readpath/PLAN.md` (#24, read-path).

**Phase 0 contract:** every test here must be GREEN against current main (behavior-pinning),
with exactly one sanctioned exception (T-WS, whose pass/fail is itself the deliverable).
A test that pins a known bug asserts the buggy behavior and carries a `// PINNED-BUG:` comment
naming the later phase that will flip it. Zero production-code changes. Zero schema changes.
The wall survives Phases 1–6 as the safety net.

---

## Section A — #18 characterization tests

### A1. Shutdown drain (currently ZERO tests) — 3 tests
Seam: five drain timeouts (2s/5s/15s/300s/1s), no nesting invariant, enforced by statement
sequence (#18 PLAN.md:29; P5 drain budget tree :78). Sonnet locates the drain entry points
(restart 300s; session_end 2s; admission 15s near `src/config/sessions/session-lifecycle-admission.ts`).

- **T-A1a** — session_end drain persists an in-flight transcript append before shutdown returns.
  Assert event readable from `transcript_events` when drain resolves. If main loses the write
  after the 2s budget, pin the loss with `// PINNED-BUG` → Phase 6.
- **T-A1b** — drain timeout budget honored: a never-yielding turn returns within budget (+slack),
  record the un-drained turn's resulting state.
- **T-A1c** — nested drain: restart drain (300s owner) while session_end drain (2s) active;
  pin current interaction. Baseline for the Phase 6 budget tree.

### A2. Startup ordering — 1 test (two shapes, decision rule)
Seam: orphan-marking before channel start; statement-sequence only at
`server-startup-post-attach.ts:626`, `:1464-1466` (#18 PLAN.md:29).

- **Shape 1 (preferred)** — full boot harness, spy call order of markOrphans / recovery-cutoff /
  channel start / recovery scheduling; assert == main's sequence.
- **Shape 2 (fallback)** — no boot: instrument the startup routine against name-appending stubs,
  assert order array. Degrade further to `vi.mock` collaborator spies if not stub-invokable.
  No shape modifies production code.

**Decision rule (bounded):** timebox Shape 1 to ~2h searching for an EXISTING bootable gateway
harness. Found → reuse (Shape 1). Not found → go straight to Shape 2. Do NOT author a new boot
harness in Phase 0 (own blast radius; stalls the wall). Note skipped Shape 1 as a Phase 6 candidate.

### A3. Cross-writer interleaves — 3 tests
- **T-A3a** — unread-clear vs live turn (agentStatus clobber): `sessions-patch.ts:397-399`.
  Assert `agentStatus` IS deleted (current bug). `// PINNED-BUG: #18 Phase 5 read-receipt split.`
- **T-A3b** — participant write vs archive/delete: 6 fire-and-forget sites, no concurrency control
  (#18 PLAN.md:30). Interleave upsert with archive and with delete; pin each outcome.
- **T-A3c** — maintenance vs admission: prose-convention safety (#18 PLAN.md:30);
  `session-lifecycle-admission.ts`. Pin whether maintenance skips/blocks/proceeds vs in-turn session.

### A4. `prepare.ts:1629` three-state reseed (CALLER side) — 1 test, 3 cases
Seam: N-1 resumption bug was caller-side; existing tests cover callee only (#18 PLAN.md:115).
- **T-A4** — drive caller through each of 3 reseed states, pin each decision/dispatch.
  Coverage check confirms all three branches hit. Protects #18 Phase 4.

---

## Section B — #24 write-side confirmation test (the single unproven claim)

**T-WS — subagent tool-call attribution.** Settles #24 open question 1 (#24 PLAN.md:138).
1. Spawn a subagent from a parent session (real spawn path).
2. Run exactly one tool call in the child.
3. **Assertion (two-sided):** the tool-call event exists under the child's `sessionId`/`storePath`
   resolved from `childSessionKey` (same resolution as `session-transcript-readers.ts:75-78`) AND
   NO tool-call event for that call exists under the parent/requester session.
4. Free observations (non-gating, recorded in PR): is `TaskSummary.childSessionKey` populated
   (#24 OQ2, `task-domain-views.ts:33`)? did spawn stamp `parentSessionKey`/`spawnedBy` == run's
   `controllerSessionKey`/`requesterSessionKey` (#24 OQ3)?

**Outcome + CI disposition:**
- **FAILS** (events under parent) → primary drop point CONFIRMED; #24 R3 leads → #24 Phase 4.
  Mark `test.fails` (vitest expected-failure → CI stays GREEN while fact is red). **Non-gating:**
  Phase 0 PR merges on a red T-WS. Comment:
  `// EXPECTED-FAIL until #24 Phase 4; that PR must remove the .fails marker as part of its gate.`
- **PASSES** (events under child) → primary refuted; fault is secondary/tertiary; #24 Phase 1 leads,
  Phase 4 cancelled-unless-reopened. Plain green test.

Gate: the test exists and its verdict is recorded in the PR body. Only allowed red = non-gating.

---

## Section C — SHARED seam test (Section 3 guard, binds both plans)

**T-SH — read-back of `parentSessionKey === spawnedBy` children.**
Write child row where `parentSessionKey == spawnedBy` (collapse at
`session-accessor.sqlite-session-row.ts:104-106`); read back via
`session-accessor.sqlite-canonical-inventory.ts:84-87`.
**Assert: `parentSessionKey` ABSENT on read-back; `spawnedBy` present/correct.**
Companion case: `parentSessionKey != spawnedBy` reads back with BOTH present.
Green on main. Comment states ownership: #18 keeps green (item #7 behavior-preserving);
only #24 flips it, in its own PR, as the visible marker of seam-ownership transfer.

---

## Section D — corruption-fallback DESIGN spec (deliverable: `CORRUPTION-FALLBACK.md`, not a test)
Source: HARNESS-RESEARCH stolen pattern #2; Claude Code `.claude.json` corruption
(#29003/#29036/#29217/#18998, crash-loop #32160). Opus drafts the doc (design, not code); may
commission ONE read-only Sonnet fact-finding pass (DB-open call site + auto-resume-on-boot path).
Must specify all 7: (1) boot-time integrity check at DB-open (SQLite quick-check + app validation,
time budget); (2) last-known-good snapshot policy (when/where/retention + staleness caveat from
#29003); (3) corrupt-marker → quarantine, auto-resume MUST check marker and SKIP (crash-loop killer),
marker cleared only by operator/successful restore; (4) two granularities — whole-DB restore vs
row quarantine via `SessionRowCorruptError` (aligns #18 P3, stolen pattern #4); (5) operator
surfacing (log + doctor); (6) ordering interlock — DB-open/check sits before
`[markOrphans, captureRecoveryCutoff, unlockMethods, startChannels, scheduleRecovery]`, compatible
with T-A2 pin; (7) phase ownership — marker+skip-resume guard=Phase 1, row quarantine=Phase 2,
phase-machine integration=Phase 6.

---

## Section E — `isSqliteTranscriptTarget` investigation (ponytail #8, read-only verdict)
Dead export `paths.ts:50`; doc says callers "must branch," zero call sites (#18 PLAN.md:116).
Procedure: `git log -S` the export; grep for inline equivalent predicate; identify what the branch
protected and whether any current path can hit it. Verdict, exactly one, recorded in PR:
- **(a) Missing guard (latent bug)** — PIN-THE-BUG, identical to T-A3a: ONE test asserting the
  CURRENT unguarded (buggy) behavior, green on main, mandatory `// PINNED-BUG:` naming the follow-up
  issue. File the fork issue = the fix ticket, referencing the pinned test. **Sonnet must NOT fix,
  wire, or delete inline.** Two artifacts only: the green pinning test + the fix ticket.
- **(b) Truly dead** — mark for deletion in Phase 0.5. No deletion in Phase 0.

---

## Section F — dispatch breakdown (Opus → Sonnet)
Six changesets. CS-0 first; CS-1..CS-4 independent after CS-0; CS-4/CS-5 need no CS-0 and start now.

| CS | Contents | Depends | Gate |
|---|---|---|---|
| CS-0 | Shared fixtures: startup-ordering fixture per A2 rule (reuse existing boot harness or stub call-order; never author new boot harness), temp-SQLite session-store fixture, subagent-spawn fixture. Reuse repo conventions (copy > create). | — | compile; oxlint; existing session vitest suite green |
| CS-1 | T-A1a/b/c + T-A2 | CS-0 | new tests green on main; oxlint touched; gateway/session suites green |
| CS-2 | T-A3a/b/c + T-A4 | CS-0 | same; T-A3a asserts clobber (PINNED-BUG mandatory); T-A4 hits all 3 states |
| CS-3 | T-WS + T-SH | CS-0 | T-SH green on main; T-WS exists, verdict recorded (red allowed via test.fails, non-gating) |
| CS-4 | E investigation | none | verdict (a/b) in PR; if (a) pin-bug test green + fix ticket filed; no fix/delete |
| CS-5 | D `CORRUPTION-FALLBACK.md` | none | doc answers all 7 items |

**Intra-phase ordering:** CS-1..CS-4 truly independent once CS-0 lands; no hidden order. The
"T-SH first" fence is CROSS-PHASE only (Phase 0 before Phase 0.5 item #7), not among CS-1..CS-4.
Every CS gate: (1) new vitest green (T-WS exception), (2) oxlint clean on touched files,
(3) full existing session-subsystem vitest suite green — provably zero-regression.
Land as stacked commits in one Phase 0 PR, or split CS-3/4/5 if T-WS's red needs its own record.

Completion report states: T-WS verdict (→ #24 Phase 4 live or cancelled), CS-4 verdict (a/b),
all pinning tests green on main.

---

## Section G — OUT of Phase 0 scope
No refactor, no production-code change, no extraction/rename. No `revision` column / `SessionConflictError` /
retry-helper (Phase 1). No Phase 0.5 warm-ups (#2/#4/#6/#7). No fixes to pinned bugs (agentStatus clobber →
Phase 5; write-side attribution → #24 Phase 4; drain/order weakness → Phase 6). No deletion of
`isSqliteTranscriptTarget` regardless of verdict. No corruption-fallback implementation (spec only). No
`resolveChildParent`, UI/wire changes, or `transcriptEmpty` split (#24 Phases 1/3/5). No visibility-policy
changes. No schema migrations.
