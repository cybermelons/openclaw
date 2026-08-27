# Phase 0.5 — Mechanical Warm-Up Shrinks (#18-only)

Author: Fable (design). Executor: Opus. Implementers: Sonnet.
Status: FINAL. Branch: `rearch/session-store`, on top of landed Phase 0 wall (33 tests green).

**Contract:** four independent mechanical extractions/deletions. ZERO behavior change —
each argued byte- or call-graph-equivalent, proven by keeping the entire existing
session-subsystem vitest suite + the Phase 0 wall green with NO test edits. Success metric:
net-negative LOC in `src/config/sessions/`. No schema change, no new columns, no semantic change.

**Standing context (record in PR body):** T-WS PASSED in Phase 0 — subagent write-side
attribution is correct (events land under `childSessionKey`); #24 write-side Phase 4 cancelled.
Confirms item #7's `parentSessionKey ?? spawnedBy` collapse is NOT masking a write-side bug.

**CS-4 verdict from Phase 0 = (a) missing guard (latent bug), tracked as fork #27.**
Therefore the conditional "fifth delete commit" for `isSqliteTranscriptTarget` does NOT apply —
it stays a fix ticket, untouched in Phase 0.5.

---

## Item #2 — kill `parseSessionEntryRow` alias of `parseSessionEntryJson`
One function, two names. Re-exported as `parseSessionEntryRow` in 3 files; 26 call sites across
both names, 8 files (ponytail #2). Rename every `parseSessionEntryRow` call site + import to
`parseSessionEntryJson`; delete the 3 alias declarations. No signature/body change.
Zero-behavior: alias is a re-export of the identical function object → referentially transparent.
LOC: ≈ −3 to −10. Gate: full session suite green (emphasis: entry-parse/projection suites,
canonical-inventory read-back, all 33 Phase 0 tests incl. `parent-spawned-by-readback`);
oxlint clean on 8 files; zero test edits.

## Item #4 — extract `buildSessionParticipantUpsert()`
`session_participants` conflict-merge (source merge, min/max prompted-at) duplicated byte-identically
at 2 sites + a near-twin third (ponytail #4). Extract one helper; 2 identical sites call it verbatim.
**Near-twin rule:** diff site 3 against the body — fold ONLY if delta is a parameter with identical
value flow; if semantic, LEAVE site 3 untouched + note in PR. Do NOT harmonize (harmonization =
behavior change = out of scope). LOC: ≈ −25 to −45 (−10 to −25 if site 3 stays).
Gate: participant vitest suites green (incl. Phase 0 T-A3b interleave pins — must not move);
full session suite; oxlint.

## Item #6 — extract `upsertSessionConversationLink()`
`session_conversations` onConflict/doUpdateSet tuple repeated 3× incl. canonical-repair (ponytail #6).
Extract one helper, call from all 3. Same near-twin rule as #4. **Canonical-repair caution:** it is
Doctor-only cross-store transfer — helper takes the DB handle as a PARAMETER, never captures one;
must not change which store/connection the statement runs against. LOC: ≈ −15 to −30.
Gate: full session suite incl. any canonical-repair/doctor-flow tests; oxlint.

## Item #7 — unify `parent_session_key`/`spawned_by` fallback in `bindSessionNode`
`bindSessionNode` spreads the window projection then overrides `parent_session_key`/`spawned_by`
with a different fallback — same fact computed twice in one object literal (ponytail #7;
collapse site `session-accessor.sqlite-session-row.ts:104-106`). Compute the fallback ONCE, use it
for both spread source and override — delete one computation. Stored value bit-identical to main.
**HARD GATE — T-SH fence:** `parent-spawned-by-readback.phase0.test.ts` MUST stay GREEN, UNMODIFIED.
It pins: `parentSessionKey==spawnedBy` child reads back with `parentSessionKey` ABSENT, `spawnedBy`
present; unequal reads back with BOTH. #7 does NOT add a column, NOT change the collapse rule, NOT
alter read-back at `session-accessor.sqlite-canonical-inventory.ts:84-87`. **If T-SH goes red under
any draft of #7, the draft is wrong — revert the draft, never touch the test.** Only #24, in its own
later PR, may flip T-SH (visible marker of seam-ownership transfer). LOC: ≈ −2 to −6.
Gate: T-SH green + unmodified (hard), full session suite, canonical-inventory read-back, oxlint.

---

## Ordering & dispatch
Logical dependencies among #2/#4/#6/#7: NONE — fully independent extractions.
Practical file overlap (#2's sweep may touch accessor files #4/#6/#7 edit) → run as SEQUENTIAL
commits, not parallel worktrees. Parallelism buys nothing at this size, risks merge conflicts.

- **One PR** ("Phase 0.5 warm-up shrinks"), **four commits, one per item**.
- **Two Sonnet changesets:** CS-A = item #2 (pure rename sweep, 8 files); CS-B = #4 + #6 + #7
  (accessor-layer extractions, adjacent, one Sonnet keeps near-twin judgment consistent).
  Order CS-A then CS-B (or reverse if #2's sweep would rename lines CS-B moves — Opus decides
  from the actual diff; no correctness stake).
- **Per-commit gate:** full session-subsystem vitest green (zero test edits), Phase 0 wall green
  (all 33; T-SH explicit for #7), oxlint clean on touched files.
- **PR-level gate:** net LOC delta in `src/config/sessions/` NEGATIVE (expected ≈ −45 to −85);
  report exact figure. Record: T-WS-passed context; any near-twin left in place at #4/#6 with reason.

## OUT of scope
No `revision` column / `SessionConflictError` / retry helper (Phase 1). No projection-pipeline
consolidation, no parser unification beyond the pure alias kill (the `parseSessionEntryJson` vs
`parseReadableSqliteSessionEntryRow` two-parser split stays → Phase 2 / ponytail #3). No comparator
work (ponytail #5, Phase 1). No semantic change to `parent_session_key` storage/read-back (#24's
additive change is later; T-SH is its tripwire). No fixes to any PINNED-BUG test; no test edits.
No harmonizing near-twins. No `isSqliteTranscriptTarget` deletion (verdict was (a) → #27 fix ticket).
