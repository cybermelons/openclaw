# Session-Graph Read-Path — Scout Evidence Dossier

Date: 2026-08-26. Five research scouts (4 code, 1 web), 0 errors. File:line refs against `main` @ commit `62bfc111d77`.
Companion to `./PLAN.md`. Every plan claim traces to a finding below.

---

## Scout: read-path

**Area:** READ path: task/subtask card -> child subagent command/tool-call history -> transcript rows

### Findings

- **Task record carries the child subagent session key as childSessionKey and it is projected into the client-facing TaskRunView/TaskSummary.**
  - Evidence: `src/tasks/task-domain-views.ts:33 (mapTaskRunView spreads childSessionKey); packages/gateway-protocol/src/schema/tasks.ts:53 (TaskSummarySchema.childSessionKey Optional String)`
- **The UI subtask detail panel selects the CHILD session key as the transcript source for subagent tasks (not the requester/parent conversation).**
  - Evidence: `ui/src/pages/chat/components/chat-task-detail.ts:54-58 (transcriptSessionKey = runtime==="subagent" ? childSessionKey : childSessionKey ?? sessionKey); comment ln52-53 'only the child session is that task's transcript'`
- **The UI DOES fetch the child's history: it calls chat.history with sessionKey=childSessionKey and a 100-message limit, then renders it as a read-only transcript.**
  - Evidence: `ui/src/pages/chat/components/chat-task-detail.ts:141-144, 160-169 (readTaskTranscript + renderReadOnlyTranscript); ui/src/pages/chat/components/chat-task-detail-state.ts:92-96 (client.request("chat.history",{sessionKey: state.sessionKey, limit: CHAT_HISTORY_REQUEST_LIMIT}) then visibleChatHistoryMessages)`
- **The UI visibility filter applied to the fetched child messages does NOT strip tool-call/command rows; it only drops silent/heartbeat assistant replies, synthetic repair tool-results, and empty user messages.**
  - Evidence: `ui/src/pages/chat/chat-history.ts:236-240 (visibleChatHistoryMessages -> filter(!shouldHideHistoryMessage)); ui/src/pages/chat/chat-history.ts:228-234 (shouldHideHistoryMessage = shouldHideAssistantChatMessage || isSyntheticTranscriptRepairToolResult || isEmptyUserTextOnlyMessage)`
- **The gateway chat.history handler reads exactly ONE session (the requested sessionKey); it does no parent->child fan-in and applies no parent/child ownership or visibility denial. It resolves the child entry read-only (loadGatewaySessionEntryReadOnly with includeStoreChildEntries).**
  - Evidence: `src/gateway/server-methods/chat-history-handler.ts:205-216 (loadGatewaySessionEntryReadOnly includeStoreChildEntries:true), 352-364 (readChatHistoryPage called with canonicalKey/sessionId of the requested key only)`
- **readChatHistoryPage builds a readScope from the single canonicalKey+sessionId+storePath and reads that session's own transcript_events; the ONLY empty-result drop is when sessionId or storePath is missing (child session cleaned up/deleted), not a scope denial.**
  - Evidence: `src/gateway/server-methods/chat-history-pages.ts:388-394 (readScope = single sessionKey/sessionId/storePath), 376-386 (returns {messages:[]} when !sessionId||!storePath)`
- **The transcript reader keys off the child session's own sessionId/storePath and does NOT filter transcript_events by parent_session_key on the read side, so the child's command/tool-call events are returned directly.**
  - Evidence: `src/gateway/session-transcript-readers.ts:75-78 (resolveTranscriptReadTarget -> resolveSessionTranscriptReadTarget(scope)); parent_session_key appears only on the WRITE-side row stamp at src/config/sessions/session-accessor.sqlite-session-row.ts:104-105, and grep for parent_session_key/WHERE in session-accessor.transcript-target.ts returns nothing`
- **A separate CLI read path (/subagents log) also fetches child history via chat.history(childSessionKey) but DEFAULTS to stripping tool messages unless the 'tools' arg is passed.**
  - Evidence: `src/auto-reply/reply/commands-subagents/action-log.ts:39-44 (callGateway chat.history sessionKey:childSessionKey; filtered = includeTools ? raw : stripToolMessages(raw))`

### Key files

