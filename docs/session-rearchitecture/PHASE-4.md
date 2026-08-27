# PHASE-4 — Resumption Ordering (issue #18)

Author: Fable (design only, no code). Date: 2026-08-27.
Builds on: Phase-3 blob-truth reads (landed). Does NOT require Phase-3 CS-7 (post-soak column DROP).

## §1 Objective

Phase 4 establishes one invariant: **a resumed turn is dispatched only after the interrupted-turn tail drain and the `resume_epoch` marker are committed together, in one transaction.** Before that commit, the epoch is _drain-pending_. A reader that needs post-resume history and sees a drain-pending epoch must fail fast with a typed, retryable error — never wait, never sleep. This makes the resume ordering commit-enforced instead of statement-sequence-enforced, and it removes the only reason the projection-lag sleep-retry loop exists. Phase 4 ends with that loop deleted.

## §2 Audit method (CS-1 deliverable)

CS-1 produces `PHASE-4-AUDIT.md`. Mechanism changes are forbidden until this doc exists and is reviewed. It must enumerate:

1. **Dispatch/reseed call sites.** Every site that dispatches a resumed turn or reseeds history for a resumed session. For each: what it reads, what it assumes is already committed, and what runs before it in the current statement sequence.
2. **The sleep-retry loop.** The projection-lag retry in the session-history reader (the ~500-line region flagged in PLAN.md, `session-history.ts:499-562`). List every caller that reaches it and state, per caller, whether the caller depends on the lag-papering (retry hides a read-after-write race) or merely tolerates it.
3. **Current ordering guarantees.** The resume/reseed steps whose order is enforced only by "this statement runs before that statement" in one process. These are the steps that must move inside the marker transaction.
4. **The three-state reseed decision.** The reseed decision point pinned by the Phase-0 characterization test (caller-side pin over `prepare.ts:1629` behavior). Document its three states and which state maps to drain-pending under the new mechanism.

Classify every finding as exactly one of:

- **(a) commit-ordered already** — leave unchanged; record why it is safe.
- **(b) sequence-ordered, must become commit-ordered** — moves into or behind the Phase-4 transaction.
- **(c) sleep-retry crutch** — scheduled for deletion in the late CS.

The audit is the contract. A call site not in the audit may not be changed.

## §3 Mechanism

**The marker.** `resume_epoch` is a per-session marker that names the current resumption generation. Its shape is resolved in §3a: a dedicated `session_resume_epoch` table, not a column on `session_nodes`. It carries a state: `drain_pending` or `drained`. Writing the marker as `drained` and applying the tail drain of the interrupted turn happen in **one transaction**. That is the single transaction boundary of Phase 4:

> BEGIN → drain interrupted-turn tail into the store → set `resume_epoch` = new epoch, state `drained` → COMMIT. Dispatch of the resumed turn is permitted only after this COMMIT returns.

If a two-step protocol is needed (mark `drain_pending` early, e.g. at interruption detection), the pending mark may be its own earlier commit — but drain + `drained` flip are always one transaction, and dispatch always waits for it.

**Drain-pending representation.** An epoch whose marker is absent-but-expected or in state `drain_pending` is drain-pending. Readers can detect it with one read of the marker in the same snapshot as their history read.

**The typed error.** `SessionResumeDrainPendingError`. Thrown by history reseed / resume-path readers when the target epoch is drain-pending. Properties: carries `sessionId` and the pending epoch; **retryable = true** in semantics — the correct caller response is "retry after the resume transaction commits" (event- or caller-driven, never an internal sleep). The error class must be exported from the store package so #24 and callers can catch it by type, not by message string.

## §3a Marker shape (CS-1 resolved)

The §3 fork ("row or column — implementer's choice") is resolved. CS-2 builds a **dedicated table**, not a column on `session_nodes`. Rationale and shape are binding for CS-2..CS-6.

