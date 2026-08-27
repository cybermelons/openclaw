# PHASE-4-AUDIT.md — Resumption Ordering Audit (CS-1)

Worktree: `/home/kiri/.openclaw/worktrees/rearch-session-store` @ HEAD `0d24175eef7`.
Method: verified against current code. The spec's line numbers (`session-history.ts:499-562`, `prepare.ts:1629`) were stale/pointed at a re-export shim and are corrected below. All paths absolute. This document is the Phase-4 contract (spec §2): a call site not enumerated here may not be changed.

## Executive corrections to the spec's citations

- `src/config/sessions/session-history.ts` is a **7-line re-export shim** (`listSessionEntriesByStatus`, `listSessionTranscriptInstances`) — **not** the retry loop. The spec's `session-history.ts:499-562` was a stale pointer.
- The **real** projection-lag sleep-retry loop is `src/agents/cli-runner/session-history.ts:497-563` (`readSqliteCliSessionEntries` + `sleep()` + `PROJECTION_RETRY_*` constants). Verified: constants at :501-503, retry loop :536-559, race comment :497-500.
- The **real** reseed decision ("prepare.ts:1629") is `src/agents/cli-runner/prepare.ts:1621-1652`, pinned by `src/agents/cli-runner/prepare-reseed-caller.phase0.test.ts`. Verified: "Three distinct states, not two" comment at :1623-1629.

## Marker / error / scan existence answers

| Question                                                                                          | Answer                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            | Evidence                                                                |
| ------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------- |
| Does `resume_epoch` marker/column exist on the session record?                                    | **NET-NEW.** No `resume_epoch`/`drain_pending` column or row exists. `session_nodes` (`src/state/openclaw-agent-schema.sql:15-47`) has `revision`, `entry_valid ∈ {-1,0,1}`, `status`, etc., but no resumption-epoch marker. All `drain*` hits in the tree are unrelated (audio buffers, delivery queues, auth mutations).                                                                                                                                                                                                                                        | `openclaw-agent-schema.sql:15-47`; grep of `resume_epoch\|drainPending` |
| Does an exported `SessionResumeDrainPendingError` (or any resume/drain error type) exist?         | **NET-NEW.** No such class anywhere. The nearest existing typed error is `SessionTranscriptProjectionUnavailableError` (`src/config/sessions/session-transcript-projection-error.ts`) — a _projection-index-rebuilding_ signal, not a resume-drain marker; it is not retryable-by-contract and carries only `sessionId`.                                                                                                                                                                                                                                          | grep `DrainPending`; `session-transcript-projection-error.ts`           |
| Is there a restart resumption-scan (§7(b)) that re-dispatches committed-but-undispatched resumes? | **YES.** `recoverStore` at `src/agents/main-session-recovery/main-session-restart-recovery-store.ts:214`, driven from `main-session-restart-recovery-runtime.ts:87,203`. It scans `listSessionEntriesByStatus(storePath, ["running"])` and re-dispatches any entry with `status === "running" && abortedLastRun === true` (`:274,:289`) via `resumeMainSession`. Today the scan keys on the `running`+`abortedLastRun` heuristic, **not** a committed `resume_epoch` — CS-3 must make dispatch derivable from a committed marker instead of these row heuristics. | `recovery-store.ts:214,274,289`; `recovery-runtime.ts:87,203`           |

---

## Enumeration 1 — DISPATCH / RESEED CALL SITES

### 1.1 — `resumeMainSession` drain-then-dispatch — **CLASS (b)**

`src/agents/main-session-recovery/main-session-restart-dispatch.ts:337` (`resumeMainSession`), critical region **:518-557**.