- `ui/src/pages/chat/components/chat-task-detail.ts`
- `ui/src/pages/chat/components/chat-task-detail-state.ts`
- `ui/src/pages/chat/chat-history.ts`
- `src/gateway/server-methods/chat-history-handler.ts`
- `src/gateway/server-methods/chat-history-pages.ts`
- `src/gateway/session-transcript-readers.ts`
- `src/tasks/task-domain-views.ts`
- `packages/gateway-protocol/src/schema/tasks.ts`
- `src/auto-reply/reply/commands-subagents/action-log.ts`
- `src/config/sessions/session-accessor.transcript-target.ts`

### Open questions

- The read path is fully wired end-to-end (card childSessionKey -> chat.history(child) -> child transcript_events, tool rows preserved). So the reported symptom is NOT a read-scope denial and NOT an unwired join. Confirm the actual failure is one of: (a) childSessionKey is empty/null on the TaskRecord at read time (WRITE-side: is childSessionKey populated for subagent tasks, or only for ACP?), or (b) the child session row is cleaned up/deleted so sessionId/storePath is absent -> chat.history returns {messages:[]} (chat-history-pages.ts:376-386), which the UI shows as 'transcriptEmpty'.
- Verify whether subagent runtime actually persists tool-call/command events into the CHILD session's transcript_events (write side), vs. writing them under the parent/requester session id. If tool calls are written under a different session id than childSessionKey, the read (correctly scoped to childSessionKey) would surface no commands. This is the most likely real drop point and lives on the WRITE side outside this area.
- Confirm chat-task-detail.ts is only reached when a task detail panel is opened; the compact task card row itself only shows lastToolName/toolUseCount (schema tasks.ts:64-65), not full command history — so 'card does not show history' may simply mean the summary row, by design, never lists commands and the panel must be opened.

---

## Scout: linkage-identity

**Area:** Session-graph linkage identity: parent_session_key / spawnedBy / parentSessionKey / childSessionKey WRITE and READ enumeration and divergence map

### Findings

- **WRITE (SQLite column projection): parent_session_key column = parentSessionKey ?? spawnedBy; spawned_by column = spawnedBy only. This collapses two logical fields into one column.**
  - Evidence: `src/config/sessions/session-accessor.sqlite-session-row.ts:104-106`
- **WRITE (JSON->column migration) uses the SAME collapse rule COALESCE($.parentSessionKey, $.spawnedBy) for parent_session_key and $.spawnedBy for spawned_by, so both write paths agree.**
  - Evidence: `src/state/openclaw-agent-db-session-nodes-migration.ts:95-96; also legacy nodes migration COALESCE at same rule 246-247`
- **WRITE (agent-db upsert) binds parent_session_key=migratedText(entry.parentSessionKey), spawned_by=migratedText(entry.spawnedBy) directly from entry (no COALESCE here — a divergent third projection that stores raw parentSessionKey, unlike the row-builder which collapses).**
  - Evidence: `src/state/openclaw-agent-db-schema.ts:516-517,539-540`
- **READ round-trip INVERSE of the write collapse: parentSessionKey is reconstructed from the column ONLY when parent_session_key !== spawned_by. So a child whose real parentSessionKey happened to equal spawnedBy loses the explicit parentSessionKey field on read-back (it reappears only as spawnedBy).**
  - Evidence: `src/config/sessions/session-accessor.sqlite-canonical-inventory.ts:84-87`
- **READ list-filter (the cited read seam) trusts EITHER field with an OR: store-only child kept when entry.spawnedBy === spawnedBy OR entry.parentSessionKey === spawnedBy. This is the OR that the write's single column cannot represent losslessly.**
  - Evidence: `src/gateway/session-utils-list.ts:271-272`
- **DIVERGENCE / asymmetry: isCurrentSessionChildOwner trusts ONLY entry.parentSessionKey (plus live controllerSessionKey) as authoritative navigation lineage; it ignores entry.spawnedBy. But the candidate index that feeds it is built from BOTH spawnedBy and parentSessionKey. A child linked only via spawnedBy (no parentSessionKey) that has a live subagent run whose controller differs from spawnedBy is DROPPED from the parent's children — the subtask card link is lost.**
  - Evidence: `src/gateway/session-utils-core.ts:412-423 (owner check parentSessionKey only) vs 435-437 & 309-311 (index from spawnedBy+parentSessionKey)`
- **DIVERGENCE: buildStoreChildSessionIndex applies isCurrentSessionChildOwner gate per parentKey — when a live subagent run exists, a spawnedBy-only parent is filtered out unless controllerSessionKey matches it, even though the store child index enumerated it.**
  - Evidence: `src/gateway/session-utils-core.ts:465-476`
