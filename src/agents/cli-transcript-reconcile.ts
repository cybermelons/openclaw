/**
 * Reconciles a bound Claude CLI session's jsonl transcript into SQLite
 * transcript_events so resumed/restarted threads never forget turns that
 * only ever existed in the ephemeral jsonl reader.
 */
import fs from "node:fs";
import { normalizeOptionalString } from "@openclaw/normalization-core/string-coerce";
import type { SessionEntry } from "../config/sessions.js";
import { getCliSessionBinding } from "../config/sessions/cli-session-binding.js";
import { applySessionEntryReplacements } from "../config/sessions/session-accessor.sqlite-projection.js";
import {
  resolveSqliteScope,
  runExclusiveSqliteSessionWrite,
  toDatabaseOptions,
} from "../config/sessions/session-accessor.sqlite-scope.js";
import { appendTranscriptMessageInTransaction } from "../config/sessions/session-accessor.sqlite-transcript-message-append.js";
import {
  CLAUDE_CLI_PROVIDER,
  readClaudeCliSessionMessages,
  resolveClaudeCliSessionFilePath,
} from "../gateway/cli-session-history.claude.js";
import { createSubsystemLogger } from "../logging/subsystem.js";
import { runOpenClawAgentWriteTransaction } from "../state/openclaw-agent-db.js";
import { setCliSessionBinding } from "./cli-session.js";

const log = createSubsystemLogger("agents/cli-transcript-reconcile");

export type ReconcileCliTranscriptParams = {
  entry: SessionEntry;
  sessionKey: string;
  storePath?: string;
  agentId?: string;
  env?: NodeJS.ProcessEnv;
  homeDir?: string;
  reason?: "recovery" | "resume";
};

export type ReconcileCliTranscriptResult =
  | { status: "skipped"; reason: "no-binding" | "no-jsonl" | "error" }
  | { status: "noop" }
  | { status: "reconciled"; backfilled: number };

function readMessageExternalId(message: unknown): string | undefined {
  if (!message || typeof message !== "object") {
    return undefined;
  }
  const meta = (message as Record<string, unknown>)["__openclaw"];
  if (!meta || typeof meta !== "object") {
    return undefined;
  }
  const externalId = (meta as Record<string, unknown>).externalId;
  return typeof externalId === "string" && externalId.trim() ? externalId : undefined;
}

/**
 * Reads a bound Claude CLI session's jsonl transcript and persists any turns
 * missing from SQLite transcript_events. Idempotent (dedupes by eventId) and
 * O(1) on the happy path via an mtime watermark stored on the binding. Never
 * throws — safe to call from both recovery-finalize and history-serve paths.
 */
export async function reconcileCliTranscript(
  params: ReconcileCliTranscriptParams,
): Promise<ReconcileCliTranscriptResult> {
  try {
    const binding = getCliSessionBinding(params.entry, CLAUDE_CLI_PROVIDER);
    const cliSessionId = normalizeOptionalString(binding?.sessionId);
    if (!binding || !cliSessionId) {
      return { status: "skipped", reason: "no-binding" };
    }

    const jsonlPath = resolveClaudeCliSessionFilePath({
      cliSessionId,
      ...(params.homeDir ? { homeDir: params.homeDir } : {}),
    });
    if (!jsonlPath) {
      log.warn(
        `no claude-cli jsonl found for bound session ${cliSessionId} (${params.sessionKey})`,
      );
      return { status: "skipped", reason: "no-jsonl" };
    }

    let mtimeMs: number;
    try {
      mtimeMs = fs.statSync(jsonlPath).mtimeMs;
    } catch {
      return { status: "skipped", reason: "no-jsonl" };
    }

    if (binding.lastReconciledMtimeMs === mtimeMs) {
      return { status: "noop" };
    }

    const messages = readClaudeCliSessionMessages({
      cliSessionId,
      ...(params.homeDir ? { homeDir: params.homeDir } : {}),
      localSessionId: params.entry.sessionId,
      ...(binding.reseedReceipt ? { reseedReceipt: binding.reseedReceipt } : {}),
    });

    const resolved = resolveSqliteScope({
      ...(params.agentId ? { agentId: params.agentId } : {}),
      ...(params.env ? { env: params.env } : {}),
      sessionKey: params.sessionKey,
      ...(params.storePath ? { storePath: params.storePath } : {}),
    });

    let backfilled = 0;
    await runExclusiveSqliteSessionWrite(resolved, async () => {
      runOpenClawAgentWriteTransaction((database) => {
        const transcriptScope = { ...resolved, sessionId: params.entry.sessionId };
        for (const message of messages) {
          const uuid = readMessageExternalId(message);
          if (!uuid) {
            // No stable external id to dedup on: skip rather than fabricate one.
            continue;
          }
          const result = appendTranscriptMessageInTransaction(database, transcriptScope, {
            message,
            eventId: `claude-cli:${cliSessionId}:${uuid}`,
          });
          if (result?.appended) {
            backfilled += 1;
          }
        }
      }, toDatabaseOptions(resolved));
    });

    // Persist the watermark via a read-current/CAS replacement rather than
    // writing the caller's (possibly stale) `entry` snapshot directly, so a
    // concurrent mutation to unrelated fields on this session can't be
    // clobbered. Best-effort: if storePath is unavailable, skip persisting —
    // the next call simply re-parses the jsonl (still correct, just not O(1)).
    if (params.storePath) {
      await applySessionEntryReplacements({
        agentId: resolved.agentId,
        sessionKeys: [params.sessionKey],
        storePath: params.storePath,
        update: (entries) => {
          const current = entries.find((candidate) => candidate.sessionKey === params.sessionKey);
          if (!current || current.entry.sessionId !== params.entry.sessionId) {
            return { result: undefined };
          }
          const currentBinding = getCliSessionBinding(current.entry, CLAUDE_CLI_PROVIDER);
          if (!currentBinding || currentBinding.sessionId !== cliSessionId) {
            return { result: undefined };
          }
          setCliSessionBinding(current.entry, CLAUDE_CLI_PROVIDER, {
            ...currentBinding,
            lastReconciledMtimeMs: mtimeMs,
          });
          return {
            result: undefined,
            replacements: [{ entry: current.entry, sessionKey: current.sessionKey }],
          };
        },
      });
    }

    if (backfilled > 0) {
      log.info(
        `reconciled cli transcript: ${backfilled} turns backfilled for ${params.sessionKey} (${
          params.reason ?? "resume"
        })`,
      );
    }
    return { status: "reconciled", backfilled };
  } catch (error) {
    log.warn(`cli transcript reconcile failed for ${params.sessionKey}: ${String(error)}`);
    return { status: "skipped", reason: "error" };
  }
}