- **Dedicated table `session_resume_epoch(session_key, epoch, state, updated_at)`.** Not a column on `session_nodes`. The drain (`reconcileCliTranscript`) writes only to transcript/window tables; a column on `session_nodes` would pull that row into the same transaction and contend with the Phase-3 `revision`/CAS write path. A dedicated table lets drain + marker commit atomically without touching `session_nodes` CAS. `session_key` is the primary key (one live epoch per session).
- **Monotonic integer `epoch`.** Per session, increments each resumption generation. Readers compare `committed_epoch >= needed_epoch`; a reader needing epoch N is satisfied by any committed row at epoch ≥ N in state `drained`.
- **Explicit `state` enum column: `drain_pending` | `drained`.** State is a stored value, never inferred from row presence/absence. "No row" is not a state — see backfill.
- **Restart scan derivation.** A session needs re-dispatch iff its `session_resume_epoch` row exists with `state = drain_pending`. CS-3 reorders the restart scan (`recoverStore`, audit §7(b)) to this query, replacing the `running`+`abortedLastRun` row heuristic.
- **Backfill / creation invariant.** The CS-2 migration seeds every existing session with `epoch = 0, state = drained`, so no pre-Phase-4 session ever reads as drain-pending (matches §7(d) "treat pre-Phase-4 sessions as drained"). New sessions get an `epoch = 0, state = drained` row at creation. A missing row is therefore an invariant violation, not a drain-pending signal — readers treat absent-row as an error to surface, not as pending.

## §4 Changesets

| CS   | Goal                                                                                                                                                                                                | Files-class touched                                               | Gate                                                                      | Commit stub                                                  |
| ---- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------- | ------------------------------------------------------------------------- | ------------------------------------------------------------ |
| CS-1 | Spec + audit doc per §2. No behavior change.                                                                                                                                                        | docs only (`PHASE-4.md`, `PHASE-4-AUDIT.md`)                      | review; oxlint noop                                                       | `docs(session-store): phase-4 spec + resumption audit`       |
| CS-2 | Introduce `session_resume_epoch` table + states per §3a; schema/migration (backfill existing sessions `epoch=0, drained`); store-layer write API. Marker written but nothing reads it yet.          | store schema + store write module                                 | targeted vitest (marker CRUD + backfill) + oxlint + full prior wall green | `feat(session-store): resume_epoch marker + drain states`    |
| CS-3 | Move tail drain into the marker transaction; dispatch call sites (audit class **b**) reordered to after-commit. Sleep-retry still present (belt-and-suspenders during transition).                  | resume/dispatch orchestration module + store txn module           | new ordering test (§5 T1) + full wall + Phase-0 reseed pin still green    | `feat(session-store): drain-before-dispatch in one txn`      |
| CS-4 | Readers refuse drain-pending: history reseed throws `SessionResumeDrainPendingError`. Flip the reseed decision mechanism; **this CS legitimately flips the Phase-0 characterization pin** (see §5). | history reader module + error types module + the Phase-0 pin test | §5 T2 + updated pin + full wall                                           | `feat(session-store): typed drain-pending refusal on reseed` |
| CS-5 | Delete the sleep-retry loop. Only after CS-3/CS-4 gates prove ordering. Remove dead retry config/helpers with it.                                                                                   | history reader module                                             | §5 T3 deletion-safety + full wall + oxlint (no dead exports)              | `refactor(session-store): delete projection-lag sleep-retry` |
| CS-6 | Phase-4 test wall consolidation + #24 seam doc (§6 interface written down as doc comment + exported types).                                                                                         | tests + docs                                                      | full Phase-0..4 wall green                                                | `test(session-store): phase-4 wall + resume-ordering seam`   |

Ordering is strict. CS-5 never lands before CS-3 and CS-4 gates are green.

## §5 Test wall

