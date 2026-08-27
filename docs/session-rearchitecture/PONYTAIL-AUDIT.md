# Ponytail Audit — openclaw-src Session Subsystem

Date: 2026-08-26. Method: knip mechanical pass + 3 judgment scouts (dead systems, YAGNI, copy-drift), parallel, all findings call-site-verified. **Flags only — nothing applied.**
Scope: `src/config/sessions/` (73k LOC, ~180–240 files), session schema in `src/state/`, `src/agents/cli-runner/` recovery, gateway session methods.
Companion to: `tmp_plan-session-rearchitecture.md` (the re-architecture design). This audit measures that plan's cuts from the deletion side.

---

## Headline verdict

**Zero dead systems. Almost zero YAGNI. The bloat is not deletable code — it is the same live logic written N times.**

Every suspect module (legacy migrations, canonical-repair, eviction, doctor commands, archive worker) traced to a live import chain: startup hooks, doctor-health flow, or gateway methods. The 73k lines are load-bearing. That is the worst kind of big: you cannot cut it, only collapse it. This _strengthens_ the re-architecture case and kills the cheap alternative ("just delete dead code").

Knip: 528 unused files repo-wide, **zero** inside the session subsystem scope; only 3 unused exports total touch scope, all cosmetic. So dead weight in scope, if any, is reachable-but-pointless code — what the judgment scouts detect, not knip.

---

## SHRINK findings (extract one shared leaf — the real haul)

1. **CAS-conflict error taxonomy** — 4 unrelated conflict-error classes (`SqliteSessionMutationConflictError`, `SqliteTranscriptMutationConflictError`, `TranscriptTurnAdmissionConflictError`, `SessionWorkStartInvalidatedError`) plus ~20 raw `throw new Error("...changed before...")` sites across 14 files. No shared base — callers cannot `instanceof` a CAS conflict, only substring-match. → one `SqliteOptimisticConflictError` base with `kind` discriminant. **[~24 sites]** — this IS re-architecture principle P1's typed-error step.

2. **Parser naming split** — one function, two names: `parseSessionEntryJson` re-exported as `parseSessionEntryRow` in 3 files, 26 call sites split across both names. Fix one name's callers, miss the other's. → kill the alias. **[8 files]** — mechanical, safe now.

3. **Projection chain hand re-assembly** — shape→owner→participants pipeline centralized in 2 named functions, then rebuilt inline with inconsistent subsets at 5+ more sites (cache does owner+participants inline; inventory/canonical-key do shape-only). → the 2 named functions become the _only_ entry points. **[6 files]** — this IS principle P3.

4. **`session_participants` upsert body** — byte-identical conflict-merge logic (source merge, min/max prompted-at) duplicated verbatim at 2 sites plus a near-twin third. → `buildSessionParticipantUpsert()`. **[3 sites]** — safe now.

5. **Three "is this the same entry" comparators** — identity-only, logical-equal, full-equal, each ad hoc with no shared vocabulary for which fields count. → one leaf with a `granularity` param, tiers named explicitly. **[3 files]** — this IS principle P1's CAS rework.

6. **`session_conversations` upsert tuple** — same onConflict + doUpdateSet repeated 3× incl. once in canonical-repair. → `upsertSessionConversationLink()`. **[3 sites]** — safe now.

7. **`parent_session_key`/`spawned_by` computed two ways in one object literal** — `bindSessionNode` spreads the window projection then overrides those 2 columns with a _different_ fallback. **[1 file, tiny]** — safe now, fix anyway.

## YAGNI findings

8. **`isSqliteTranscriptTarget` dead export** — `paths.ts:50`, doc comment says callers "must branch on this," zero call sites exist. Either the guard was never wired (possible latent bug) or the check lives inlined somewhere. **Investigate before deleting** — may be a missing guard, not dead code.

## DELETE findings

None in scope.

---

## Fenced / downgraded (verified alive — no action)

- `legacy-main-session-migration*` (1,155 LOC) — runs every gateway boot via startup chain.
- `canonical-repair` (597 LOC) — ⚠ fenced "Doctor-only cross-store transfer" comment; reachable via live doctor-health flow.
- `entry_valid` tri-state, `allowCanonicalRepair`, `actor_source` feature-detection, all other opt flags — real call-site variance or explicit fence comments (e.g. "pre-feature databases lack actor_source").
- Retry loops — three genuinely different idioms, not copies.
- Equality helpers — already compose cleanly.

---

## Safe-anytime vs needs-ruling

- **Safe now (mechanical, zero behavior change):** #2 alias kill, #4, #6 upsert extraction, #7 fallback unification. → ideal **Phase 0 warm-ups**: test-protected, net-negative LOC, shrink the surface the real phases must touch.
- **Needs ruling (behavior-adjacent, = re-architecture phases):** #1 error taxonomy (P1 typed-error step), #3 projection consolidation (P3), #5 comparator tiers (P1 CAS rework), #8 (may be missing guard).

---

## Strategic read

The audit and the re-architecture plan **converge on the same cuts from opposite directions.** Findings #1/#3/#5 are literally Phases 1–3 of the plan measured in call sites. The four safe-anytime shrinks (#2/#4/#6/#7) are Phase-0 warm-ups. If the subsystem were fat with dead code, "just delete stuff" would be a cheaper path to simplicity — it is not, everything is alive, and the complexity is structural: one truth expressed through N hand-copied projections, comparisons, and error strings. The plan's net-negative-LOC success metric is the right lens.
