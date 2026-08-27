# Phase 2 — Projection Consolidation (#18)

Author: Fable (design, planned + one adversarial revision pass — §14; the table in §11 already contains the revisions). Executor: Opus. Implementers: Sonnet.
Branch: `rearch/session-store`, worktree `/home/kiri/.openclaw/worktrees/rearch-session-store`.
Status: FINAL. On top of landed Phase 0 wall (33 tests green), Phase 0.5 shrinks, and Phase 1 (revision CAS + `SessionConflictError` + corruption marker, all gates green).
Source authority: `PLAN.md` P3 (:57-62), Phase 2 (:130-131), stolen patterns 3-4 (:87-90), deletion table (:95-108);
`PONYTAIL-AUDIT.md` #3 (inline re-assembly, 6 files) and #2 (parser split remainder);
`CORRUPTION-FALLBACK.md` Item 4 (row quarantine) + Item 7 ownership table;
`PHASE-0.5.md` (alias kill landed, commit `a9969b71a51` — Phase 2 clears the remainder only);
`PHASE-0.md` (the wall); `PHASE-1.md` §9 (wall matrix format this doc restates).

**One sentence:** exactly one parser and exactly one projection pipeline produce the one canonical
session-entry shape everywhere; `participants` is always present (`[]` when none); the remaining
parser split and every inline re-assembly site are deleted; an unparseable `entry_json` blob throws
typed `SessionRowCorruptError` and quarantines that one row instead of returning silent `null`; a
lint fence makes regression impossible to merge. Safe now because Phase 1 moved every CAS compare to
the integer `revision` — no concurrency decision reads projected values anymore, so consolidating
how projections are re-assembled cannot change any conflict outcome.

---

## 1. Goal, and why this is safe now

Goal: collapse five distinct entry shapes to one, two parsers to one, and 6 files of hand
re-assembly to one pipeline, with a typed corruption contract and a fence.