- **SEPARATE (second) identity for the subtask card: the command/tool history link is keyed by subagent_runs.child_session_key with controllerSessionKey||requesterSessionKey as the owner — NOT parent_session_key/spawnedBy at all. subagent-list groups children purely by controllerSessionKey||requesterSessionKey, never consulting parentSessionKey/spawnedBy.**
  - Evidence: `src/agents/subagents/registry/subagent-list.ts:108-133; owner resolve src/gateway/session-utils-row.ts:228-230`
- **CONSISTENCY RISK: the two identities can disagree. session-graph parent = parentSessionKey??spawnedBy; subtask-run parent = controllerSessionKey??requesterSessionKey. If a child was reparented/forked so parentSessionKey!=requesterSessionKey, the row appears under one parent in the store-index but its command history binds to a different owner, so the subtask card can resolve to a different parent than the sidebar tree.**
  - Evidence: `session-graph src/gateway/session-utils-core.ts:435-437; subtask-run src/agents/subagents/registry/subagent-list.ts:109-110; owner used for card src/gateway/session-utils-row.ts:228-230`
- **READ visibility/ownership (plugin-sdk) treats ownership as spawnedBy OR parentSessionKey OR ownerSessionKey — a THIRD OR-policy independent of the list filter, so which parent 'owns' a child differs between visibility checks and child-index building.**
  - Evidence: `src/plugin-sdk/session-visibility.ts:405-411`
- **LINK-LOSS window: store-only child links (no live subagent run) are kept only transiently (RECENT_ENDED / STALE_STORE_ONLY thresholds). After the subagent run ages out of the registry, the ONLY surviving link is entry.parentSessionKey/spawnedBy; if the child was linked solely by controllerSessionKey (run) and never got parentSessionKey/spawnedBy persisted, the subtask card link is lost once the run expires.**
  - Evidence: `src/gateway/session-utils-core.ts:259-275 (shouldKeepStoreOnlyChildLink); run-link expiry gate at 452-462`
- **WRITE of the run-side link: on restore/cleanup the parentSessionKey for lifecycle events is swarmRequesterSessionKey ?? requesterSessionKey — yet another parent computation distinct from both the store column collapse and controllerSessionKey.**
  - Evidence: `src/agents/subagents/registry/subagent-registry-restore.ts:505; also 505-line restore path 247`
- **canonical-key integrity check enforces column == parentSessionKey??spawnedBy on read; a row whose entry_json parentSessionKey diverges from the promoted column is thrown as needing repair, meaning any writer that skips the collapse (e.g. the raw upsert) can trip repair / entry_valid=0 and temporarily drop the entry from lists.**
  - Evidence: `src/config/sessions/session-canonical-key.ts:172-181; entry_valid gate 160-164`
- **doctor incognito repair rewrites BOTH parent_session_key and spawned_by columns on rename, but as two independent UPDATE...WHERE statements; a child pointing at the renamed parent via one column but not the other (the collapse case) can end up half-renamed, leaving parent_session_key and spawned_by pointing at different parents.**
  - Evidence: `src/commands/doctor-session-incognito-key-repair.ts:287-312`

### Key files

- `/home/kiri/.openclaw/workspace/openclaw-src/src/config/sessions/session-accessor.sqlite-session-row.ts`
- `/home/kiri/.openclaw/workspace/openclaw-src/src/config/sessions/session-accessor.sqlite-canonical-inventory.ts`
- `/home/kiri/.openclaw/workspace/openclaw-src/src/config/sessions/session-canonical-key.ts`
- `/home/kiri/.openclaw/workspace/openclaw-src/src/state/openclaw-agent-db-session-nodes-migration.ts`
- `/home/kiri/.openclaw/workspace/openclaw-src/src/state/openclaw-agent-db-schema.ts`
- `/home/kiri/.openclaw/workspace/openclaw-src/src/gateway/session-utils-list.ts`
- `/home/kiri/.openclaw/workspace/openclaw-src/src/gateway/session-utils-core.ts`
- `/home/kiri/.openclaw/workspace/openclaw-src/src/gateway/session-utils-row.ts`
- `/home/kiri/.openclaw/workspace/openclaw-src/src/agents/subagents/registry/subagent-list.ts`
- `/home/kiri/.openclaw/workspace/openclaw-src/src/agents/subagents/registry/subagent-registry-read.ts`
- `/home/kiri/.openclaw/workspace/openclaw-src/src/agents/subagents/registry/subagent-registry-restore.ts`
- `/home/kiri/.openclaw/workspace/openclaw-src/src/plugin-sdk/session-visibility.ts`
- `/home/kiri/.openclaw/workspace/openclaw-src/src/commands/doctor-session-incognito-key-repair.ts`