- **Reads/does:** at `:527` runs `reconcileCliTranscript({reason:"recovery"})` (the interrupted-turn **tail drain** into SQLite), then at `:554` calls `params.gatewayRuntime.dispatchAgent(...)` (the **resumed-turn dispatch**).
- **Assumes committed:** that the drained tail is durably in SQLite _before_ dispatch, because the dispatched turn reseeds from SQLite (`prepare.ts → loadCliSessionReseedMessages`) — comment at `:521` states this explicitly.
- **Ordering today:** enforced **only by statement sequence** (`await reconcile` then `await dispatch`) in one process, and **weakened by a timeout**: `Promise.race` against `PRE_DISPATCH_RECONCILE_TIMEOUT_MS = 5000` (`:50, :536`) — on timeout or failure it logs "dispatching anyway" (`:542`) and **dispatches regardless**. So drain-before-dispatch is best-effort, not guaranteed.
- **Classification (b):** this is the central Phase-4 site. The drain + a `drained` marker write must move into one transaction, and `dispatchAgent` must be gated on that COMMIT (delete the race-anyway timeout fallthrough).
- Note the **second** post-settlement reconcile at `:600` (`reason:"recovery"` again) — belt-and-suspenders re-drain; idempotent, subordinate to the pre-dispatch drain.

### 1.2 — `prepareCliRunContext` reseed dispatch — **CLASS (b)** (reader side of the same ordering)

`src/agents/cli-runner/prepare.ts:1636-1652`.

- **Reads:** `loadCliSessionReseedMessages({sessionId, sessionKey, agentId, ...})` (`:1640`) → which reads the SQLite transcript projection.
- **Assumes committed:** the interrupted-turn tail is already drained+committed (produced by 1.1). If it reads while the projection lags, it gets `SessionTranscriptProjectionUnavailableError` and today falls into the sleep-retry (Enumeration 2).
- **Runs before it in sequence:** the three-state reseed-reason decision (`:1621-1632`, Enumeration 4) and `shouldPrepareOpenClawHistoryPrompt` gate (`:1636-1637`).
- **Classification (b):** this is the reader that must, post-Phase-4, check the `resume_epoch` marker in the same snapshot and throw `SessionResumeDrainPendingError` instead of sleeping. It sits behind the marker transaction (it runs at dispatch-time, i.e. after the COMMIT that 1.1 will gain).

### 1.3 — `chat-history-pages` resume reconcile — **CLASS (a)** (non-resume-tail reader, see §7(c))

`src/gateway/server-methods/chat-history-pages.ts:400` calls `reconcileCliTranscript({reason:"resume"})`.

- This is a **UI chat-history page fetch**, not a resumed-turn dispatch. Per spec §7(c) it is a tail-tolerant reader and must **not** consult drain state or receive the typed error. **Class (a)** for the drain-pending mechanism (leave unchanged); it reconciles opportunistically and reads what is committed.

### 1.4 — Non-resume transcript readers (context for §7(c)) — **CLASS (a)**

`src/gateway/session-transcript-readers.ts:147,155`, `src/gateway/sessions-history-http.ts:228`, `session-transcript-title-reader.ts`, `session-companion-context.ts`, `chat-history-handler.ts`, `sessions-messaging.ts`, `plugin-sdk/session-transcript-runtime.ts`. All call `readSessionTranscriptMessageEvents`/handle `ProjectionUnavailableError` for **plain history views / titles / exports / listing**. **Class (a): leave unchanged** — they tolerate an incomplete tail, never consult resume/drain state (§7(c)).

---

## Enumeration 2 — THE SLEEP-RETRY LOOP

**The loop to delete:** `src/agents/cli-runner/session-history.ts:497-563` — `readSqliteCliSessionEntries` + `sleep()` (`:559`) + constants `PROJECTION_RETRY_MAX_ATTEMPTS=3`, `PROJECTION_RETRY_BACKOFF_MS=200`, `PROJECTION_RETRY_BUDGET_MS=2000` (`:501-503`). It catches `SessionTranscriptProjectionUnavailableError` (`:540`), and on that specific error `await sleep(...)` and re-reads up to the attempt/wall-clock budget (`:552-559`), else falls back to the legacy file reader. The header comment (`:497-500`) states plainly: _"Retry budget for a transient projection lag on resume… waits for it to catch up instead of reseeding a blank prompt."_ — **This is the projection-lag / read-after-write crutch on the RESUME history read.** **CLASS (c) — scheduled for deletion (CS-5).**

**Why this one and not the others:**

