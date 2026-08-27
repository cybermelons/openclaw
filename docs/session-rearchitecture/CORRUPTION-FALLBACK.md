# Corruption-Fallback Design Spec (Phase 0 deliverable)

Author: Opus (design). Source: `./PLAN.md` stolen-pattern #2, `./HARNESS-RESEARCH.md` §3.2 (Claude Code
`.claude.json` corruption cluster #29003 / #29036 / #29217 / #18998, and the crash-loop #32160). This is a
**design spec, not code.** No implementation lands in Phase 0. Each item names the phase that owns its build.

The goal is the escape hatch the surveyed field lacks: a corrupt session database or row must never produce an
**auto-resume-on-boot crash loop** (the #32160 failure). Today the openclaw session DB already runs an integrity
check at every physical open, but it only _latches_ the failure — it never restores, and the boot recovery path
has **no corrupt-skip guard**, so a session that faults on resume is re-resumed every boot. This spec closes that gap.

## Current-state facts (against this worktree, current main)

- DB-open chokepoint: `openOpenClawAgentDatabase` — `src/state/openclaw-agent-db.ts:218`. Physical handle open at
  `:316` (`openNodeSqliteDatabase`, Node `node:sqlite` `DatabaseSync`). Every caller funnels through here; results
  are cached (`cachedDatabases`, `:113`). Incognito uses `:memory:` (`:253`).
- Integrity check ALREADY at open: `:332` `assertAgentDatabaseIntegrityBeforeMutation(db, agentId, pathname)`
  (`src/state/openclaw-agent-db-schema.ts:547`) → `assertSqliteIntegrity` (`src/infra/sqlite-integrity.ts:48`) runs
  `integrity_check` (`:51`) + `foreign_key_check` (`:52`). It is **not** skipped on a validated reopen (only schema
  / owner asserts are gated by `isValidatedReopen`).
- On failure the catch at `:349-359` only _latches_: `recordOpenClawAgentDatabaseOpenFailure` when
  `err.name === "SqliteSchemaVersionError" || isTerminalSqliteIntegrityError(err)`. **No restore.** A quarantine
  ledger already exists: `readOpenClawDatabaseQuarantine` / `clearOpenClawDatabaseQuarantine`
  (`openclaw-agent-db.ts:280`, `:164`), and `confirmOpenClawAgentDatabaseIntegrity` (`:129`).
- Snapshot primitive ALREADY exists, unwired to boot: `src/infra/sqlite-snapshot.ts` —
  `createVerifiedSqliteSnapshot` (`:633`, SQLite online `backup` → `VACUUM` → `assertSqliteIntegrity` on the copy →
  record `user_version` → re-verify published file) and `publishVerifiedSqliteFile` (`:414`, staged-copy →
  hash/size verify → atomic rename). This is the building block for the last-known-good (LKG) snapshot.
- `SessionRowCorruptError` does **not** exist yet (Phase 2 introduces it, per `./PLAN.md` P3).
- Auto-resume-on-boot sequence, `src/gateway/server-startup-post-attach.ts`:
  `markStartupOrphanedMainSessionsForRecovery` (`:634`) → `startChannels` (`:677`) →
  `scheduleRestartAbortedMainSessionRecovery` (`:1452`) → `unlockStartupMethods` (`:1468`). The recovery resume
  policy re-dispatches interrupted turns (`main-session-restart-recovery-resume-policy.ts`, `action: "resume"`).
  There is **no corrupt marker check** anywhere on this path — the crash-loop risk.

---

## Item 1 — Boot-time integrity check at DB-open

**Already present; formalize and time-budget it.** The `integrity_check` + `foreign_key_check` at
`openclaw-agent-db.ts:332` is the boot-time check. Two additions:

- **App-level validation** on top of the SQLite pragma: after the pragma passes, confirm the canonical session
  invariants the pragma cannot see — schema `user_version` matches the expected migration head, and a bounded
  smoke-read of `session_nodes` (e.g. `SELECT count(*)` + parse the newest row's `entry_json`). SQLite
  `integrity_check` proves page/b-tree health, not that `entry_json` is parseable; both are required to call the DB
  "good."
- **Time budget:** `integrity_check` is O(db size). Budget the whole open-time check at **≤ 750 ms** for a nominal
  session DB; for a DB above a size threshold, downgrade to `PRAGMA quick_check` (page-level, near-constant) plus
  the app-level smoke-read, so open latency stays bounded. Record the elapsed check time; if it exceeds budget,
  log a doctor warning (Item 5) rather than blocking boot.

Phase ownership: the pragma check is already live. The app-level validation + time budget = **Phase 1** (rides the
same open path the marker guard lands in).

## Item 2 — Last-known-good (LKG) snapshot policy

- **When:** publish an LKG snapshot after a **clean startup** completes (post `unlockStartupMethods`, `:1468`, once
  the DB has passed open-time integrity and the recovery scan has settled) and, at most, on a low-frequency timer
  (e.g. once per hour of live uptime) — never on the hot write path. Use `createVerifiedSqliteSnapshot`
  (`sqlite-snapshot.ts:633`); it already verifies integrity of the copy before publishing, so a corrupt live DB can
  never poison the snapshot.
- **Where:** alongside the agent DB, e.g. `sessions.db.lkg` under the same agent store dir, published atomically via
  `publishVerifiedSqliteFile` (`:414`). One current + one previous generation.
- **Retention:** keep the newest **2** verified snapshots (current + prior), plus retain the _quarantined corrupt
  file_ (Item 3) separately for forensics. Prune older generations.
- **Staleness caveat (from #29003):** Claude Code's auto-restore restored _stale_ data (lost feature-flag / settings
  writes) because the backup predated the lost writes. So: an LKG restore is **lossy by construction** — it rewinds
  to the last verified point and drops writes made after it. The restore path MUST surface this to the operator
  (Item 5) as "restored to snapshot from `<timestamp>`; writes after that point are lost," never silently. LKG is a
  recovery of last resort, below CAS (P1) and row-quarantine (Item 4), not a substitute for them.

Phase ownership: **Phase 1** (whole-DB LKG snapshot + restore), reusing the existing snapshot primitive.

## Item 3 — Corrupt-marker → quarantine, auto-resume MUST check the marker and SKIP

This is the crash-loop killer and the single most important item.

- On a **terminal** integrity/parse failure at open (the `:349-359` catch, extended), write a **persistent corrupt
  marker** for that DB (extend the existing quarantine ledger — `readOpenClawDatabaseQuarantine` /
  `clearOpenClawDatabaseQuarantine`, `openclaw-agent-db.ts:280`/`:164` — rather than inventing a parallel store).
  Move the corrupt file aside (quarantine copy) and, where an LKG exists, restore from it (Item 2); otherwise start
  from an empty initialized DB. The marker records: timestamp, failing check, the quarantined-file path.
- **The auto-resume-on-boot path MUST read the marker and SKIP.** Concretely: before
  `markStartupOrphanedMainSessionsForRecovery` (`server-startup-post-attach.ts:634`) and before
  `scheduleRestartAbortedMainSessionRecovery` (`:1452`) act on a session, they consult the corrupt marker; a session
  whose DB (or, post-Item-4, whose row) is marked corrupt is **not** re-resumed. Without this, a session that faults
  on resume is re-resumed every boot — exactly #32160.
- **Marker is cleared only by (a) the operator (`doctor` action), or (b) a successful verified restore.** A normal
  successful open does NOT auto-clear it — clearing must be a deliberate act, so a transiently-readable-but-still-bad
  DB cannot silently re-arm the crash loop. (Contrast Item 1's transient check, which re-runs each open; the _marker_
  is sticky.)

Phase ownership: **Phase 1** (marker write + skip-resume guard). This is the minimum viable escape hatch and should
land with the very first refactor phase.

## Item 4 — Two granularities: whole-DB restore vs. row quarantine

- **Whole-DB** (Item 2/3): the DB fails `integrity_check` / `foreign_key_check` or is unopenable → restore from LKG
  or reinitialize, mark corrupt, skip resume. Coarse, rare, catastrophic.
- **Row-level:** a single `entry_json` blob is unparseable while the DB is structurally sound. Post-Phase-2 this
  throws the typed **`SessionRowCorruptError`** (`./PLAN.md` P3; aligns stolen-pattern #4 "self-contained record" —
  a blob must be judgable alone). The single projection pipeline catches it, **quarantines that one row** (mark it
  corrupt in the same marker ledger, keyed by session id), and continues — one poison row never fails the whole
  store, and that session is skipped by the resume path (Item 3) rather than crash-looping.
- Relationship: row-quarantine is the fine-grained, common case; whole-DB restore is the coarse backstop when the
  container itself is bad. Both feed the **same** corrupt-marker ledger and the **same** skip-resume guard.

Phase ownership: whole-DB path = **Phase 1**; `SessionRowCorruptError` + row quarantine = **Phase 2** (it depends on
the one-projection-pipeline / one-parser that Phase 2 builds).

## Item 5 — Operator surfacing

- **Log:** every integrity failure, quarantine, restore, and skip-resume emits a structured warning/error at the
  point of action (open catch, recovery guard). A restore explicitly logs the snapshot timestamp and the
  lossy-rewind caveat (Item 2).
- **Doctor:** `openclaw doctor` surfaces (a) any active corrupt marker (which DB/session, when, which check failed,
  where the quarantined file is), (b) whether a restore happened and from when, and (c) the operator action to
  **clear the marker** (the only non-restore way to re-arm resume, Item 3). Wire this into the existing doctor
  surface (the repo already has `doctor-session-*` commands, e.g. `doctor-session-canonical-keys.ts`,
  `doctor-session-transcript-labels.ts`).

Phase ownership: log lines land with each item's phase; the consolidated `doctor` view = **Phase 6** (operator
tooling / process-seam hardening), with a minimal marker-visible log line available from **Phase 1**.

## Item 6 — Ordering interlock

The DB-open integrity check + LKG-restore + marker-write must complete **before** the boot recovery sequence
touches the session DB. That sequence is, in order (`server-startup-post-attach.ts`):

```
markStartupOrphanedMainSessionsForRecovery   (:634)   ← reads/writes session DB
startChannels                                (:677)
scheduleRestartAbortedMainSessionRecovery    (:1452)
unlockStartupMethods                         (:1468)
```

Interlock: **DB-open / integrity-check / restore / marker sits before `:634`.** Orphan marking at `:634` already
reads and writes the session DB, so the DB must be proven-good (or restored, or its bad sessions marked-skip) before
that line runs. The corrupt-marker skip guard (Item 3) is consulted **inside** `:634` and `:1452` so a marked
session is excluded from both orphan-marking and resume scheduling.

This is **compatible with the T-A2 pin** (Phase 0, `PHASE-0.md` §A2): T-A2 pins the current order
`[markStartupOrphanedMainSessionsForRecovery → startChannels → scheduleRestartAbortedMainSessionRecovery →
unlockStartupMethods]`. The corruption interlock does not reorder those four; it inserts a _pre-step_ (DB-open/check)
ahead of the first and a _consultation_ of the marker inside the first and third. When Phase 6 formalizes the
startup phase machine (`./PLAN.md` P5), the DB-open/check becomes the ordered step that precedes `markOrphans`, and
T-A2's pinned order remains the tail of that list.

## Item 7 — Phase ownership summary

| Capability                                                               | Phase                                       |
| ------------------------------------------------------------------------ | ------------------------------------------- |
| Corrupt-marker write + skip-resume guard (the crash-loop escape hatch)   | **Phase 1**                                 |
| Whole-DB LKG snapshot + restore (reuse `sqlite-snapshot.ts`)             | **Phase 1**                                 |
| App-level open-time validation + time budget (pragma check already live) | **Phase 1**                                 |
| Row quarantine via `SessionRowCorruptError`                              | **Phase 2** (needs the one-parser pipeline) |
| Consolidated `doctor` corruption view                                    | **Phase 6** (minimal log line from Phase 1) |
| Integration into the explicit startup **phase machine** (ordered runner) | **Phase 6**                                 |

Rationale for front-loading the marker + skip guard into Phase 1: it is the one item whose absence causes an
_unrecoverable_ state (crash loop), and it is cheap (a sticky flag + two guard reads). Everything heavier —
row-granularity and the phase-machine integration — waits for the phases that build the pipeline and the runner.