### Open questions

- Which UI path actually renders the subtask card's command/tool history — does it call the subagent-run transcript (keyed by child_session_key/controller) or the session-graph child list (keyed by parentSessionKey/spawnedBy)? The bug likely lives at whichever one the card trusts when the two disagree. Needs the card's data-fetch call site (not found in this pass; tests dominate gateway subtask matches).
- At spawn time, is entry.parentSessionKey (or spawnedBy) always stamped on the child equal to the run's controllerSessionKey/requesterSessionKey? If spawn writes only the run-side link and defers/omits the store-side parentSessionKey, the card depends entirely on the transient subagent_runs row and vanishes after expiry.
- Does the raw upsert in openclaw-agent-db-schema.ts:516-539 ever run for spawned children (writing raw parentSessionKey without the ??spawnedBy collapse), and can it desync from the row-builder collapse, tripping the canonical-key repair throw?
- For reparented/forked children, is controllerSessionKey updated to the new parent, or does it stay at the original requester — determining whether the subtask card follows or diverges from the sidebar tree?

---

## Scout: read-scope

**Area:** Transcript read-scope + tools.sessions.visibility gating: can a parent read a child subagent's transcript/command history, and is scope the blocker for the subtask card?

### Findings

- **SessionTranscriptReadScope is a pure storage-layer locator with NO owner/participant/visibility field. It is Omit<SessionTranscriptRuntimeScope,'sessionKey'> plus optional sessionKey + sessionEntry{sessionId}; the underlying runtime scope carries only agentId/env/sessionId/sessionKey/storePath/threadId. Nothing in this type gates who may read.**
  - Evidence: `src/config/sessions/session-accessor.types.ts:153-158 (type); :146-151 (SessionTranscriptRuntimeScope); :135-144 (SessionTranscriptAccessScope base)`
- **Construction/resolution sites for the read scope live entirely in the sqlite scope resolver and are storage-only: resolveSqliteReadScope, resolveSqliteTranscriptReadScope. They resolve agentId + store path from the sessionKey/storePath and throw only on 'cannot resolve agent id' or cross-agent store-path mismatch — never on owner/participant/visibility.**
  - Evidence: `src/config/sessions/session-accessor.sqlite-scope.ts:173-217 (resolveSqliteReadScope), :320-331 (resolveSqliteTranscriptReadScope), :264-285 (resolveSqliteAgentId cross-agent path guard)`
- **The history serve path (chat-history-pages) receives a SessionTranscriptReadScope already-resolved and just reads pages; it performs NO visibility/owner check itself. readScope is built as a bare {agentId,sessionId,sessionKey,storePath}.**
  - Evidence: `src/gateway/server-methods/chat-history-pages.ts:25 (import type SessionTranscriptReadScope), :244 (readScope param), :388-443 (readScope built + passed to readSessionMessagesPageWithStatsAsync)`
- **Visibility gating for reads happens ABOVE the read scope, in the sessions_history tool, keyed on the visibility mode and requesterOwned. It runs resolveEffectiveSessionToolsVisibility -> createSessionVisibilityRowChecker -> resolveSessionToolAccess before any transcript read.**
  - Evidence: `src/agents/tools/sessions-history-tool.ts:441-455 (row checker), :486-498 (resolveSessionToolAccess with requesterOwned:visibleSession.requesterOwned)`
- **tools.sessions.visibility is an enum 'self'|'tree'|'agent'|'all' defaulting to 'tree' = current session + sessions spawned by this session. Invalid/missing coerces to tree.**
  - Evidence: `src/config/types.tools.ts:228 (type SessionsToolsVisibility), :491-505 (config doc + default tree); src/plugin-sdk/session-visibility.ts:109-118 (resolveSessionToolsVisibility default tree)`
- **CORE PREDICATE: a parent legitimately owns (and may read) a child when the child row's spawnedBy or parentSessionKey equals the requester (parent) session key. rowOwnedByRequester = ownerSessionKey|spawnedBy|parentSessionKey === requesterSessionKey.**
  - Evidence: `src/plugin-sdk/session-visibility.ts:405-411 (rowOwnedByRequester)`
- **Under default visibility='tree', the row checker ALLOWS a non-self target that isRequesterOwned (same-agent, or ACP/subagent child namespace even cross-agent). The tree-denial branch only fires when !isRequesterSession AND !isRequesterOwned. So a parent reading its child subagent transcript passes scope.**
  - Evidence: `src/plugin-sdk/session-visibility.ts:447-465 (isRequesterOwned + allow when tree/all), :500-506 (tree denial requires !isRequesterOwned)`