- `src/config/sessions/with-session-retry.ts` (`sleepWithBackoffJitter`) → retries **`SessionConflictError` (CAS/revision compare-and-swap)**, with a stale-closure tripwire. This is generic optimistic-concurrency retry, a _different mechanism_. **NOT deleted.**
- `src/auto-reply/reply/session-init-conflict-retry.ts` (`runWithSessionInitConflictRetry`) → retries **`ReplySessionInitConflictError` (session-init CAS loss)**. Also CAS-conflict, not projection-lag. **NOT deleted.**
- `src/config/sessions/session-transcript-reconcile.ts` — `waitForSessionTranscriptProjection` (`while(...) await delay(PROJECTION_READY_POLL_MS)`) polls the **FTS/search-index** reconcile to settle. It papers over the _same_ projection-lag mechanism but for **search/index maintenance**, not the resume-history reseed read. Out of Phase-4 scope (not a resume-path reader); flag for its own follow-up if desired, do **not** resurrect a sleep for resume in it.

**Every caller that reaches the CLASS (c) loop** (via `loadCliSessionEntries` → `readSqliteCliSessionEntries`, at `session-history.ts:579`):

| Caller                                | Site                                                               | DEPENDS on lag-papering (hides a real race) or merely tolerates?                                                                                                                                                                                  |
| ------------------------------------- | ------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `loadCliSessionReseedMessages`        | `session-history.ts:775` ← `prepare.ts:1640` (resumed-turn reseed) | **DEPENDS.** This is the resume path (Enum 1.2). Without the retry, a resume that reads while the drain's projection lags reseeds a blank/partial prompt → amnesiac resumed turn. This is exactly the race Phase-4's marker+typed-error replaces. |
| `loadCliSessionContextEngineMessages` | `session-history.ts:729` (`:722` export) — context-engine sync     | **DEPENDS (resume-adjacent).** Feeds warm context on resume/sync; same projection-lag exposure. Needs the marker check post-Phase-4 (tail-dependent reader).                                                                                      |
| `loadCliSessionHistoryMessages`       | `session-history.ts:714` (`:707` export) — CLI hook history        | **TOLERATES.** Hook-history view; an incomplete tail degrades gracefully to the file reader. Not correctness-critical to the drained tail.                                                                                                        |
| `hasCliSessionTranscript`             | `session-history.ts:671` — presence check (separate path)          | n/a — boolean existence probe, tolerant.                                                                                                                                                                                                          |

**Deletion safety (T3):** after Enum 1's ordering is commit-enforced, the resume reader (`loadCliSessionReseedMessages`) reads only after the drain COMMIT, so the projection is current on first read — the retry becomes dead. The only DEPENDS callers are the resume/context-engine reseed paths, which CS-4 converts to the typed-error refusal.

---

## Enumeration 3 — CURRENT ORDERING GUARANTEES (statement-sequence-only, must move into the marker txn)

1. **Tail drain → dispatch**, in `resumeMainSession` (`main-session-restart-dispatch.ts:527` drain, `:554` dispatch). Ordered only by `await`-then-`await` in one process, and _breakable_ by the 5s timeout (`:542` "dispatching anyway"). → Must become: `BEGIN → drain → set resume_epoch=drained → COMMIT`, dispatch gated on COMMIT.
2. **Drain → reseed read**, spanning processes/turns: `resumeMainSession` drains (`:527`), the dispatched turn later reseeds via `prepare.ts:1640` → `loadCliSessionReseedMessages`. Ordering guaranteed today only by "drain runs before dispatch runs before reseed" + the sleep-retry papering the gap. → reseed reader must consult the committed `drained` marker in the same snapshot.
3. **Reconcile kick → projection catch-up → re-read**, inside the doomed loop (`session-accessor.sqlite-active-projection.ts:123` kicks reconcile + throws; `session-history.ts:559` sleeps then re-reads). This "wait for projection" step is the sequence-ordering crutch itself. → replaced by commit-ordering (marker) + typed refusal; loop deleted.
4. **`abortedLastRun`/`running` heuristic → recovery dispatch**, in `recoverStore:289` → `resumeMainSession`. The "which sessions still need a resumed turn" decision is derived from row status flags, not a committed resumption marker. → §7(b): make undispatched-resume derivable from the committed `resume_epoch=drained` + no-dispatched-turn state.

