# Session-Graph Read / Visibility Re-Architecture (openclaw-src)

Date: 2026-08-26. Author: Fable (design only, no code).
Sibling to: `./PLAN.md` (issue #18, session-STORE integrity re-architecture: revision CAS, projection pipeline). This document is a separate class. It shares exactly ONE seam with #18 (the `parent_session_key`/`spawned_by` unification, #18 Phase 0.5 item #7). Section 3 reconciles that seam.
Refs: fork #13 (rename-CAS), #14 (resume race). Symptom that opened the class: a parent session's subtask UI card does not show the child subagent's command/tool-call history.
Evidence: four verified scout dossiers (read-path, linkage-identity, read-scope, control-ui) plus a harness benchmark. File:line refs below come from those dossiers against current main.

---

## 1. Root pattern

State the class in one sentence, distinct from #18.

#18 root pattern: **state is duplicated across representations, compared by value, and ordered by call sequence.**

This class root pattern: **a child session is linked to its parent by four different identity keys, each computed by a different rule, and the read paths that resolve "which parent owns this child" do not agree on which key is authoritative — so a child that is legitimately reachable by one key is dropped by another read path that trusts a different key.**

Said once: **#18 is about one fact stored many ways; this class is about one relationship keyed many ways and resolved by disagreeing predicates.** The subtask-card symptom is one instance of that pattern. The rename half-repair (`doctor-session-incognito-key-repair.ts:287-312`) and the reparent divergence (`subagent-list.ts:109-110` vs `session-utils-core.ts:435-437`) are other instances of the same pattern.

---

## 2. Verdict — where child command history fails to reach the parent subtask surface

The read path is fully wired end to end. The scouts proved this and it must anchor the verdict.

- The task record carries `childSessionKey`; the client schema projects it (`src/tasks/task-domain-views.ts:33`; `packages/gateway-protocol/src/schema/tasks.ts:53`).
- The UI detail panel selects the CHILD session key as the transcript source and fetches the child's history with a 100-message limit (`ui/src/pages/chat/components/chat-task-detail.ts:54-58`; `ui/src/pages/chat/components/chat-task-detail-state.ts:92-96`).
- The UI visibility filter does NOT strip tool-call/command rows; it drops only silent replies, synthetic repair results, and empty user text (`ui/src/pages/chat/chat-history.ts:228-234`).
- The gateway `chat.history` handler reads exactly one session and applies no parent→child denial (`src/gateway/server-methods/chat-history-handler.ts:205-216`, `:352-364`).
- Read-scope carries no owner/visibility gate; under the default `tree` policy the parent is a legitimate owner of the child (`src/plugin-sdk/session-visibility.ts:457-465`, `:500-506`; `src/config/sessions/session-accessor.sqlite-scope.ts:173-217`).

Therefore the failure is NOT a read-scope denial and NOT an unwired join. The verdict names three candidate drop points, ordered by likelihood. The scouts could confirm the read side but could not reach the write side, so the primary drop point is stated as the leading hypothesis and flagged for a write-side confirmation gate in Phase 0.

**Primary drop point (write-side, most likely).** The child subagent runtime writes its tool-call/command events under a session id that is NOT the `childSessionKey` that the card reads. The read is correctly scoped to `childSessionKey`; if events land under the parent/requester session id instead, the correctly-scoped read surfaces no commands. Evidence for the shape of the hazard: `parent_session_key` is stamped on the write-side row as `parentSessionKey ?? spawnedBy` (`src/config/sessions/session-accessor.sqlite-session-row.ts:104-106`), and the transcript reader keys off the child's own `sessionId`/`storePath` with no `parent_session_key` filter (`src/gateway/session-transcript-readers.ts:75-78`). This drop point is a hypothesis until Phase 0 confirms where subagent tool events are persisted. It is marked an open question in Section 8.

**Secondary drop point (empty child-key OR cleaned-up child).** Two sub-cases collapse to the same UI symptom (the panel silently degrades to prompt+output fallback):
- `childSessionKey` is empty/null on the task summary at read time. The wire field is Optional (`packages/gateway-protocol/src/schema/tasks.ts:53`); when absent, the UI falls back to `renderTaskFallback` (`ui/src/pages/chat/components/chat-task-detail.ts:66-69`). Whether the server populates `childSessionKey` (from the compact `ln` on task rows) for parent-session subtask rows is unconfirmed and is an open question.
- The child session row is cleaned up/deleted, so `sessionId`/`storePath` is absent, and `chat.history` returns `{messages:[]}` (`src/gateway/server-methods/chat-history-pages.ts:376-386`), which the UI shows as `transcriptEmpty`. The store-only child link is kept only transiently (`src/gateway/session-utils-core.ts:259-275`); after the subagent run ages out, the only surviving link is `parentSessionKey`/`spawnedBy` — so a child linked solely by the run's `controllerSessionKey` disappears after run expiry.

**Tertiary drop point (linkage disagreement).** The session-graph parent (`parentSessionKey ?? spawnedBy`, `src/gateway/session-utils-core.ts:435-437`) and the subtask-run parent (`controllerSessionKey ?? requesterSessionKey`, `src/agents/subagents/registry/subagent-list.ts:109-110`; owner resolve `src/gateway/session-utils-row.ts:228-230`) are two independent identities. For a reparented or forked child they disagree, so the card can resolve to a different parent than the sidebar tree, and one of the two never shows the history. A related asymmetry: `isCurrentSessionChildOwner` trusts ONLY `parentSessionKey` plus the live `controllerSessionKey` and ignores `spawnedBy` (`src/gateway/session-utils-core.ts:412-423`), while the candidate index that feeds it is built from BOTH `spawnedBy` and `parentSessionKey` (`:435-437`) — so a `spawnedBy`-only child whose live controller differs from `spawnedBy` is dropped from the parent's children (`:465-476`).

Note on the card itself: the compact task row shows only `lastToolName`/`toolUseCount` by design (`packages/gateway-protocol/src/schema/tasks.ts:64-65`). "Card does not show history" therefore means the opened detail panel, not the summary row. Confirm the operator opened the panel before treating this as a fault.

---

## 3. The shared seam with #18

Both plans touch `parent_session_key`/`spawned_by`. State ownership and the reconciliation rule so the two plans do not collide.

**Who owns the seam: #18 owns the STORAGE representation. This class owns the READ SEMANTICS.**

- #18 Phase 0.5 item #7 unifies the `parent_session_key`/`spawned_by` fallback computed two ways in `bindSessionNode` (`src/config/sessions/session-accessor.sqlite-session-row.ts:104-106`). #18 declares this a zero-behavior-change dedup: one function computes `parentSessionKey ?? spawnedBy`, called from both the row builder and the JSON→column migration.
- This class does NOT change the storage collapse rule. This class changes which key the READ paths trust, and makes the read predicates agree.

**The collision risk.** #18's dedup assumes the collapse `parentSessionKey ?? spawnedBy` is lossless and behavior-preserving. The linkage scout proved it is NOT lossless on read-back: `parentSessionKey` is reconstructed only when `parent_session_key !== spawned_by` (`src/config/sessions/session-accessor.sqlite-canonical-inventory.ts:84-87`), so a child whose real `parentSessionKey` equals its `spawnedBy` loses the explicit `parentSessionKey` field on read-back. If this class later needs `parentSessionKey` to be independently readable (to make the reparent case in the tertiary drop point resolvable), #18's "behavior-preserving" collapse becomes behavior-CHANGING for us.

**Reconciliation rule (binding on both plans).**

1. #18 Phase 0.5 item #7 stays behavior-preserving and lands FIRST. It only removes the duplicate computation. It does NOT add a new column and does NOT change the collapse rule. Land it as written.
2. This class does NOT modify item #7's collapse. Instead, if this class determines (Phase 2 below) that `parentSessionKey` and `spawnedBy` must be independently readable, this class adds a SEPARATE, ADDITIVE change: keep `spawned_by` as is, and stop overloading `parent_session_key`. That change is BEHAVIORAL and belongs to THIS plan, not #18. It must land AFTER #18 Phase 1 (revision CAS), because rewriting the meaning of a projected column is exactly the projection-consolidation surface #18 Phase 2 governs.
3. Neither plan edits `parent_session_key`/`spawned_by` write logic in the same PR. #18 touches it as dedup; this class touches it as semantics; they land in separate phases, gated on #18 landing its item #7 first.

**Concrete guard so they do not collide.** Add a single characterization test in #18 Phase 0 (the shared wall) that pins the current read-back behavior of `parentSessionKey === spawnedBy` children (they read back with `parentSessionKey` absent). Both plans reference this test. #18 must keep it green (proving item #7 changed nothing). This class, when it lands the additive semantic change, updates that test deliberately in its own PR — the test flip is the visible marker that ownership of the seam moved from #18 (behavior-preserving) to this class (behavioral).

---

## 4. Target design principles

Three to five, each tied to evidence.

### R1. One child→parent identity, one resolver
Collapse the four linkage keys (`parentSessionKey`, `spawnedBy`, `controllerSessionKey`, `requesterSessionKey`) into ONE resolver function that every read path calls: `resolveChildParent(child) -> parentKey`. No read path may re-derive lineage inline. Today three OR-policies disagree — the list filter (`src/gateway/session-utils-list.ts:271-272`), the ownership check (`src/gateway/session-utils-core.ts:412-423`), and the visibility check (`src/plugin-sdk/session-visibility.ts:405-411`) each trust a different subset. One resolver makes disagreement structurally impossible.

### R2. The card's transcript source is one authoritative key, verified present
The subtask card must resolve its transcript key through ONE path, and that key must be verified to hold the child's tool events before the card claims to show history. Today the card trusts `childSessionKey` (`ui/src/pages/chat/components/chat-task-detail.ts:54-58`) while the sidebar tree trusts `parentSessionKey ?? spawnedBy` (`src/gateway/session-utils-core.ts:435-437`); when these disagree the card reads a session that never held the events. Tie the card's key to the same resolver R1 produces, and make an empty result distinguishable from a wrong-key result.

### R3. Write-side attribution must target the read-side key
Subagent tool-call/command events must persist under the SAME session id the card reads (`childSessionKey`). The read is correctly scoped (`src/gateway/session-transcript-readers.ts:75-78`); the fault, if the primary drop point confirms, is that writes land elsewhere. Attribution at write time and resolution at read time must reference one key, not two.

### R4. Link survival must not depend on a transient run row
A store-only child link is kept only transiently (`src/gateway/session-utils-core.ts:259-275`, expiry gate `:452-462`). A child linked solely by the run's `controllerSessionKey` loses its parent link once the run ages out. The durable link (`parentSessionKey`/`spawnedBy` on the child row) must be stamped at spawn, so the card survives run expiry. Persist the durable link eagerly; treat the run row as a live accelerator, never the sole source of truth.

### R5. Empty is not the same as denied is not the same as misrouted
`chat.history` returns `{messages:[]}` for a cleaned-up child (`src/gateway/server-methods/chat-history-pages.ts:376-386`), and the UI collapses that into a generic `transcriptEmpty` state. Distinguish, in the wire result, three cases: (a) child key absent, (b) child key present but session cleaned up, (c) child key present and transcript genuinely empty. The operator and the maintainer must be able to tell which drop point fired.

---

## 5. Harness-bench — what to steal

Field harnesses converge on two link models for surfacing child history to a parent view: an ID/metadata pointer into a separately-stored child transcript, fetched or resumed on demand (Claude Code's `parent_tool_use_id` plus separate child transcript files; Amp's `SubagentSessionInfo`, which records the child session id AND message indices so the parent knows exactly where in the child's history the delegated turn sits; Codex's persisted session history); and a filesystem-output model that the parent polls (Cursor's `~/.cursor/subagents/`). The pattern worth stealing for this class is Amp's: store a single explicit pointer (child session id + message range) on the parent's delegating tool call, so resolution is one lookup and the child transcript is a real, resumable thread reachable by that pointer — this directly serves R2 (one authoritative key) and R4 (durable link, not a transient run row). Steal Amp's second discipline too: children are real threads filtered OUT of the primary thread list but reachable by pointer, which matches the OpenClaw card model (child hidden from the sidebar, opened from the parent's task panel). Do NOT steal Goose's live token-echo of child tool calls into the parent surface — it is a heavier live-stream contract than this class needs, and OpenClaw already persists the child transcript, so on-demand fetch (which the UI already does) is the right model; the fix is making the pointer correct and durable, not adding a live stream.

---

## 6. Phased migration

Each phase lands alone with a gate, ordered by risk. Phases that depend on #18 are marked.

**Phase 0 — write-side confirmation wall (before any change).**
Confirm the primary drop point. Add a test that spawns a subagent, runs one tool call in the child, and asserts the tool-call event is persisted under `childSessionKey`'s `sessionId`/`storePath` — NOT under the parent/requester id. This is the single unproven claim in the whole class (Section 8, open question 1). If the test fails, the primary drop point is confirmed and R3 becomes the lead fix; if it passes, the fault is secondary/tertiary and Phase 1 leads. Also pin the current read-back of `parentSessionKey === spawnedBy` children — this is the SHARED test with #18 Phase 0 (Section 3 guard). Gate: the write-side attribution test exists and its pass/fail is recorded in the PR.
Depends on: nothing. Must precede everything.

**Phase 1 — one resolver, no behavior change (R1).**
Extract `resolveChildParent(child)` and route the three OR-policies (`session-utils-list.ts:271-272`, `session-utils-core.ts:412-423`, `session-visibility.ts:405-411`) through it, preserving each call site's CURRENT effective behavior behind the single function. This is a consolidation, not a semantic change — it makes the disagreement visible in one place before anyone changes it. Gate: existing session-list, ownership, and visibility tests stay green; a new test asserts all three call sites now return the resolver's answer.
Depends on: #18 Phase 0.5 item #7 (the `bindSessionNode` dedup) landing FIRST, so the write-side collapse is already single-sourced before this class single-sources the read side. Marked #18-dependent.

**Phase 2 — durable link at spawn (R4).**
Stamp the child row's durable parent link (`parentSessionKey`/`spawnedBy`) at spawn time, so the card survives subagent-run expiry. Verify at Phase 0's write-side confirmation which link spawn currently persists. Gate: a test that ages out the subagent run and asserts the parent→child link still resolves via the store row.
Depends on: Phase 1 (resolver must exist first). If Phase 2 needs `parentSessionKey` independently readable, that additive column-semantics change is BEHAVIORAL, belongs to this plan, and must land AFTER #18 Phase 1 (revision CAS) per the Section 3 reconciliation rule. Marked #18-dependent for that sub-change only.

**Phase 3 — card key = resolver key (R2).**
Make the subtask card's `transcriptSessionKey` derive from the same resolver R1 produces, so the card and the sidebar tree never disagree for reparented/forked children. Reconcile the two identities (session-graph parent vs subtask-run parent) by defining the run-side identity as a live accelerator over the durable link, not a competing truth. Gate: a reparent/fork test asserts the card and the sidebar resolve to the SAME parent.
Depends on: Phase 1 and Phase 2.

**Phase 4 — write-side attribution fix (R3) — CONDITIONAL.**
Only if Phase 0 confirmed the primary drop point. Route subagent tool-call/command events to persist under `childSessionKey`. Highest blast radius (touches the subagent runtime write path, outside the read area the scouts covered). Gate: the Phase 0 write-side test now passes; the UI panel shows child commands end to end.
Depends on: Phase 0 confirmation; lands after Phase 3 so the read side is already coherent when the write side is corrected.

**Phase 5 — distinguishable empty/denied/misrouted (R5).**
Split the single `transcriptEmpty` UI state into the three wire cases from R5. Gate: a test per case (absent key, cleaned-up child, genuinely empty) drives a distinct UI state.
Depends on: nothing structural; land last as a diagnosability improvement so future regressions in this class self-report which drop point fired.

Order rationale: 0 before all (the one unproven claim); 1 before 2/3 (resolver before anyone trusts it); 4 conditional and late (highest blast radius, needs the wall); 5 last (pure diagnosability). Phases 1 and 2 gate on #18's item #7 and #18 Phase 1 respectively; nothing else in this class touches #18's surface.

---

## 7. Explicitly excluded as speculative

- Live token-level streaming of child tool calls into the parent surface (Goose model). The child transcript is already persisted and the UI already fetches it on demand; a live stream is a heavier contract this symptom does not require.
- Nested/recursive subagent depth handling. No evidence in the dossiers that the symptom involves nesting; Amp caps depth at 1 and OpenClaw's card model does not surface a nesting requirement. Out of scope.
- Any change to `tools.sessions.visibility` policy semantics. The read-scope scout proved scope is NOT the blocker under the default `tree` policy (`src/plugin-sdk/session-visibility.ts:457-465`). Touching visibility would be a fix for a non-fault.
- Rewriting the `doctor-session-incognito-key-repair.ts:287-312` half-rename repair. It is a same-class instance but a separate symptom (rename, not subtask-card); flag it as a follow-up, do not fold it in.
- Merging child history INTO the parent transcript. The card model is a separate read of a separate thread; merging is a product change, not a fix.

---

## 8. Open questions the scouts could not resolve

1. **(Primary, blocks Phase 0.)** Does the subagent runtime persist tool-call/command events into the CHILD session's `transcript_events`, or under the parent/requester session id? This is the single most likely real drop point and lives on the write side, outside every scout's area. Phase 0 exists to answer it.
2. Does the server populate `TaskSummary.childSessionKey` (mapped from the compact `ln`) for parent-session subtask rows, or emit it empty? If empty, the UI silently degrades to the prompt+output fallback and never calls `chat.history`. Needs the `src/tasks` task-summary serializer confirmed.
3. At spawn time, is the child's `parentSessionKey`/`spawnedBy` always stamped equal to the run's `controllerSessionKey`/`requesterSessionKey`? If spawn writes only the run-side link and defers the store-side link, the card depends entirely on the transient run row and vanishes after expiry (the Phase 2 hazard).
4. For reparented/forked children, is `controllerSessionKey` updated to the new parent, or does it stay at the original requester? This determines whether the card follows or diverges from the sidebar tree (the Phase 3 hazard).
5. Does the raw upsert (`src/state/openclaw-agent-db-schema.ts:516-539`) ever run for spawned children, writing raw `parentSessionKey` without the `?? spawnedBy` collapse, and can it desync from the row-builder and trip the canonical-key repair throw (`src/config/sessions/session-canonical-key.ts:172-181`)? This intersects #18's projection surface.

---

## 9. Decisions needed from the operator

1. Green-light Phase 0 (the write-side confirmation wall) now? It is the cheapest phase and settles whether the fix is primarily write-side (R3/Phase 4) or read-side (R1–R3). Nothing else should start before it.
2. Confirm the Section 3 reconciliation: #18 keeps item #7 behavior-preserving and lands it first; this class owns any BEHAVIORAL change to `parent_session_key` semantics and lands it after #18 Phase 1. Is that ownership split accepted?
3. Fork-only, matching #18's ruled decision, or attempt upstreaming the read-side consolidation (Phases 1–3 are upstream-palatable; Phase 4 likely too invasive)?
4. Post this design as a sibling issue on the fork, cross-linked to #18, for tracking?
5. Should the `doctor-session-incognito-key-repair.ts:287-312` half-rename repair (a same-class instance, separate symptom) be filed as its own follow-up now, or deferred until this class lands?