- **The store-side visibility filter used by list/resolve/ownership-lookup applies the SAME parent/child predicate: a session is kept for a spawnedBy filter when entry.spawnedBy === spawnedBy || entry.parentSessionKey === spawnedBy. So the parent key matches the child via parent_session_key.**
  - Evidence: `src/gateway/session-utils-list.ts:271-275 (store-only child link predicate); src/gateway/sessions-resolve.ts:81-96 (isResolvedSessionKeyVisible via filterAndSortSessionEntries with spawnedBy)`
- **requesterOwned for the history read is proven by lookupRequesterSessionOwnership, which probes the store with spawnedBy=requesterSessionKey, i.e. the exact parent->child predicate above; a match yields requesterOwned=true and the read is authorized.**
  - Evidence: `src/agents/tools/sessions-resolution.ts:112-131 (lookupRequesterSessionOwnership probes spawnedBy), :605-606 (requesterOwned OR); src/agents/tools/sessions-access.ts:73-110 (check(true) with spawnedBy widens tree, ownership lookup gate)`
- **CONCLUSION: Scope/visibility is NOT the thing blocking the subtask card. Under the default tree policy the parent is a legitimate owner of the child subagent session (via parent_session_key/spawnedBy) and history-serve grants the read. The subtask card missing child command history is therefore not a read-scope denial — it must originate in the write-side stamping (parent_session_key population) or the subagent-run/display linkage, both outside transcript read-scope.**
  - Evidence: `src/plugin-sdk/session-visibility.ts:457-465 + 500-506 (parent allowed under tree); src/config/sessions/session-accessor.sqlite-scope.ts:173-217 (read scope carries no gate); write-side stamp referenced at src/config/sessions/session-accessor.sqlite-session-row.ts:104 (parent_session_key = parentSessionKey ?? spawnedBy)`

### Key files

- `/home/kiri/.openclaw/workspace/openclaw-src/src/config/sessions/session-accessor.types.ts`
- `/home/kiri/.openclaw/workspace/openclaw-src/src/config/sessions/session-accessor.sqlite-scope.ts`
- `/home/kiri/.openclaw/workspace/openclaw-src/src/config/types.tools.ts`
- `/home/kiri/.openclaw/workspace/openclaw-src/src/plugin-sdk/session-visibility.ts`
- `/home/kiri/.openclaw/workspace/openclaw-src/src/agents/tools/sessions-access.ts`
- `/home/kiri/.openclaw/workspace/openclaw-src/src/agents/tools/sessions-history-tool.ts`
- `/home/kiri/.openclaw/workspace/openclaw-src/src/agents/tools/sessions-resolution.ts`
- `/home/kiri/.openclaw/workspace/openclaw-src/src/gateway/sessions-resolve.ts`
- `/home/kiri/.openclaw/workspace/openclaw-src/src/gateway/session-utils-list.ts`
- `/home/kiri/.openclaw/workspace/openclaw-src/src/gateway/server-methods/chat-history-pages.ts`

### Open questions

- The subtask CARD (UI) may consume a different read path than sessions_history tool — likely the subagent-run display linkage (getSessionDisplaySubagentRunByChildSessionKey / isCurrentSessionChildOwner at session-utils-list.ts:255-264) rather than history-serve. If the card shows the child session at all but omits command/tool-call events, the gap is in which transcript event kinds the card renderer requests, not scope.
- Whether the UI card read passes requesterSessionKey=parent at all, or reads by controllerSessionKey/requesterSessionKey from the subagent-run record; if the run's controllerSessionKey != parent session key, isCurrentSessionChildOwner (session-utils-list.ts:257-264) could fail even though parent_session_key matches — worth confirming in the display-run path, outside this read-scope area.
- Does the transcript read filter tool-call/command events out by event kind on the child store side (transcript_events projection)? Not covered here; that is a projection/read-content question, not a visibility-scope question.

---

## Scout: control-ui

**Area:** Control-UI frontend (ui/src): whether the subtask/subagent card requests the child session's command/tool-call history

### Findings

- **The subtask 'card' detail panel DOES request the child session's full transcript (which carries tool-call/command rows), not just status/label/count. It resolves the transcript session key to the child, then loads history for it.**
  - Evidence: `ui/src/pages/chat/components/chat-task-detail.ts:52-69 (comment 'only the child session is that task's transcript'; transcriptSessionKey = childSessionKey for subagent runtime) then renderTaskTranscript -> readTaskTranscript`
