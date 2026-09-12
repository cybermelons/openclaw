/**
 * Single surface naming which request params and nested payload shapes carry
 * client-supplied session keys and mutation targets, per gateway method. Shared
 * by the gateway request boundary guard (key presence/shape validation before
 * dispatch) and by session mutation authorization (resolving what a request
 * actually mutates) so the two cannot drift on which methods or nested shapes
 * carry a session key.
 */
import { asOptionalRecord } from "@openclaw/normalization-core/record-coerce";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { verifyBoardViewTicket } from "./board-view-ticket.js";
import type { GatewayRequestContext } from "./server-methods/types.js";
import { resolveSessionGroupMutationTargetsByName } from "./session-group-mutation-targets.js";
import {
  readSessionSharingStringParam as readStringParam,
  type SessionMutationTarget,
} from "./session-sharing-target-input.js";

/**
 * issue #124 Layer 1: names which request param carries the client-supplied session key
 * per method, so the gateway request boundary can validate it before dispatch. Module-private:
 * readClientSessionKeys and resolveSessionMutationTargets are the only readers, and both look up
 * one method at a time, so nothing outside this file needs the raw Map. A method missing here
 * silently skips both target resolution and key validation, which is why
 * session-key-boundary.layer1.test.ts cross-checks every entry against the protocol schemas
 * instead of trusting this table. "sessions.patchMany" carries its keys at a nested `targets[].key` array
 * instead of a flat param, so it has no entry here; readClientSessionKeys below special-cases it
 * alongside this table so that method still gets boundary key validation.
 */
const SESSION_KEY_PARAM_BY_METHOD = new Map<string, "key" | "sessionKey">([
  ["agent", "sessionKey"],
  ["board.event", "sessionKey"],
  ["board.update", "sessionKey"],
  ["board.widget.grant", "sessionKey"],
  ["board.widget.put", "sessionKey"],
  ["chat.abort", "sessionKey"],
  ["chat.inject", "sessionKey"],
  ["chat.send", "sessionKey"],
  ["message.action", "sessionKey"],
  ["plugins.sessionAction", "sessionKey"],
  ["progressCard.get", "sessionKey"],
  ["progressCard.put", "sessionKey"],
  ["send", "sessionKey"],
  ["session.discussion.open", "sessionKey"],
  ["sessions.abort", "key"],
  ["sessions.compaction.branch", "key"],
  ["sessions.compaction.restore", "key"],
  ["sessions.compact", "key"],
  ["sessions.create", "key"],
  ["sessions.delete", "key"],
  ["sessions.dispatch", "key"],
  ["sessions.files.set", "sessionKey"],
  ["sessions.fork", "sessionKey"],
  ["sessions.patch", "key"],
  ["sessions.pluginPatch", "key"],
  ["sessions.reclaim", "key"],
  ["sessions.reset", "key"],
  ["sessions.rewind", "sessionKey"],
  ["sessions.send", "key"],
  ["sessions.steer", "key"],
  ["sessions.branches.switch", "sessionKey"],
  ["tools.invoke", "sessionKey"],
]);

export const REQUIRED_SESSION_TARGET_METHODS = new Set([
  "board.action",
  "board.event",
  "board.update",
  "board.widget.grant",
  "board.widget.put",
  "chat.abort",
  "chat.inject",
  "chat.send",
  "progressCard.get",
  "progressCard.put",
  "session.discussion.open",
  "sessions.abort",
  "sessions.branches.switch",
  "sessions.compact",
  "sessions.compaction.branch",
  "sessions.compaction.restore",
  "sessions.delete",
  "sessions.dispatch",
  "sessions.files.set",
  "sessions.fork",
  "sessions.groups.delete",
  "sessions.groups.rename",
  "sessions.groups.update",
  "sessions.patch",
  "sessions.pluginPatch",
  "sessions.reclaim",
  "sessions.reset",
  "sessions.rewind",
  "sessions.send",
  "sessions.steer",
]);

function resolveSessionGroupMutationTargets(params: {
  getCfg: () => OpenClawConfig;
  requestParams: unknown;
}): SessionMutationTarget[] | undefined {
  const groupName = readStringParam(params.requestParams, "name");
  return groupName
    ? (resolveSessionGroupMutationTargetsByName(params.getCfg()).get(groupName) ?? [])
    : undefined;
}

