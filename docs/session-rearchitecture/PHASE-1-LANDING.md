# Phase 1 — Landing sweep (CS-5)

Landing accounting for the Phase 1 PR body. Revision-CAS + typed conflict.
All numbers measured on branch `rearch/session-store` vs `origin/main`.

## Gate evidence (all independently re-run)

| Gate                      | Command target                                                                                                                                      | Result                                              |
| ------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------- |
| state / DB                | `vitest.unit-src` · `openclaw-agent-db.test.ts` + `openclaw-corruption-fallback.phase1.test.ts` + `openclaw-database-verify.test.ts`                | 129 passed, 6 skipped, 0 failed                     |
| session conformance + CAS | `vitest.runtime-config` · `session-accessor.conformance.test.ts` + `session-cas-lifecycle.phase1.test.ts` + `session-cas-projection.phase1.test.ts` | 55 passed, 0 failed                                 |
| T-A3a wall pin            | `vitest.gateway` · `sessions-patch.phase0.test.ts`                                                                                                  | 3 passed — **agentStatus clobber STILL red-pinned** |

## §9 wall matrix — holds exactly

| Wall test                                                | Required state                                                             | Actual                                                                         |
| -------------------------------------------------------- | -------------------------------------------------------------------------- | ------------------------------------------------------------------------------ |
| T-A3a (agentStatus clobber, `sessions-patch.ts:397-399`) | **RED-PINNED — still clobbers** (fixed only by Phase 5 read-receipt split) | ✅ green test asserts `agentStatus` IS cleared → clobber intact, no scope leak |

**Scope-leak check:** if a Phase 1 CAS conversion had stopped the clobber, T-A3a flips → §9 reject.
It did not. Phase 1 changed _how patch CAS-compares_, not _what fields it writes_. Pin holds.

## Net-LOC success metric — met

`src/config/sessions/` excluding tests, `origin/main..HEAD`:

```
added=3064  deleted=4892  net=-1828
```

**Net −1828 LOC.** The revision-CAS primitive replaced the compensator sprawl (4 conflict-error
classes + ~24 bare-throw sites + 3 ad-hoc entry comparators + value-compare projection reads) with
one atomic `WHERE key AND revision` compare + bump, one `SessionConflictError`, one `withSessionRetry`.

## Deletion-table accounting (rows 1 / 6 / 7)

| Row | Item                                                          | Disposition this phase                                                                                                                |
| --- | ------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | `sqliteSessionEntriesEqual` value-compare on primary CAS path | Flag-gated fallback branch is its only remaining caller; full delete at flag removal (§7).                                            |
| 6   | Participant strip/re-add round trip                           | Deleted from the new path; strip logic survives only inside the flag's fallback branch.                                               |
| 7   | Ponytail #5's 3 entry comparators                             | The 2 pure-CAS comparators die with the compare change; any non-CAS comparator (skip-no-op-write) left in place, noted for Phase 2/3. |

## Flag-removal ticket (§7) — TO FILE ON THE FORK

**Title:** Remove `OPENCLAW_SESSION_CAS_VALUE_COMPARE` legacy value-compare fallback

**Body:**

> Phase 1 (revision-CAS) shipped with the legacy value-compare path kept behind
> `OPENCLAW_SESSION_CAS_VALUE_COMPARE=1` for one release of soak. Default is revision-CAS (flag off).
>
> After one release with no revision-CAS conflict regressions in the field, remove:
>
> - the flag read (`sessionCasValueCompareEnabled()`) and every `if (flag)` fallback branch
> - the remaining `sqliteSessionEntriesEqual` caller (deletion-table row 1 completes)
> - the participant strip/re-add logic inside the fallback branch (row 6 completes)
> - the flag-on parametrized cases in `session-cas-*.phase1.test.ts`
>
> Gate on removal: `session-cas-conflict-contract.phase1.test.ts` + conformance suite green flag-off;
> net-LOC in `src/config/sessions/` drops further negative.
>
> Blocked-until: one tagged release of `rearch/session-store` merged + soaked.

## Boundary held (constraint 2)

CAS stopped _reading_ projections/entry values. The 24 projected `session_nodes` columns + ~10
`session_windows` columns are still _written_ every write, same transaction, byte-identical to today.
Divergence check, `entry_valid` triggers, parsers, projection pipeline — untouched. Reserved for
Phases 2–3. No diff hunk touched a projection-write or parser path.