---

## Enumeration 4 — THE THREE-STATE RESEED DECISION

**Decision point:** `src/agents/cli-runner/prepare.ts:1621-1652` — computation of `rawTranscriptReseedReason` (`:1630-1632`) and the `shouldPrepareOpenClawHistoryPrompt` reseed dispatch (`:1636-1652`).
**Pinned by:** `src/agents/cli-runner/prepare-reseed-caller.phase0.test.ts` (caller-side characterization pin over the three states; header comment cites "prepare.ts ~lines 1630-1633"). Observed indirectly via `context.reusableCliSession` (reason source) and `context.openClawHistoryPrompt` (what the reseed builder produced).

The code comment at `:1623-1629` explicitly declares **"Three distinct states, not two."** The reason is:

```
reusableCliSessionId ? "session-expired"
                     : (invalidatedReason ?? "no-cli-session")
```

| State               | Condition                                                                                       | `rawTranscriptReseedReason` | Pinned outcome                                                                                                                                             | Maps to drain-pending?                                                                                                                                                                                                                                                                                                  |
| ------------------- | ----------------------------------------------------------------------------------------------- | --------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **(a)** reuse       | `reusableCliSessionId` present (`reusableCliSession.mode="reuse"`)                              | `"session-expired"`         | Reseed still fires iff `allowRawTranscriptReseed` (`reseedFromRawTranscriptWhenUncompacted`); reads live CLI session's OpenClaw history (test `:136-169`). | **No** — keep byte-for-byte (§5 pin-flip: "other two states keep pinned outcomes").                                                                                                                                                                                                                                     |
| **(b)** invalidated | no reusable session, `invalidatedReason` set (`mode="invalidate"`, e.g. `"missing-transcript"`) | that `invalidatedReason`    | Reseed dispatch fires unconditionally; reads OpenClaw transcript (test `:171-203`).                                                                        | **No** — keep pinned.                                                                                                                                                                                                                                                                                                   |
| **(c)** bindingless | no reusable session **and** no `invalidatedReason` (`mode="none"`)                              | `"no-cli-session"`          | Reseed dispatch fires; OpenClaw transcript is the only surviving copy (test `:205-225`).                                                                   | **This is the drain-pending mapping state.** The bindingless/expired-session path reseeds from the drained SQLite tail and today enters the projection-lag retry. Under Phase-4, when its target epoch is `drain_pending`, this read yields `SessionResumeDrainPendingError`; when `drained`, it reseeds the full tail. |

**CS-4 pin flip:** the state whose reseed read currently enters the lag-retry (state **c**, the drain-tail-dependent reseed) is the one CS-4 rewrites to assert `SessionResumeDrainPendingError` on a `drain_pending` epoch; states **a** and **b** keep their pinned outcomes unchanged.

---

## Classification roll-up

- **(a) commit-ordered already / leave:** Enum 1.3 (`chat-history-pages` resume reconcile), 1.4 (all non-resume transcript/title/history readers), reseed states (a) and (b), `with-session-retry.ts` and `session-init-conflict-retry.ts` (CAS retries — not projection-lag).
- **(b) sequence-ordered → must become commit-ordered:** Enum 1.1 (`resumeMainSession` drain→dispatch), 1.2 (`prepareCliRunContext` reseed read), Enum 3 items 1-4, reseed state (c) reader.
- **(c) sleep-retry crutch → delete (CS-5):** `src/agents/cli-runner/session-history.ts:497-563` (`readSqliteCliSessionEntries` + `sleep` + `PROJECTION_RETRY_*`). DEPENDS callers: `loadCliSessionReseedMessages`, `loadCliSessionContextEngineMessages`. Tolerating callers: `loadCliSessionHistoryMessages`.

**Residual-risk flag (§7(d)):** `waitForSessionTranscriptProjection` (`src/config/sessions/session-transcript-reconcile.ts`, `while … await delay(PROJECTION_READY_POLL_MS)`) papers the _same_ projection-lag mechanism for the **FTS/search index**, a different consumer than resume reseed. It is out of Phase-4 scope; if its lag ever backs a resume-correctness path it needs its own issue — do not resurrect a resume sleep there.
