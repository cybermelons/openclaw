// Gateway methods that shell out to workspace-local tooling (e.g. bam).
import { realpath } from "node:fs/promises";
import path from "node:path";
import { normalizeOptionalString } from "@openclaw/normalization-core/string-coerce";
import {
  isCloudWorkerPlacementState,
  validateWorkspaceRunBamParams,
} from "../../../packages/gateway-protocol/src/index.js";
import { resolveAgentWorkspaceDir } from "../../agents/agent-scope.js";
import { runExec } from "../../process/exec.js";
import { normalizeAgentId, parseAgentSessionKey } from "../../routing/session-key.js";
import { resolveRequestedSessionAgentId } from "../session-request-agent.js";
import { loadGatewaySessionEntryReadOnly } from "../session-utils.js";
import type { GatewayRequestHandlers } from "./types.js";
import { assertValidParams } from "./validation.js";

/** Gateway handlers for shelling out to workspace-local editor tooling. */
export const workspaceHandlers: GatewayRequestHandlers = {
  "workspace.runBam": async ({ params, respond, context }) => {
    if (!assertValidParams(params, validateWorkspaceRunBamParams, "workspace.runBam", respond)) {
      return;
    }

    const requestedAgent = resolveRequestedSessionAgentId(
      context.getRuntimeConfig(),
      params.sessionKey,
      undefined,
    );
    if (!requestedAgent.ok) {
      respond(false, undefined, requestedAgent.error);
      return;
    }
    const agentId = requestedAgent.agentId;

    const loaded = loadGatewaySessionEntryReadOnly(params.sessionKey, { agentId });
    if (!loaded.entry?.sessionId) {
      respond(true, {
        ok: false,
        path: params.path,
        error: "No workspace root is available for this session.",
      });
      return;
    }
    const resolvedAgentId = normalizeAgentId(
      loaded.agentId ??
        parseAgentSessionKey(loaded.canonicalKey)?.agentId ??
        agentId ??
        parseAgentSessionKey(params.sessionKey)?.agentId,
    );
    const spawnedCwd = normalizeOptionalString(loaded.entry.spawnedCwd);
    const spawnedWorkspaceDir = normalizeOptionalString(loaded.entry.spawnedWorkspaceDir);
    const configuredWorkspaceDir =
      spawnedCwd || spawnedWorkspaceDir
        ? undefined
        : normalizeOptionalString(resolveAgentWorkspaceDir(loaded.cfg, resolvedAgentId));
    const workspaceRoot = spawnedWorkspaceDir ?? spawnedCwd ?? configuredWorkspaceDir;
    if (!workspaceRoot) {
      respond(true, {
        ok: false,
        path: params.path,
        error: "No workspace root is available for this session.",
      });
      return;
    }
    if (loaded.entry.execNode) {
      respond(true, {
        ok: false,
        path: params.path,
        error: "Cannot bam this file because the session runs on an exec node.",
      });
      return;
    }
    const placement = loaded.entry.sessionId
      ? context.workerSessionPlacementService
          ?.getMany([loaded.entry.sessionId])
          .get(loaded.entry.sessionId)
      : undefined;
    if (isCloudWorkerPlacementState(placement?.state)) {
      respond(true, {
        ok: false,
        path: params.path,
        error: `Cannot bam this file because the session runs remotely (${placement.state}).`,
      });
      return;
    }

    const candidate = path.resolve(workspaceRoot, params.path);
    let resolved: string;
    try {
      resolved = await realpath(candidate);
    } catch {
      try {
        resolved = path.join(await realpath(path.dirname(candidate)), path.basename(candidate));
      } catch (err) {
        respond(true, {
          ok: false,
          path: params.path,
          error: `Failed to resolve path: ${err instanceof Error ? err.message : String(err)}`,
        });
        return;
      }
    }
    const rel = path.relative(workspaceRoot, resolved);
    if (rel.startsWith("..") || path.isAbsolute(rel)) {
      respond(true, { ok: false, path: params.path, error: "path escapes workspace" });
      return;
    }

    const line = params.line;
    try {
      await runExec("tools/bam", [resolved, ...(line != null ? ["--line", String(line)] : [])], {
        cwd: workspaceRoot,
        timeoutMs: 10_000,
        logOutput: false,
      });
      respond(true, { ok: true, path: resolved });
    } catch (err) {
      const errorWithOutput = err as { stderr?: unknown; message?: unknown } | undefined;
      const raw = errorWithOutput?.stderr ?? errorWithOutput?.message ?? String(err);
      respond(true, { ok: false, path: params.path, error: String(raw).slice(0, 500) });
    }
  },
};