function resolveApprovalSessionTarget(
  method: string,
  params: unknown,
  context: GatewayRequestContext,
): SessionMutationTarget | undefined {
  const id = readStringParam(params, "id");
  if (!id) {
    return undefined;
  }
  const kind = readStringParam(params, "kind");
  const manager =
    method === "plugin.approval.resolve" || kind === "plugin"
      ? context.pluginApprovalManager
      : method === "approval.resolve" && kind === "system-agent"
        ? context.systemAgentApprovalManager
        : context.execApprovalManager;
  const resolvedId = manager?.lookupApprovalId(id, { includeResolved: true });
  const recordId =
    resolvedId?.kind === "exact" || resolvedId?.kind === "prefix" ? resolvedId.id : id;
  const request = manager?.getSnapshot(recordId)?.request;
  const sessionKey = readStringParam(request, "sessionKey");
  const agentId = readStringParam(request, "agentId");
  return sessionKey
    ? {
        sessionKey,
        ...(agentId ? { agentId } : {}),
      }
    : undefined;
}

/**
 * Reads "sessions.patchMany" targets from its nested `targets[].key` array. Shared by
 * resolveSessionMutationTargets (authorization) and readClientSessionKeys (boundary
 * validation) so the two cannot drift on which nested keys count as client-supplied.
 */
function resolvePatchManyMutationTargets(
  requestParams: unknown,
): SessionMutationTarget[] | undefined {
  const targets = asOptionalRecord(requestParams)?.targets;
  return Array.isArray(targets)
    ? targets.slice(0, 101).flatMap((target): SessionMutationTarget[] => {
        const sessionKey = readStringParam(target, "key");
        const agentId = readStringParam(target, "agentId");
        return sessionKey ? [{ sessionKey, ...(agentId ? { agentId } : {}) }] : [];
      })
    : undefined;
}

/**
 * issue #127: returns every client-supplied session key a request carries, so the gateway
 * request boundary can validate all of them before dispatch — including "sessions.patchMany",
 * whose keys live at nested `targets[].key` and cannot be addressed by the flat
 * SESSION_KEY_PARAM_BY_METHOD table. A method missing from both surfaces returns no keys.
 */
export function readClientSessionKeys(method: string, requestParams: unknown): string[] {
  if (method === "sessions.patchMany") {
    return (resolvePatchManyMutationTargets(requestParams) ?? []).map(
      (target) => target.sessionKey,
    );
  }
  const field = SESSION_KEY_PARAM_BY_METHOD.get(method);
  const key = field ? readStringParam(requestParams, field) : undefined;
  return key ? [key] : [];
}

export function resolveSessionMutationTargets(params: {
  method: string;
  requestParams: unknown;
  context: GatewayRequestContext;
  getCfg: () => OpenClawConfig;
}): SessionMutationTarget[] | undefined {
  if (params.method === "sessions.patchMany") {
    return resolvePatchManyMutationTargets(params.requestParams);
  }
  if (
    params.method === "sessions.groups.rename" ||
    params.method === "sessions.groups.delete" ||
    params.method === "sessions.groups.update"
  ) {
    return resolveSessionGroupMutationTargets({
      getCfg: params.getCfg,
      requestParams: params.requestParams,
    });
  }
  if (
    params.method === "exec.approval.resolve" ||
    params.method === "plugin.approval.resolve" ||
    params.method === "approval.resolve"
  ) {
    const target = resolveApprovalSessionTarget(
      params.method,
      params.requestParams,
      params.context,
    );
    return target ? [target] : undefined;
  }
  const field = SESSION_KEY_PARAM_BY_METHOD.get(params.method);
  const directKey = field ? readStringParam(params.requestParams, field) : undefined;
  if (!directKey && (params.method === "board.event" || params.method === "board.action")) {
    const ticket = readStringParam(params.requestParams, "ticket");
    const claims = ticket ? verifyBoardViewTicket(ticket) : undefined;
    if (!claims) {
      return undefined;
    }
    const requestedAgentId = readStringParam(params.requestParams, "agentId");
    if (requestedAgentId && requestedAgentId !== claims.agentId) {
      return undefined;
    }
    return [
      {
        sessionKey: claims.sessionKey,
        ...(claims.agentId ? { agentId: claims.agentId } : {}),
      },
    ];
  }
  if (directKey || params.method !== "sessions.abort") {
    const agentId = readStringParam(params.requestParams, "agentId");
    return directKey
      ? [
          {
            sessionKey: directKey,
            ...(agentId ? { agentId } : {}),
          },
        ]
      : undefined;
  }
  const runId = readStringParam(params.requestParams, "runId");
  const run = runId ? params.context.chatAbortControllers.get(runId) : undefined;
  return run
    ? [{ sessionKey: run.sessionKey, ...(run.agentId ? { agentId: run.agentId } : {}) }]
    : undefined;
}