- **For a subagent runtime task the UI keys the history request strictly by childSessionKey (falls back to sessionKey only for non-subagent runtimes).**
  - Evidence: `ui/src/pages/chat/components/chat-task-detail.ts:54-58 (runtime === 'subagent' ? currentTask.childSessionKey : (childSessionKey ?? sessionKey))`
- **The actual gateway call is client.request('chat.history', {sessionKey: <child key>, limit}). This is a full transcript read, not a status/count read.**
  - Evidence: `ui/src/pages/chat/components/chat-task-detail-state.ts:92-96 (client.request<ChatHistoryResult>('chat.history', {sessionKey: state.sessionKey, limit: CHAT_HISTORY_REQUEST_LIMIT})); state.sessionKey set from selection.sessionKey at :139-153; selection.sessionKey passed as transcriptSessionKey from chat-task-detail.ts:68`
- **The returned child messages are rendered through the SAME full chat-thread renderer with showToolCalls enabled, so tool-call/command rows are rendered if present in the messages.**
  - Evidence: `ui/src/pages/chat/components/chat-read-only-transcript.ts:13 renderChatThread(...); :27 showToolCalls: chat.showToolCalls; chat-task-detail.ts:160-170 renderReadOnlyTranscript with messages=load.messages`
- **tool-call-view.ts is only a pure presentation classifier (command/read/edit/write/search/fetch/generic). It performs NO gateway/data fetch; it cannot be the ask-site.**
  - Evidence: `ui/src/lib/chat/tool-call-view.ts:1-24 (module doc 'View-model for tool-call rows'; exports ToolCallView type; no client/request import)`
- **childSessionKey is Optional on the wire (TaskSummary protocol). If the server does not populate it on the task summary, the UI's transcriptSessionKey is empty and the panel falls back to renderTaskFallback which shows only prompt + output (no tool-call history). This is the single UI-side dependency on server data.**
  - Evidence: `packages/gateway-protocol/src/schema/tasks.ts:53 (childSessionKey: Type.Optional(Type.String())); ui fallback path chat-task-detail.ts:66-69,173-189 (renderTaskFallback -> renderTaskInspector shows only prompt/output blocks at :218-227)`
- **The compact requester/child sessionKey (sibling read-visibility seam) is stored server-side as 'ln' on task rows, distinct from parent_session_key on session rows; this is where server population of childSessionKey originates and is out of UI scope.**
  - Evidence: `src/tasks/harness-owned-subagent-task.ts (task.ln usage/comment 'OpenClaw-owned rows always carry ln'); src/tasks/task-registry-state.ts (getTaskRelatedSessionIndexKeys reads task.ln)`
- **The subagent-activity inline card (the non-panel indicator) shows only label/snippet/diffStat/status, NOT full command history; the full history is only in the detail panel opened via onOpenTaskDetail.**
  - Evidence: `ui/src/pages/chat/components/chat-subagent-activity.ts:84-134 (snippet from lastActivity/progressSummary/lastToolName; label from status) and :145-155 onOpenTaskDetail click handler`

### Key files

- `/home/kiri/.openclaw/workspace/openclaw-src/ui/src/pages/chat/components/chat-task-detail.ts`
- `/home/kiri/.openclaw/workspace/openclaw-src/ui/src/pages/chat/components/chat-task-detail-state.ts`
- `/home/kiri/.openclaw/workspace/openclaw-src/ui/src/pages/chat/components/chat-read-only-transcript.ts`
- `/home/kiri/.openclaw/workspace/openclaw-src/ui/src/pages/chat/components/chat-subagent-activity.ts`
- `/home/kiri/.openclaw/workspace/openclaw-src/ui/src/lib/chat/tool-call-view.ts`
- `/home/kiri/.openclaw/workspace/openclaw-src/ui/src/pages/chat/chat-history.ts`
- `/home/kiri/.openclaw/workspace/openclaw-src/ui/src/lib/tasks/task-summary.ts`
- `/home/kiri/.openclaw/workspace/openclaw-src/packages/gateway-protocol/src/schema/tasks.ts`

### Open questions

