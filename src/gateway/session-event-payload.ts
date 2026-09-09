import { sessionEntryForkedFromParent } from "../config/sessions/session-entry-lineage.js";
import type { GatewaySessionRow } from "./session-utils.js";

/**
 * Project a catalog-less session row for websocket merge events.
 * Picker metadata comes from catalog-backed list/patch responses; emitting a
 * locally reconstructed subset here would replace richer client state.
 */
export function buildGatewaySessionEventRow(
  sessionRow: GatewaySessionRow,
  options: { lifecycle?: boolean } = {},
): GatewaySessionRow {
  const session = { ...sessionRow };
  delete session.thinkingLevels;
  delete session.thinkingOptions;
  delete session.thinkingDefault;
  if (options.lifecycle) {
    delete session.modelProvider;
    delete session.model;
    delete session.agentRuntime;
    if (session.totalTokensFresh !== true) {
      delete session.totalTokens;
      delete session.totalTokensFresh;
      delete session.contextTokens;
      delete session.estimatedCostUsd;
    }
  }
  return session;
}

export function buildGatewaySessionEventFields(params: {
  sessionRow: GatewaySessionRow;
  agentId?: string;
  label?: string;
  displayName?: string;
  parentSessionKey?: string;
  hasActiveRun?: boolean;
  activeRunIds?: string[];
}): Record<string, unknown> {
  const { sessionRow } = params;
  const omitUnscopedGlobalGoal = sessionRow.key === "global" && !params.agentId;
  // Build the projected patch, then strip every `undefined` key below. Omission
  // means "no information" — the client keeps its prior value (issue #105). A
  // field must never serialize `undefined` to `null`: a `null` reaches the wire
  // only for a genuine clear, and the client honors `null` as a delete signal
  // only for the shared SESSION_EVENT_TOMBSTONE_FIELDS list. Non-null defaults
  // (`?? []`, `?? 0`, `?? false`) are safe: they produce a value, not a tombstone.
  const fields: Record<string, unknown> = {
    // updatedAt is legitimately nullable, but a null carries no update, so keep
    // the prior behavior of omitting it (a null becomes undefined, then stripped).
    updatedAt: sessionRow.updatedAt ?? undefined,
    sessionId: sessionRow.sessionId,
    createdActor: sessionRow.createdActor,
    owner: sessionRow.owner,
    participants: sessionRow.participants ?? [],
    participantCount: sessionRow.participantCount ?? 0,
    kind: sessionRow.kind,
    visibility: sessionRow.visibility,
    channel: sessionRow.channel,
    subject: sessionRow.subject,
    groupChannel: sessionRow.groupChannel,
    space: sessionRow.space,
    chatType: sessionRow.chatType,
    origin: sessionRow.origin,
    archived: sessionRow.archived ?? false,
    archivedAt: sessionRow.archivedAt,
    archivedBy: sessionRow.archivedBy,
    pinned: sessionRow.pinned ?? false,
    pinnedAt: sessionRow.pinnedAt,
    unread: sessionRow.unread ?? false,
    lastReadAt: sessionRow.lastReadAt,
    agentStatus: sessionRow.agentStatus,
    observerDigest: sessionRow.observerDigest,
    lastActivityAt: sessionRow.lastActivityAt,
    spawnedBy: sessionRow.spawnedBy,
    controlOwnerSessionKey: sessionRow.controlOwnerSessionKey,
    swarmGroupId: sessionRow.swarmGroupId,
    spawnedWorkspaceDir: sessionRow.spawnedWorkspaceDir,
    spawnedCwd: sessionRow.spawnedCwd,
    permissionMode: sessionRow.permissionMode,
    ...(sessionRow.permissionMode !== undefined && sessionRow.sessionRoot !== undefined
      ? { sessionRoot: sessionRow.sessionRoot }
      : {}),
    forkedFromParent: sessionEntryForkedFromParent(sessionRow) ? true : undefined,
    spawnDepth: sessionRow.spawnDepth,
    subagentRole: sessionRow.subagentRole,
    subagentControlScope: sessionRow.subagentControlScope,
    createdVia: sessionRow.createdVia,
    createdAt: sessionRow.createdAt,
    forkSource: sessionRow.forkSource,
    previousSessionId: sessionRow.previousSessionId,
    label: params.label ?? sessionRow.label,
    icon: sessionRow.icon,
    // Tombstone field: an explicit null clears a set category on the client.
    category: sessionRow.category,
    displayName: params.displayName ?? sessionRow.displayName,
    deliveryContext: sessionRow.deliveryContext,
    parentSessionKey: params.parentSessionKey ?? sessionRow.parentSessionKey,
    childSessions: sessionRow.childSessions,
    // Tombstone field: an explicit null clears a thinking-level override.
    thinkingLevel: sessionRow.thinkingLevel,
    fastMode: sessionRow.fastMode,
    toolOverrides: sessionRow.toolOverrides,
    verboseLevel: sessionRow.verboseLevel,
    reasoningLevel: sessionRow.reasoningLevel,
    elevatedLevel: sessionRow.elevatedLevel,
    sendPolicy: sessionRow.sendPolicy,
    systemSent: sessionRow.systemSent,
    abortedLastRun: sessionRow.abortedLastRun,
    restartRecoveryStatus: sessionRow.restartRecoveryStatus,
    inputTokens: sessionRow.inputTokens,
    outputTokens: sessionRow.outputTokens,
    lastChannel: sessionRow.lastChannel,
    lastTo: sessionRow.lastTo,
    lastAccountId: sessionRow.lastAccountId,
    lastThreadId: sessionRow.lastThreadId,
    totalTokens: sessionRow.totalTokens,
    totalTokensFresh: sessionRow.totalTokensFresh,
    goal: omitUnscopedGlobalGoal ? undefined : sessionRow.goal,
    contextTokens: sessionRow.contextTokens,
    estimatedCostUsd: sessionRow.estimatedCostUsd,
    responseUsage: sessionRow.responseUsage,
    effectiveResponseUsage: sessionRow.effectiveResponseUsage,
    modelProvider: sessionRow.modelProvider,
    model: sessionRow.model,
    agentRuntime: sessionRow.agentRuntime,
    status: sessionRow.status,
    // Tombstone field: an explicit null clears the previous run's failure reason.
    lastRunError: sessionRow.lastRunError,
    // Tombstone field: `?? false` drops the flag; a genuine null also clears it.
    hasAutomation: sessionRow.hasAutomation ?? false,
    ...(params.hasActiveRun === undefined ? {} : { hasActiveRun: params.hasActiveRun }),
    ...(params.activeRunIds === undefined ? {} : { activeRunIds: params.activeRunIds }),
    startedAt: sessionRow.startedAt,
    endedAt: sessionRow.endedAt,
    runtimeMs: sessionRow.runtimeMs,
    compactionCheckpointCount: sessionRow.compactionCheckpointCount,
    latestCompactionCheckpoint: sessionRow.latestCompactionCheckpoint,
  };
  // Partial-patch invariant: drop every undefined key so an absent source value
  // is absent on the wire, never a null tombstone. A null survives only for a
  // genuine clear (honored by the client for tombstone fields only).
  for (const key of Object.keys(fields)) {
    if (fields[key] === undefined) {
      delete fields[key];
    }
  }
  return fields;
}