Why safe now (the Phase 1 dependency, stated precisely): before Phase 1, CAS compared projected
entry _values_ (`sqliteSessionEntriesEqual`, `JSON.stringify`-based). Any change to how a
projection was assembled — field order, participant inclusion, shape subset — could flip a CAS
compare and change concurrency behavior. Phase 1 replaced every entry-CAS compare with
`WHERE key AND revision = :expected`. The compare is projection-agnostic. Phase 2 can therefore
rewrite the entire read/re-assembly side with **zero possible effect on any CAS outcome**. This is
the PLAN.md order rationale (":1 before 2 — CAS must stop caring about projections before
projections move") now cashed in.

What Phase 2 is NOT (full statement in §10 and §12): Phase 2 changes how projected data is
**read and re-assembled**. It does not change what is **written**. The 24 projected columns on
`session_nodes` and the ~10 duplicated columns on `session_windows` are still written on every
write, in the same transaction, byte-identical to today. Column demotion is Phase 3.

---

## 2. The defect this kills

- **Two parsers for one column** (PLAN.md:26): `parseSessionEntryJson` (participant-less,
  silent-`null` on failure) vs `parseReadableSqliteSessionEntryRow` (participant-full, throwing).
  Phase 0.5 killed the _alias_ of the first (`parseSessionEntryRow`, commit `a9969b71a51`, 8
  files); the two-parser _split_ itself is the ponytail #2 remainder and dies here.
- **Silent-`null` corruption swallowing**: the participant-less parser returns `null` for an
  unparseable blob. Callers cannot distinguish "row absent" from "row corrupt." A corrupt row is
  invisible until something downstream faults — the exact pre-condition for a resume crash-loop
  (`HARNESS-RESEARCH` #32160 class).
- **Inline re-assembly drift** (ponytail #3, 6 files): the shape→owner→participants chain is
  centralized in 2 named functions, then rebuilt inline with inconsistent subsets at 5+ more sites
  — the cache does owner+participants inline; inventory/canonical-key do shape-only. Five distinct
  entry shapes exist counting the cache and list projections. Every new reader picks one at random;
  every shape fix must be applied N times and is applied fewer.
- **Absent≠empty participants bug**: some shapes omit `participants`, some carry `[]`, consumers
  branch differently on the two. One invariant (`participants` always present, `[]` when none)
  deletes the bug class.

---

## 3. One parser — `parseSessionEntryBlob`

One function parses `entry_json`. Its core contract is a **discriminated result, not a throw**
(adversarial Delta A, §14 — the throw lives at the pipeline boundary, §4):

```ts
type SessionEntryParseResult =
  { ok: true; entry: CanonicalSessionEntryShape } | { ok: false; corrupt: SessionRowCorruptError };
```

- **Input is the blob alone.** The parser receives `entry_json` (plus the row key for error
  identity) and nothing else — no sibling row, no second query, no cross-row reference. This is
  the structural half of the self-contained-record requirement (§8, T-P2b): a blob is judgable
  ALONE, by construction, because the parser has nothing else to consult.
- **Absent vs corrupt are different facts.** Row not found → the accessor returns
  `null`/`undefined` exactly as today, before the parser is ever called. Row found but blob
  unparseable → `{ ok: false }`. The old silent-`null`-on-corrupt conflation is deleted; no path
  may map corrupt to `null`.
- **Deletions:** `parseReadableSqliteSessionEntryRow` and `parseSessionEntryJson` both die; every
  call site of either (and any Phase-0.5-missed alias remainder — sweep by grep for both names plus
  `parseSessionEntryRow`, repo-wide, expect zero survivors outside the new module) routes through
  the one parser or through the pipeline (§4). Per-call `tableHasColumn` feature detection inside
  parse paths resolves once at DB open (PLAN.md:60) — the _detection point_ moves; the columns
  detected and the shapes produced for pre-feature databases stay byte-identical.
- **Interim compatibility rule (Delta A):** between CS-3 (parser lands) and CS-4 (pipeline collapse
  lands), surviving direct callers map `{ ok: false }` to their **current** behavior explicitly at
  the call site, each marked `// PHASE2-INTERIM: removed in CS-4`. CS-4's gate greps this marker to
  zero. No caller changes observable behavior in CS-3.

---

## 4. One pipeline — `projectSessionEntry(row, satellites)`

Exactly one function assembles the canonical shape: **shape → owner → participants, always all
three** (PLAN.md:58).

- **Signature:** `projectSessionEntry(row, satellites) → CanonicalSessionEntryShape`. It calls the
  one parser; on `{ ok: false }` it quarantines the row (§6) and throws the `SessionRowCorruptError`
  — the pipeline boundary is the ONLY place the corrupt result becomes a throw.
- **The 2 existing named functions** become internal stages of (or are replaced by) this one entry
  point; the **5+ inline re-assembly sites** (ponytail #3 — cache, inventory, canonical-key, list
  projections) are deleted and call the pipeline. Sites that consumed a subset (shape-only) receive
  the canonical shape and read the fields they need — a superset is compatible; producing a subset
  is what dies.
- **Read-source preservation rule (boundary, §10):** the pipeline reads from exactly the same
  sources the 2 named functions read from today. If a today-site reads a projected column, the
  pipeline stage for that site's data reads the same projected column. **No read moves from a
  projected column to the blob (or the reverse) in Phase 2** — the reader audit and blob-routing
  is Phase 3. Phase 2 consolidates _where the assembly code lives_, not _which storage it reads_.
- **Cache canonicalization:** the cache layer's fifth shape is deleted; the cache stores the
  canonical shape (PLAN.md:60). Cache entries are keyed `(sessionKey, revision)`. A read that
  would serve a cached projection first reads the row's current `revision` (one integer read); a
  stale-revision hit discards and re-projects. This is what makes the zero-cache discipline test
  (§8, T-P2a) pass by construction: no projected entry can survive a write, therefore none can
  survive a turn boundary in stale form. Revision is Phase 1 truth, not a projection — validating
  against it does not violate the §10 boundary.

---

## 5. Participants-always-present invariant

- The canonical shape declares `participants` as a required array. `participants: []` when none.
  No optional, no `undefined`, no omission in any serialization the pipeline produces.
- Consumers that branched on absence are rewritten to branch on `length === 0`. This is the one
  **sanctioned observable change** of Phase 2 (PLAN.md:58 "absent≠empty bug dies"). Sonnet lists
  every consumer whose branch changes in the PR body.
- **T-SH fence:** the invariant governs `participants` ONLY. The `parentSessionKey`/`spawnedBy`
  absent-vs-present read-back contract pinned by T-SH is untouched; if any draft flips T-SH, the
  draft is wrong — revert the draft, never the test (PHASE-0.5.md rule restated).

---

## 6. `SessionRowCorruptError` + row quarantine (CORRUPTION-FALLBACK Item 4, Phase 2 slice)

```ts
class SessionRowCorruptError extends Error {
  readonly key: string; // session key of the corrupt row
  readonly reason: string; // failing parse step
  readonly blobExcerpt: string; // bounded prefix for forensics; never the full blob in the message
  readonly retryable = false as const;
}
```

- One file in the sessions module, sibling of `SessionConflictError`. `instanceof`-checkable.
  `retryable: false` — `withSessionRetry` must NOT retry it (a corrupt blob does not heal).
- **Row quarantine:** on `{ ok: false }` the pipeline writes a row-level corrupt marker into the
  **existing** Phase 1 quarantine ledger (`readOpenClawDatabaseQuarantine` /
  `clearOpenClawDatabaseQuarantine` — extend the key space to `sessionKey`, no parallel store),
  then throws. One poison row never fails the whole store: list/inventory paths catch
  `SessionRowCorruptError` per-row, skip the row, and continue; single-row paths propagate it.
- **Skip-resume:** the Phase 1 skip guards at `markStartupOrphanedMainSessionsForRecovery`
  (`server-startup-post-attach.ts:634`) and `scheduleRestartAbortedMainSessionRecovery` (`:1452`)
  already consult the ledger; they now also honor row-level markers — a row-quarantined session is
  never re-resumed. Marker clearing keeps Phase 1 semantics: operator (doctor) or verified restore
  only; never auto-cleared. Structured log line on every quarantine and every skip (consolidated
  doctor view stays Phase 6).
- **T-A2 stays green:** this adds consultations _inside_ `:634`/`:1452` exactly as Phase 1's
  DB-level guard did; the 4-step startup order is not reordered (CORRUPTION-FALLBACK Item 6).

---

## 7. Lint fence

Two mechanical gates, both wired into the standard lint/test run so violation fails CI, not review:

1. **Import fence:** only the accessor module (the pipeline/parser file set, enumerated in an
   allow-list checked into the fence config) may import `parseSessionEntryBlob`; only
   `src/config/sessions/` accessor files may contain SQL that names `session_nodes` /
   `session_windows` / `session_participants` (PLAN.md:61). Implement with the repo's existing
   oxlint custom-rule mechanism if one exists; otherwise a vitest static test that greps the
   fingerprints (`from ".../session-entry-parse"`, table names in template SQL) against the
   allow-list. No new lint framework.
2. **Re-assembly fence:** the assembly fingerprints (the owner-merge expression, the
   participants-attach expression — Sonnet extracts the 2-3 stable fingerprints from the deleted
   inline sites) may appear only inside the pipeline file. A new inline re-assembly cannot merge.

The fence lands LAST (§11 ordering) — raising it before the collapse completes fails on the very
sites Phase 2 deletes. Allow-list starts empty of exceptions; every entry added later requires a
comment naming the phase that removes it.

---

## 8. New Phase 2 test wall (green-by-design)

- **T-P2a (zero-cache discipline — Aider pattern, PLAN.md stolen pattern 3):** connection A
  performs a turn-boundary read of a session (canonical read path, cache warm); connection B
  commits an entry patch (revision bumps); A performs its next turn-boundary read. Assert A
  observes B's data and the new revision — no stale projection served across the boundary. Second
  case: same-turn repeated read MAY serve cache (assert no requirement either way — the test pins
  cross-turn freshness only). Third case: sweep the module for any other cache/memo of a projected
  entry (grep `Map<`/`cache` fingerprints in scope, list in PR body); each found is either
  revision-keyed (§4), turn-scoped, or deleted. **This is the discipline test that proves the
  consolidation killed every stale-read path.**
- **T-P2b (self-contained record — Codex pattern, PLAN.md stolen pattern 4):** write a fixture row
  with a structurally-valid DB but garbage `entry_json`. Assert: (i) the parser judges it corrupt
  **with no other row present in the table** (drop all sibling rows first — proves no cross-row
  reference); (ii) the pipeline throws `SessionRowCorruptError` with correct `key`; (iii) the row
  is marker-ledger-quarantined; (iv) a boot-shaped drive of `:634`/`:1452` skips exactly that
  session and resumes a healthy sibling; (v) second boot: still skipped (sticky); (vi) a list-path
  read returns the healthy rows and omits the corrupt one without throwing.
- **T-P2c (participants invariant, property):** for arbitrary generated rows and satellite sets
  (including zero participants), every pipeline output has `participants` present as an array;
  `[]` iff no satellite rows. Serialize/deserialize round-trip preserves presence.
- **T-P2d (one-shape equivalence):** for a corpus of representative rows (all `entry_valid`
  states, pre-feature-column fixtures, participant-full and participant-empty), the pipeline
  output field-for-field equals what each of the 2 named functions produced pre-Phase-2 on that
  site's field subset (recorded as fixtures BEFORE the collapse, in CS-2). This is the
  characterization harness for the collapse itself.
- **T-P2e (fence):** the lint fence fails on a synthetic violation (test adds a fixture file with
  an out-of-fence parser import / inline re-assembly fingerprint and asserts the fence reports it),
  and passes on the real tree.
- **T-P2f (no-retry on corrupt):** `withSessionRetry` rethrows `SessionRowCorruptError` on attempt
  1 without retrying (`retryable: false` honored).

---

## 9. Wall-preservation matrix (restated in full)

The complete Phase 0 wall (33 tests) plus the Phase 1 wall (T-P1a–T-P1f) runs on every changeset.

| Test                              | Post-Phase-2                          | Why                                                                                                                                                                                                                                                                                                                                                               |
| --------------------------------- | ------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| T-A1a/b/c (drain ×3)              | **green, unchanged**                  | drains untouched (Phase 6)                                                                                                                                                                                                                                                                                                                                        |
| T-A2 (startup ordering)           | **green, unchanged**                  | row-marker consultation is inside `:634`/`:1452`, same mechanism Phase 1 used; 4-step order not reordered                                                                                                                                                                                                                                                         |
| T-A3a (agentStatus clobber)       | **RED-PINNED — still clobbers**       | the clobber is the read-receipt blind-write path (`sessions-patch.ts:397-399`), fixed only by Phase 5's read-receipt split. Phase 2 changes how entries are _read and re-assembled_, not what the patch path _writes_. **If any Phase 2 change flips T-A3a green, Phase 2 leaked into Phase 5 — reject the change, keep the pin.** `// PINNED-BUG: Phase 5` stays |
| T-A3b (participant interleave)    | **green** (pinned outcomes unchanged) | participants stay fire-and-forget with no concurrency control; Phase 2 changes their _presence in the read shape_, not their write behavior                                                                                                                                                                                                                       |
| T-A3c (maintenance vs admission)  | **green, unchanged**                  | admission untouched                                                                                                                                                                                                                                                                                                                                               |
| T-A4 (reseed, 3 cases)            | **green, unchanged**                  | resumption ordering is Phase 4; the sleep-retry at `session-history.ts:499-562` is NOT touched                                                                                                                                                                                                                                                                    |
| T-WS (subagent attribution)       | **as Phase 0 recorded**               | #24, untouched                                                                                                                                                                                                                                                                                                                                                    |
| T-SH (parent/spawnedBy read-back) | **green, unmodified — hard gate**     | §5 fence: participants invariant must not disturb `parentSessionKey` absent-vs-present read-back; only #24 may flip T-SH                                                                                                                                                                                                                                          |
| T-P1a–T-P1f (Phase 1 wall)        | **green, unchanged**                  | revision CAS untouched; pipeline never enters a compare                                                                                                                                                                                                                                                                                                           |

Gate rule per changeset: full combined wall runs; any deviation from this matrix fails the gate.

---

## 10. Boundary constraint — columns still written, not demoted

Restated as a hard line because it is the likeliest leak:

- The 24 projected columns on `session_nodes` and the ~10 duplicated columns on
  `session_windows` are **still written on every write, in the same transaction, byte-identical to
  today**. Phase 2 touches zero write-side projection code.
- The 2-of-24 silent-`null` divergence check (`session-entry-json.ts:26-31`) **stays**.
- The `entry_valid` triggers and compensating UPDATEs **stay**.
- No read moves between a projected column and the blob in either direction (§4 read-source
  preservation rule).
- **Any diff hunk in a projection-write path, divergence check, `entry_valid` trigger, or
  `session_windows` schema is Phase 3 scope leak → reject on sight.**

---

## 11. Dispatch (Opus → Sonnet) — table reflects the §14 adversarial revisions

Order: pure additions first → characterization fixtures → parser → pipeline collapse → fence → landing.

| CS       | Contents                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   | Depends    | Gate                                                                                                                                                                                                                    |
| -------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ---------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **CS-1** | `SessionRowCorruptError` type + row-level key space in the quarantine ledger API + `withSessionRetry` non-retry behavior; T-P2f. Pure additions, zero call-site changes; ledger extension unused until CS-4.                                                                                                                                                                                                                                                                                                                                                                                                                                                                               | —          | T-P2f green; full combined wall green; oxlint                                                                                                                                                                           |
| **CS-2** | **Equivalence fixtures (Delta B):** record the pre-collapse outputs of the 2 named projection functions across the T-P2d corpus (all `entry_valid` states, pre-feature fixtures, participant variants) as checked-in fixtures. Zero production changes.                                                                                                                                                                                                                                                                                                                                                                                                                                    | —          | fixtures generated against the pre-CS-3 tree and committed; full wall green                                                                                                                                             |
| **CS-3** | **One parser.** `parseSessionEntryBlob` with the Result contract (§3); both old parsers deleted; every direct caller routed, `{ ok: false }` mapped to current behavior with `// PHASE2-INTERIM` markers; alias-remainder grep to zero; `tableHasColumn` detection moved to DB-open with byte-identical shape output.                                                                                                                                                                                                                                                                                                                                                                      | CS-1, CS-2 | repo-wide grep for both old parser names = zero outside the new module; T-P2d subset (parser stage) green against CS-2 fixtures; full wall green — **T-A3a red, T-SH green unmodified**; oxlint                         |
| **CS-4** | **The core: pipeline collapse.** `projectSessionEntry(row, satellites)`; 2 named functions absorbed; 5+ inline sites (ponytail #3, 6 files) deleted and routed; corrupt→quarantine→throw at the pipeline boundary; skip-resume row-marker consultation at `:634`/`:1452`; cache stores canonical shape keyed `(key, revision)` with revision validation; participants-always-present invariant + consumer branch rewrites (listed in PR body); `PHASE2-INTERIM` markers removed to zero. T-P2a/b/c/d. Opus may split 4a (pipeline + named-function absorption) / 4b (inline-site sweep + cache) / 4c (quarantine + skip guard) if the diff exceeds review appetite, landing in that order. | CS-3       | T-P2a/b/c/d green; `PHASE2-INTERIM` grep = zero; ponytail #3 fingerprint grep = pipeline file only; full wall matrix §9 holds exactly — **T-A3a still red-pinned, T-A2 unchanged, T-SH unmodified**; oxlint; full suite |
| **CS-5** | **Lint fence** (§7): import fence + re-assembly fence + allow-list; T-P2e.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 | CS-4       | T-P2e green (fails on synthetic violation, passes on tree); fence wired into standard CI lint/test run; full wall green                                                                                                 |
| **CS-6** | Landing sweep: deletion accounting (both parsers, 5 inline sites, fifth cache shape) vs PLAN.md deletion-table row "one of two parsers + aliases + cache's fifth shape"; net LOC delta in the projection paths (excl. new tests) reported and net-negative-or-flat; §9 wall matrix + consumer-branch list + cache-sweep list pasted in PR body with per-test evidence; one Phase 2 PR on the fork.                                                                                                                                                                                                                                                                                         | CS-5       | all above green; LOC figure recorded; one PR                                                                                                                                                                            |

CS-1 ∥ CS-2. Everything after is sequential (same accessor files — PHASE-0.5.md's
sequential-commits rule applies; parallel worktrees buy nothing at this size).

**Acceptance-test mapping (PLAN.md requirement):** zero-cache discipline (stolen pattern 3) =
**T-P2a, lands and gates in CS-4**. Self-contained record (stolen pattern 4) = **T-P2b, lands and
gates in CS-4** (the structural half — parser sees the blob alone — is enforced from CS-3 by the
parser signature).

---

## 12. Out of scope — reject on sight

- **No column demotion** (Phase 3): no reader audit, no read moved between projected column and
  blob, no divergence-check deletion, no `entry_valid` trigger removal, no `session_windows`
  column shrink, no schema migration of any kind. Projected columns still written everywhere,
  same transaction (§10).
- **No resumption ordering** (Phase 4): no `resume_epoch`, no drain-before-dispatch; the
  sleep-retry at `session-history.ts:499-562` stays exactly as is, even though the new pipeline
  sits near it — named here so nobody "cleans it up in passing."
- **No satellite contracts** (Phase 5): no read-receipt split, no participant write API, no
  revision on any satellite, no blind-write→CAS conversion. **The agentStatus clobber
  (`sessions-patch.ts:397-399`) stays; T-A3a stays red-pinned** (§9).
- **No process-seam work** (Phase 6): no startup phase machine, no drain budget tree, no
  admission DB leases, no consolidated doctor view (structured log lines only).
- **No Phase 1 flag removal**: `OPENCLAW_SESSION_CAS_VALUE_COMPARE` and its value-compare branch
  are owned by the Phase 1 flag-removal ticket, not this phase — even though the branch touches
  entry shapes.
- **No harmonizing** of near-twin logic beyond the enumerated sites; no fixes to any PINNED-BUG
  test; no edits to any Phase 0/Phase 1 wall test.

---

## 13. Success metric

- **One parser**: repo-wide grep finds exactly one entry-blob parse implementation; both old names
  gone.
- **One pipeline**: assembly fingerprints exist only in the pipeline file (fence-verified).
- **Participants-present invariant** enforced by type + T-P2c property test.
- **Lint fence active** in CI (T-P2e).
- **Corruption contract**: corrupt blob → `SessionRowCorruptError` + row quarantine + skip-resume,
  never silent `null`, never a whole-store failure, never a crash loop (T-P2b).
- **Zero-cache discipline** proven (T-P2a).
- **Net-negative or net-flat LOC** in the projection paths (parser + pipeline + cache + inline
  sites; excl. new tests) — exact figure in the PR body.
- **All gates green**: full Phase 0 wall (33) + Phase 1 wall + Phase 2 wall, with T-A3a red-pinned
  and T-SH unmodified.

---

## 14. Adversarial revision pass (findings already folded into §3/§11)

**Delta A — the silent-null→throw ordering hazard (found, table revised).** First draft had the
unified parser THROW `SessionRowCorruptError` directly, landing before the pipeline collapse. Leak:
between "parser lands" and "pipeline lands," direct callers that today rely on silent `null` for a
corrupt blob would throw with no quarantine and no skip guard — a corrupt row would crash exactly
the paths CORRUPTION-FALLBACK exists to protect, in the middle of the phase. Revision: the parser
core returns a discriminated Result (§3); the throw + quarantine live only at the pipeline boundary
(CS-4); interim direct callers map `{ ok: false }` to current behavior under a grep-gated
`PHASE2-INTERIM` marker that CS-4 drives to zero. Behavior changes exactly once, atomically with
the quarantine machinery.

**Delta B — the collapse had no characterization harness (found, CS-2 added).** First draft
trusted the existing suite to catch shape drift during the inline-site collapse. But ponytail #3's
finding is precisely that sites produce _inconsistent subsets_ — the existing tests pin per-site
behavior thinly. Revision: CS-2 records pre-collapse outputs of the 2 named functions as fixtures
across the `entry_valid`/pre-feature/participant corpus; T-P2d gates CS-3 and CS-4 against them.
Cost: one small fixture changeset; buys field-for-field equivalence evidence for the riskiest diff.

**Riskiest CS — CS-4**, for three reasons: it touches 6 files of live read paths, it carries the
one sanctioned behavior change (participants presence), and it wires quarantine into the boot
path. Mitigations already in the table: the 4a/4b/4c split option, T-P2d equivalence gating, the
T-A2-unchanged and T-SH-unmodified hard gates, and §10's read-source preservation rule keeping it
out of Phase 3 territory.

**Scope-leak sweep of my own plan:** (i) cache revision-validation could tempt an implementer to
"also" read the blob instead of projected columns "since we re-project anyway" — forbidden by §4's
read-source rule; (ii) the quarantine skip guard sits two lines from Phase 5/6 territory in
`server-startup-post-attach.ts` — the gate pins T-A2 byte-order and forbids any edit outside the
two consultation points; (iii) participants-always-present could tempt a "while here" fix of the
participant upsert API — that is Phase 5, reject; (iv) the fence allow-list could quietly grow to
excuse leaks — every entry requires a phase-named removal comment (§7).

**Ordering hazard check:** fence after collapse (CS-5 after CS-4) — verified necessary, the fence
fails on the pre-collapse tree. Fixtures before parser (CS-2 before CS-3) — verified necessary,
fixtures must record the PRE-change tree. No other ordering freedom exists; the table stands.