- **T1 — drain-before-dispatch ordering.** Fixture: interrupted turn with tail rows pending. Assert: dispatch hook is not invoked until the transaction containing both the drain writes and the `drained` marker has committed. Assert atomicity: inject a failure between drain and marker write → transaction rolls back, no partial drain visible, no dispatch.
- **T2 — reader refuses drain-pending.** Fixture: epoch in `drain_pending`. History reseed → expect `SessionResumeDrainPendingError` (instanceof, carries session + epoch, retryable flag). After marker flips to `drained` in a committed txn, same read succeeds with the drained tail included.
- **T3 — deletion safety.** Run every reader path enumerated in the CS-1 audit against fixtures with zero artificial lag and with the drain txn committed; assert first-read success, no retry needed. Plus a negative probe: assert no code path references the removed retry symbols (compile/lint-level).
- **Pin flip.** The Phase-0 characterization pin on the three-state reseed decision asserts _current_ behavior (lag tolerated via retry). CS-4 is the phase that legitimately changes the mechanism under that pin. The pin test is rewritten in CS-4 to assert the NEW contract: the state that previously entered the lag-retry path now yields `SessionResumeDrainPendingError`; the other two states keep their pinned outcomes byte-for-byte. The rewritten pin stays in the permanent wall.

Gates per CS: targeted vitest + oxlint + full Phase-0..3 wall. Fixture-only; live-DB/soak deferred to post-merge human steps.

## §6 #24 seam

Phase 4 must leave, as a stable exported surface: (1) the `resume_epoch` marker readable through the store API with its state, (2) `SessionResumeDrainPendingError` as an exported, typed, documented-retryable error, and (3) a single point — the post-commit dispatch boundary — where "resumption is durable" is observable (a store-level query or completion signal, not an in-process flag). Issue #24's Phase-4-conditional read/visibility work builds on "an epoch is either drain-pending or fully drained, decided by commit" — it must never need to re-derive resumption state from row heuristics. Interface only; #24's design stays in #24.

## §7 Adversarial pass