- Does the server actually populate TaskSummary.childSessionKey (mapped from the compact 'ln') for parent-session subtask rows? If it emits '' / undefined, the UI silently degrades to prompt+output fallback and never asks chat.history — making the gap SERVER-NEVER-ANSWERS despite UI being willing to ask. Needs the src/tasks task-summary serializer confirmed.
- Does the gateway 'chat.history' handler for a child session return tool-call/command messages inline (role toolresult / tool rows) or strip them? The UI passes NO includeTools flag (chat-task-detail-state.ts:92-95) and renders with toolMessages: [] (chat-read-only-transcript.ts:18), relying on tool calls being embedded in the messages array. If chat.history omits tool rows for that session, history renders but shows no commands.
- Confirm canonicalUiSessionKeyForPersistence does not collapse the child key onto the parent pane key (chat-task-detail.ts:59-67); if it did, the transcript branch is skipped in favor of the inspector fallback.

---

## Scout: harness-bench

**Area:** How coding-agent harnesses surface a subagent's tool-call/command history to the parent view (Claude Code, Codex, Cursor, Amp, Goose)

### Findings

- **Claude Code / Agent SDK: default design isolates child. Intermediate tool calls + results stay INSIDE subagent; only final message returns to parent as the Agent-tool result. Parent UI does not persist child tool-call history by default.**
  - Evidence: `https://code.claude.com/docs/en/agent-sdk/subagents ('intermediate tool calls and results stay inside the subagent; only its final message returns to the parent')`
- **Claude Code link model = parent_tool_use_id. Messages emitted from within a subagent context carry parent_tool_use_id; parent detects delegation by watching tool_use blocks named 'Agent' (renamed from 'Task' in v2.1.63). This is the streamed attribution hook.**
  - Evidence: `https://code.claude.com/docs/en/agent-sdk/subagents ('Messages from within a subagent context include a parent_tool_use_id field'; Task->Agent rename note)`
- **Claude Code: child activity IS available as a live stream (complete messages carry parent_tool_use_id) but token-level deltas from subagents are NOT forwarded; SDK stream events are for the main session only. So consumers get message-level (not token-level) child visibility, and must build the UI themselves.**
  - Evidence: `WebSearch summary of platform.claude.com/docs/en/agent-sdk/streaming-output ('stream events are emitted for the main session only; token-level deltas from subagents aren't forwarded... complete messages carry parent_tool_use_id')`
- **Claude Code: child transcripts persist as SEPARATE files, resumable on demand. Agent tool result returns agentId:<id>; resume via resume:sessionId reloads full child history incl. all tool calls/results. So history is fetch/resume-on-demand, not merged into parent transcript.**
  - Evidence: `https://code.claude.com/docs/en/agent-sdk/subagents ('Subagent transcripts are stored in separate files and persist independently'; 'A resumed subagent retains its full conversation history, including all previous tool calls')`
- **Claude Code TUI gap: terminal UI does not surface which model/subagent tool progress even though tasks/subagents are tracked; open feature requests ask for parity with third-party tools that show subagent progress.**
  - Evidence: `https://github.com/anthropics/claude-code/issues/48246 (Feature request: show agent/subagent task progress in terminal UI, parity with third-party tools); https://github.com/anthropics/claude-code/issues/24094 (show subagent model in tool-call UI)`
- **OpenAI Codex: subagent is a separate Codex agent thread. Default child history = InitialHistory::New (fresh); open issue requests letting the PARENT choose to pass full history at spawn. No native parent UI for live child tool-calls yet.**
  - Evidence: `https://github.com/openai/codex/issues/12431 ('Allow the parent agent to decide whether to send the full history when spawning a sub-agent'; InitialHistory::New default)`
- **OpenAI Codex: no unified parent view of child sessions today. Users track parallel/subagent sessions manually; open issue asks for an 'Agent View' TUI that discovers app-server sessions and persisted subagent history (i.e. fetch-on-demand from persisted history, not live parent stream).**
  - Evidence: `https://github.com/openai/codex/issues/22321 ('Add an Agent View for managing multiple Codex agents from the TUI'; 'persisted subagent history, not only sessions spawned during current TUI lifetime')`
- **Cursor: foreground subagent -> its tool calls / intermediate results / final text ARE visible inline in the conversation (streamed to UI). Background subagent -> only a completion notification surfaces to UI; full output invisible in UI.**
  - Evidence: `https://cursor.com/docs/subagents.md (foreground blocks and returns result; background returns immediately) + WebSearch summary of same`
- **Cursor link model = filesystem. Background subagents WRITE output to ~/.cursor/subagents/; the parent agent READS those files to check progress. So parent visibility to background children is fetch-on-demand via disk polling, not a live stream.**
  - Evidence: `https://cursor.com/docs/subagents ('Background subagents write output to ~/.cursor/subagents/. The parent agent can read these files to check progress')`
