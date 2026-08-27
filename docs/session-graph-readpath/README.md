# Session-Graph Read / Visibility Re-Architecture

Tracking program for the **session-graph read/visibility** defect class. Sibling to
the session-**store** integrity re-architecture (`docs/session-rearchitecture/`, fork #18).

Symptom that opened the class: a parent session's subtask UI card does not show the
child subagent's command/tool-call history.

## Class boundary

- **#18** = one fact stored many ways (revision CAS, projection pipeline). Write-path / store integrity.
- **This** = one relationship keyed many ways and resolved by disagreeing read predicates. Read-path / graph identity.

The two plans share exactly ONE seam — the `parent_session_key`/`spawned_by`
unification (#18 Phase 0.5 item #7). `PLAN.md` §3 states the ownership split and a
binding reconciliation rule so the plans do not collide.

## Contents

- [`PLAN.md`](./PLAN.md) — Fable design: root pattern, verdict (3 ranked drop points),
  seam contract with #18, 5 design principles, harness bench, 6-phase migration, exclusions, open questions.
- [`EVIDENCE.md`](./EVIDENCE.md) — the five scout dossiers with file:line evidence for every claim.

## Status

Planning complete. **No production code.** The single unproven claim (does the
subagent runtime persist tool events under `childSessionKey` or the parent id?) is
the whole point of Phase 0. Nothing else starts before it.

Refs: #18 (store re-arch), #13 (rename-CAS), #14 (resume race).
