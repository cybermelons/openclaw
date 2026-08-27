# Phase 2 — Landing sweep (CS-6)

Landing accounting for the Phase 2 PR body. Projection consolidation:
one parser, one pipeline, row quarantine, lint fence.
All numbers measured on branch `rearch/session-store`.

## What Phase 2 did

Phase 1 made writes safe (revision-CAS). Phase 2 made the **read/projection** side
single-sourced:

- **One parser** — `parseSessionEntryBlob(key, row, participants?)` returns a
  discriminated `{ ok: true; entry } | { ok: false; corrupt: SessionRowCorruptError }`.
  The two old parsers (`parseSessionEntryJson` silent-null, `parseReadableSqliteSessionEntryRow`
  throw) are deleted.
- **One pipeline** — `projectSessionEntry(row, satellites)` assembles shape → owner →
  participants, always all three. It is the **only** place a corrupt parse becomes a throw.
- **Row quarantine** — a corrupt row is written to the CS-1 `quarantined_session_rows` ledger
  (schema 3→4, additive) and the boot guards (CS-4c) skip-resume it. One poison row never
  fails the whole store: multi-row paths catch per-row and skip; single-row paths propagate.
- **Lint fence** (CS-5) — import + SQL-table + re-assembly fences, bite-verified, CI-wired.

## Changeset ledger

| CS  | Commit        | Content                                                        |
| --- | ------------- | -------------------------------------------------------------- |
| 1   | `a13acafd1de` | `SessionRowCorruptError` + row-quarantine ledger table         |
| 2   | `f12135eb95c` | Projection equivalence baseline oracle (30 fixtures)           |
| 3   | `be0a7107689` | One `parseSessionEntryBlob`, Result contract; both old deleted |
| 4a  | —             | Consumer tolerance — **no-op**, tree already `?? []`-tolerant  |
| 4c  | `e9b126a9d88` | Boot guards honor row-level quarantine markers (reader-first)  |
| 4b  | `c05fb91bbc1` | `projectSessionEntry` pipeline + quarantine + cache + wrappers |
| 5   | `264547a7b07` | Projection lint fence (import + SQL + re-assembly)             |
| 6   | (this doc)    | Landing sweep                                                  |

Split rationale (Fable): 4a→4c→4b lands the marker **reader before the writer**, so a
quarantined row can never be re-resumed across the intermediate state; 4c reverts alone on a
boot regression; 4a carries the T-SH fence; 4b carries the oracle + T-A3a fence.

## Gate evidence (all independently re-run)

| Gate                        | Target                                                                                                      | Result                             |
| --------------------------- | ----------------------------------------------------------------------------------------------------------- | ---------------------------------- |
| CS-2 equivalence oracle     | `session-projection-equivalence.phase2.test.ts` (byte-identical output through new pipeline)                | 30 passed, expectations unchanged  |
| conformance + row-corrupt   | `session-accessor.conformance.test.ts` + `session-row-corrupt.phase2.test.ts` + `data-version`              | 96 passed (combined suite)         |
| pruning regression suites   | `cleanup-service.fix-missing` + `maintenance-vs-admission.phase0` + `cleanup-race` + `registry-maintenance` | 38 passed (was 13 failing pre-fix) |
| boot-guard row-marker skip  | `main-session-restart-recovery.test.ts`                                                                     | 159 passed                         |
| lint fence (bite-verified)  | `session-entry-parse-boundary.phase2.test.ts`                                                               | 6 passed                           |
| full `src/config/sessions/` | domain sweep, `vitest.runtime-config` (run in 4 shards — see note)                                          | 89 files / 961 tests, 0 failed     |
| T-A3a wall pin              | `sessions-patch.phase0.test.ts`                                                                             | 3 passed — **still red-pinned**    |
| T-SH read-back              | `parent-spawned-by-readback.phase0.test.ts`                                                                 | 2 passed — **unmodified**          |

> Sweep note: the full domain (89 files) is run in 4 file-group shards, not one invocation.
> The vitest runner's 120s no-output watchdog terminates a single whole-domain run (the DB-backed
> conformance/CAS suites run quietly for >2min) — a runner-harness limit, not a test failure.
> Sharded totals: 30/216 + 31/392 + 15/176 + 13/177 = **961 passed, 0 failed**.

## §9 wall matrix — holds

| Wall test | Required state                   | Actual                                                       |
| --------- | -------------------------------- | ------------------------------------------------------------ |
| T-A3a     | RED-PINNED (agentStatus clobber) | ✅ 3 passed, clobber intact — Phase 2 touched read side only |
| T-SH      | GREEN + file unmodified          | ✅ 2 passed, `git diff --stat` empty                         |

**Scope-leak check:** T-A3a is fixed only by the Phase 5 read-receipt split. If any Phase 2
changeset had stopped the clobber, T-A3a flips → reject. It did not.

## Sanctioned observable changes

Phase 2 has exactly **two** intended behavior changes, both spec-approved:

1. **Participants-always-present** (PLAN.md:58, §5). Every projected entry now carries
   `participants: []` when none, never an absent key. Former participant-less call sites now
   receive `participants: []`. Consumers were already emptiness-tolerant (CS-4a found zero
   absence-branches to rewrite), so no consumer breaks. `parentSessionKey`/`spawnedBy`
   absent-vs-present (T-SH) is untouched — the invariant governs `participants` only.
2. **Single-row corrupt → quarantine+throw** (§6). `session-accessor.sqlite-canonical-repair.ts`'s
   non-repair path now calls `recordOpenClawSessionRowQuarantine` before throwing (old
   `parseSessionEntryJson` returned null silently, never quarantined). The
   `allowMalformedRowRepair=true` fallback deliberately does **not** quarantine — it self-heals.

## Net-LOC accounting

Phase 2 is **net-additive**, by design — its job is consolidation, not deletion.

```
Phase 2 (7a87d9d2e3c..HEAD), src/config/sessions/ non-test:
  added=417  deleted=166  net=+251
```

The +251 buys: the pipeline + Result-typed parser, the quarantine writer wiring, the
revision-keyed cache freshness check, and the boot-guard row-marker readers — all genuinely new
machinery replacing scattered inline assembly. The **deletion** payoff is deferred to the Phase 1
flag-removal ticket (`OPENCLAW_SESSION_CAS_VALUE_COMPARE`), which drops the value-compare fallback,
the `sqliteSessionEntriesEqual` primary-path caller, and the participant strip/re-add round trip —
completing deletion-table rows 1/6/7. Consolidation now, deletion at flag removal.

## Read-source boundary held (constraint §10)

The pipeline reads from exactly the storage each old parser read (projected column vs blob). **No
read moved between a projected column and the blob** in Phase 2 — the reader audit and blob-routing
is Phase 3. Phase 2 moved _where the assembly code lives_, not _which storage it reads_. The CS-2
oracle staying green (byte-identical output) is the proof.

## Follow-ups filed (not this PR)

- **max-lines:** `src/config/sessions/session-accessor.sqlite-lifecycle-state.ts` is 777 lines vs
  the 700 `oxlint` cap (pre-existing, grew in CS-4b routing). Needs a behavior-neutral helper
  extraction — do not chase during the collapse.
- **flag removal:** `OPENCLAW_SESSION_CAS_VALUE_COMPARE` (from PHASE-1-LANDING §7) — blocked until
  one tagged release soaks; completes the Phase 2 deletion payoff.