- **(a) Marker and drain in separate transactions.** Two failure windows: marker committed, drain not → readers see `drained` and serve a history missing the tail (silent truncation — worst case, worse than today). Drain committed, marker not → epoch stuck drain-pending forever; readers refuse valid data. One transaction removes both windows. This is why the §3 boundary is non-negotiable.
- **(b) Crash between commit and dispatch.** Marker says `drained`, process dies before dispatching the resumed turn. Recovery: on restart, resumption scan finds sessions with a `drained` epoch and no dispatched/completed resumed turn, and re-dispatches. The drain is idempotent-by-committedness (it already happened; restart does not re-drain). CS-3 must make dispatch derivable from committed state — the audit confirms the resumption scan exists or CS-3 adds the check. Crash _before_ commit is the easy case: nothing committed, restart re-runs drain+marker.
- **(c) Readers that must NOT get the error.** Non-resume reads: plain history views, exports, UI listing, cross-session search, anything that tolerates an incomplete tail. These read what is committed and never consult drain state. Only the resume/reseed path — reads whose correctness depends on the drained tail — check the marker. CS-1 audit labels each reader as tail-dependent or not; CS-4 wires the check into tail-dependent readers only.
- **(d) Residual risk.** Callers of the deleted retry that silently depended on lag-papering for a _different_ race than resumption (audit's job to find; if found, that race gets its own issue, not a resurrected sleep). Long drain-pending windows under load turn a hidden latency into visible retryable errors at callers — correct but observable; post-merge soak watches error rates. Migration of the marker on existing sessions (backfill = treat pre-Phase-4 sessions as `drained`).

## §8 Done + landability

Phase 4 is landable when: CS-1..CS-6 merged in order; T1/T2/T3 green; the rewritten reseed pin green; full Phase-0..4 wall green; oxlint clean; the sleep-retry loop and its helpers absent from the tree. Post-merge human steps: soak on live DB watching `SessionResumeDrainPendingError` rates and resumption-scan recovery after a forced restart.

**Predecessors:** Phase 4 does **not** require Phase-3 CS-7 (the column DROP) to have executed. CS-7 is a post-soak cleanup; Phase 4 builds on Phase-3's blob-truth reads, which are already landed. No other Phase-3 step blocks Phase 4.

## Landing log

Per-CS landed state on `rearch/session-store`. Not merged to `main`, not deployed. Tracking issue: cybermelons/openclaw#38.

| CS   | SHA           | State   | Gates                                                                                                                              |
| ---- | ------------- | ------- | ---------------------------------------------------------------------------------------------------------------------------------- |
| CS-1 | `2bdbbe889dd` | landed  | audit doc reviewed; 3 stale spec line-refs corrected + re-verified against tree                                                    |
| §3a  | `2d26c882c83` | landed  | marker shape pinned (dedicated `session_resume_epoch` table)                                                                       |
| CS-2 | `7e4d69ba170` | landed  | marker CRUD 4/4, migration 2/2, doctor 15/15, phase-1 CAS 10/10, oxlint clean; trigger seeds new sessions                          |
| CS-3 | `4619864a0fb` | landed  | reconcile+drainTailForResume 8/8, recovery 160/160, Phase-0 pin 3/3 (unflipped), doctor 15/15; timeout fallthrough deleted         |
| CS-4 | `f6046d322e8` | landed  | T2 4/4, Phase-0 pin 3/3 (flipped for state c), reader 31/31, doctor 15/15, oxlint clean                                            |
| CS-5 | `feadda719ed` | landed  | fallback 7/7, reader 31/31, doctor 15/15, oxlint clean (session-history.ts max-lines 865→720, still over 700 — recorded follow-up) |
| CS-6 | —             | pending | Phase-4 wall consolidation + #24 seam doc                                                                                          |

**Deviations from spec, accepted:**

- **CS-4 keyless-session skip.** Fable's Decision 3 said absent-row = throw invariant-violation. CS-4 scopes that to sessions _with_ a `session_key`: `session_resume_epoch` is keyed by `session_key`, so a keyless (ephemeral/isolated) run cannot hold a marker row and skips the check. The resume path always carries a keyed main session, so no drain-pending resume is ever skipped. Correction, not drift.
- **CS-3 epoch increment.** Implementer prose said `current?.epoch ?? 0 + 1` (a precedence bug), but the committed code is `(current?.epoch ?? 0) + 1` — correct and monotonic. Verified against the tree.

**Open seams still owned by issue #38** (not resolved by CS-1..CS-5): items 1–6 in the issue — the marker/transcript key gap (§II.1), `drain_pending` never written in production, restart-scan dispatch derivation, lazy-stub epoch seeding, cross-window duplication, and the smaller unowned items. These gate the Phase 4.5 green-light decision, not CS-6.

## §9 Phase-4 wall (CS-6, landed)

The permanent Phase-4 wall. Run these together to gate any change to the resumption-ordering mechanism:

| Test (§5 mapping)                 | File                                                                         |
| --------------------------------- | ---------------------------------------------------------------------------- |
| T1 — drain-before-dispatch order  | `src/agents/cli-transcript-reconcile.test.ts` (drain+marker one txn, atomic) |
| T1 — restart re-dispatch scan     | `src/agents/main-session-recovery/main-session-restart-recovery.test.ts`     |
| T2 — reader refuses drain-pending | `src/agents/cli-runner/session-history.resume-drain-pending.test.ts`         |
| T3 — deletion safety / fallback   | `src/agents/cli-runner/session-history.sqlite-projection-fallback.test.ts`   |
| Pin flip (three-state reseed)     | `src/agents/cli-runner/prepare-reseed-caller.phase0.test.ts`                 |
| Marker CRUD + backfill            | `src/config/sessions/session-accessor.sqlite-resume-epoch-store.test.ts`     |
| Reader regression suite           | `src/agents/cli-runner/session-history.test.ts`                              |
| Doctor tripwire (cross-phase)     | `src/commands/doctor-session-canonical-keys.test.ts`                         |

The **#24 seam** (§6) is exported from `src/config/sessions/session-accessor.ts`: `readSessionResumeEpoch` / `writeSessionResumeEpoch` / `SessionResumeEpochState` / `SessionResumeEpochRow` (marker + committed state) and `SessionResumeDrainPendingError` / `isSessionResumeDrainPendingError` (typed retryable refusal). The store module doc-comment (`session-accessor.sqlite-resume-epoch-store.ts`) carries the contract prose. #24 reads resumption durability from the committed `state`, never from row heuristics.