- **Cursor known leak: background subagent tool-call log is exposed to the PARENT AGENT via the getOutput call even though hidden from the UI — reported as a bug that breaks intended context isolation.**
  - Evidence: `WebSearch summary re Cursor + https://github.com/anthropics/claude-code/issues/14118 ('[Bug] Background subagent tool calls exposed in parent context window')`
- **Amp (Sourcegraph) link model = SubagentSessionInfo stored in the parent's tool-call metadata (SUBAGENT_SESSION_INFO_META_KEY). It records the child session ID + message indices, so parent knows exactly where in the child's history the delegated turn occurred — enabling on-demand navigation into the child thread.**
  - Evidence: `https://deepwiki.com/zed-industries/zed/8.6-subagent-and-thread-hierarchy ('SubagentSessionInfo tracks child session ID and message indices'; 'know exactly where in the child's history the delegated turn occurred')`
- **Amp/Zed: children are real threads kept in ThreadStore but FILTERED out of the primary UI thread list to keep it clean; child is a first-class resumable thread reachable via SpawnAgentTool/create_thread. Depth capped MAX_SUBAGENT_DEPTH=1 (no nested subagents).**
  - Evidence: `https://deepwiki.com/zed-industries/zed/8.6-subagent-and-thread-hierarchy ('ThreadStore filters subagents from the primary UI thread list'; 'MAX_SUBAGENT_DEPTH = 1'; SpawnAgentTool aliased create_thread)`
- **Goose: strongest live-surfacing. Main session SHOWS subagent tool calls in REAL TIME, labeled with an identifier like '[subagent:16] text_editor | developer'. Default return mode is 'all subagent info in main session'; user can opt into 'Summary Only'.**
  - Evidence: `https://goose-docs.ai/docs/guides/context-engineering/subagents/ ('you can see the subagent's tool calls in real-time'; tag '[subagent:16] text_editor | developer'; 'All subagent information provided in main session' default vs 'Summary Only')`
- **Goose architecture: subagents = task definitions in a TasksManager, each spawned as a separate isolated goose instance; results aggregated back to parent. Full child conversation/tool history stays in the child session; parent gets task results + summaries (plus the live tool-call echo). 5-min default timeout -> failed/timed-out child yields no output.**
  - Evidence: `WebSearch summary of block.github.io/goose subagents-vs-subrecipes + https://goose-docs.ai/docs/guides/context-engineering/subagents/ ('If a subagent fails or times out (5-minute default), you will receive no output')`
- **Cross-harness pattern for benchmarking: two dominant link models — (a) ID/metadata pointer into a separately-stored child transcript, fetched/resumed on demand (Claude Code parent_tool_use_id + separate files; Amp SubagentSessionInfo; Codex persisted history); (b) filesystem output files polled by parent (Cursor ~/.cursor/subagents/). Live streaming of child tool-calls into the parent surface is the exception (Goose does it; Claude Code streams message-level not token-level; Cursor only in foreground).**
  - Evidence: `Synthesis of the above primary sources: code.claude.com/docs/en/agent-sdk/subagents, cursor.com/docs/subagents, deepwiki zed 8.6, goose-docs subagents, github.com/openai/codex/issues/22321`

### Key files

- `https://code.claude.com/docs/en/agent-sdk/subagents`
- `https://cursor.com/docs/subagents`
- `https://deepwiki.com/zed-industries/zed/8.6-subagent-and-thread-hierarchy`
- `https://goose-docs.ai/docs/guides/context-engineering/subagents/`
- `https://github.com/openai/codex/issues/12431`
- `https://github.com/openai/codex/issues/22321`
- `https://github.com/anthropics/claude-code/issues/48246`

### Open questions

- Does Claude Code's interactive TUI (not SDK) render child tool-calls live nested under the Task/Agent call, or only a spinner? Open issue #48246 implies not fully — needs confirmation on current TUI build.
- Exact Amp UI affordance: can a user click from the parent Task tool-call metadata into the child thread, or is SubagentSessionInfo internal-only? DeepWiki did not confirm the UI navigation path.
- Codex: is there ANY current live parent-side surfacing of child tool calls, or is it entirely post-hoc via persisted session files? Issue #22321 suggests no unified view exists yet.
- Cursor foreground: are child tool-calls rendered as a nested/collapsible sub-thread in the UI or flattened inline into the parent transcript?
- Goose: is the real-time '[subagent:N]' echo a true stream or periodic poll of the TasksManager? Docs say real-time but don't specify transport.

---

