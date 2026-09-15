# issue-131 plan — main is red at its own base

Target: `pnpm build` and `node scripts/check-duplicates.mjs` both succeed on
this branch, so #129 and #130 can rebase onto a green main.

Two independent failures. Both must be fixed; fixing one leaves main red.

## Unit A — check-guards: tmp_phase3 scratch files

Reproduced locally, exit 1:

```
[dup:check] tracked duplicate-scan source files are outside scan targets or intentional excludes:
  - tmp_phase3-backfill.ts
  - tmp_phase3-divergence-census.ts
```

Root cause. `scripts/check-duplicates.mts:113` asserts every tracked source
file is either under a `targets` prefix (line 9-29) or under an
`intentionallyUnscannedPrefixes` entry (line 35). Every other tracked
root-level source file is named explicitly in `targets`:
`node-version.mjs`, `openclaw.mjs`, `tsdown.ai.config.ts`,
`tsdown.config.ts`, `vitest.config.ts`. The two `tmp_phase3-*.ts` files
landed in `031fc25bfba` (Phase 3 CS-1/CS-2) without the matching guard
update, so the guard correctly reports them as unclassified.

Decision: exclude, do NOT delete.

These are not dead scratch. `docs/session-rearchitecture/PHASE-3-LANDING.md:206`
lists, as an unexecuted post-merge human step, "Run `tmp_phase3-backfill.ts
<live-db> --apply` against the production store during a maintenance window".
PHASE-3.md gates CS-7's irreversible column drop on "census run 3 = zero",
which requires `tmp_phase3-divergence-census.ts`. Deleting them destroys
tooling the docs actively instruct an operator to run, and CS-7 is still
pending. They also import via relative `./src/...` paths and self-describe as
one-shot, so relocating them into `scripts/` is a rewrite, not a move.

`intentionallyUnscannedPrefixes` is prefix-only (`isUnderPrefix`, line 82),
so it cannot express a `tmp_` filename pattern as written. Smallest correct
change: classify the repo's documented `tmp_*` one-time-script convention
explicitly in the guard, with an inline comment stating why these are tracked
and why they are outside jscpd. Keep it a named convention, not two
hardcoded filenames — the repo rule "One-time scripts: tmp_*.ts" means more
will appear.

Net production LOC target: <= +5, comment included.

## Unit B — Control UI startup budget

Build fails at `ui:build`:

```
startup JS: 20 requests, 388.2 KiB gzip (limits: 18 requests, 332.7 KiB gzip)
startup JS gzip vs baseline: 397480 B (baseline 339585 B + tolerance 1056 B,
  max committed baseline 358400 B)
```

Proven NOT a #118 regression (openclaw#128): reproduces on both `71dbc5dd42a`
and the then-deployed `f884f32ae76` at 388.1 vs 388.2 KiB — a 0.1 KiB delta
across the whole gateway rework. The ratchet slipped over 191 commits since
`config/control-ui-startup-budget-baseline.json` was last refreshed
(`updatedAt: 2026-08-17`).

Pending: exact enforcement semantics from `scripts/check-control-ui-performance.mts`
— which of the three thresholds actually fails, and precisely what must change
for green. Plan finalized once that returns.

Judgment call to make explicitly and journal: reduce the bundle, or
re-baseline deliberately. Issue #128's own guidance is that whichever is
chosen must be "a conscious number rather than a ratchet nobody noticed
slipping". Scope here is main's base health; a genuine bundle reduction is
Control-UI feature work well outside this issue. Leaning deliberate
re-baseline with a written reason recording the 191-commit drift and the
`ghostty-web-*.js` 179.8 KiB share, plus a follow-up issue for the reduction.

## Out of scope

- Failure 3 in the issue body (missing GitHub App private key) is repo
  configuration, not code. Note in the PR; do not attempt.
- Do not touch openclaw#125, #127, or PRs #129/#130.

## Gates

Run ONE gate per shell command (chaining is the proven cause of session
death on this host). Build needs `--max-old-space-size=3072`.

- `node scripts/check-duplicates.mjs --coverage`
- `pnpm build` (or the narrowest `ui:build` path that proves the budget)

## Land

`.orch.toml` absent -> auto-land OFF. Open the PR and STOP.
