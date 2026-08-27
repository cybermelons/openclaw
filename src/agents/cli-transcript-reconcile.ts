/**
 * Reconciles a bound Claude CLI session's jsonl transcript into SQLite
 * transcript_events so resumed/restarted threads never forget turns that
 * only ever existed in the ephemeral jsonl reader.
 */
import fs from "node:fs";
import { asFiniteNumber } from "@openclaw/normalization-core/number-coercion";
import {
  normalizeOptionalString,
  readStringValue,
} from "@openclaw/normalization-core/string-coerce";
import type { SessionEntry } from "../config/sessions.js";
import { getCliSessionBinding } from "../config/sessions/cli-session-binding.js";
import { readRecentSessionTranscriptMessageEvents } from "../config/sessions/session-accessor.sqlite-active-events.js";
import { applySessionEntryReplacements } from "../config/sessions/session-accessor.sqlite-projection.js";
import {
  readSessionResumeEpoch,
  writeSessionResumeEpoch,
} from "../config/sessions/session-accessor.sqlite-resume-epoch-store.js";
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
import { extractComparableText } from "../gateway/cli-session-history.merge.js";
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

type LocalTailEntry = {
  role: string | undefined;
  text: string | undefined;
};

function readMessageRole(message: unknown): string | undefined {
  if (!message || typeof message !== "object") {
    return undefined;
  }
  return readStringValue((message as { role?: unknown }).role);
}

function readMessageTimestampMs(message: unknown): number | undefined {
  if (!message || typeof message !== "object") {
    return undefined;
  }
  return asFiniteNumber((message as { timestamp?: unknown }).timestamp);
}

/**
 * Reads the session's recent local transcript tail for backfill gating. The
 * live mirror already persists normal turns, so the drain must only add rows
 * the local store has no representation of.
 */
function readLocalTranscriptTail(scope: {
  agentId?: string;
  storePath?: string;
  sessionKey?: string;
  sessionId: string;
}): { entries: LocalTailEntry[]; lastTimestampMs: number | undefined } {
  const page = readRecentSessionTranscriptMessageEvents(scope, {
    maxBytes: 4 * 1024 * 1024,
    maxLines: 400,
    maxMessages: 200,
  });
  const entries: LocalTailEntry[] = [];
  let lastTimestampMs: number | undefined;
  for (const entry of page.events) {
    const event = entry.event as { message?: unknown } | undefined;
    const message = event && typeof event === "object" ? event.message : undefined;
    if (message === undefined) {
      continue;
    }
    entries.push({ role: readMessageRole(message), text: extractComparableText(message) });
    const timestampMs = readMessageTimestampMs(message);
    if (timestampMs !== undefined) {
      lastTimestampMs =
        lastTimestampMs === undefined ? timestampMs : Math.max(lastTimestampMs, timestampMs);
    }
  }
  return { entries, lastTimestampMs };
}

/**
 * True when the local tail already represents this jsonl message. Two guards:
 * a timestamp watermark (rows at or before the newest local row were part of
 * an already-persisted turn) and a text containment check (the live mirror
 * stores a turn's assistant text as one concatenated record, so jsonl
 * fragments of it must not re-append).
 */
function isRepresentedInLocalTail(
  message: unknown,
  tail: { entries: LocalTailEntry[]; lastTimestampMs: number | undefined },
): boolean {
  const timestampMs = readMessageTimestampMs(message);
  if (
    timestampMs !== undefined &&
    tail.lastTimestampMs !== undefined &&
    timestampMs <= tail.lastTimestampMs
  ) {
    return true;
  }
  const role = readMessageRole(message);
  const text = extractComparableText(message);
  if (!text) {
    return false;
  }
  return tail.entries.some(
    (entry) => entry.role === role && entry.text !== undefined && entry.text.includes(text),
  );
}

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

type ResolvedDrainScope = ReturnType<typeof resolveSqliteScope>;

/**
 * Shared candidate resolution for both `reconcileCliTranscript` and
 * `drainTailForResume`: binds the CLI session, reads its jsonl, and filters
 * out messages already represented in the local transcript mirror. A `skip`
 * result covers every reason the drain has nothing to append (no binding, no
 * jsonl file, or the mtime watermark already covers it) so callers can treat
 * those uniformly as "zero candidates" rather than distinct early-return
 * branches.
 */
type DrainCandidatesResolution =
  | { kind: "skip"; reason: "no-binding" | "no-jsonl" | "noop" }
  | {
      kind: "candidates";
      candidates: unknown[];
      cliSessionId: string;
      mtimeMs: number;
      resolved: ResolvedDrainScope;
    };

function resolveDrainCandidates(params: ReconcileCliTranscriptParams): DrainCandidatesResolution {
  const binding = getCliSessionBinding(params.entry, CLAUDE_CLI_PROVIDER);
  const cliSessionId = normalizeOptionalString(binding?.sessionId);
  if (!binding || !cliSessionId) {
    return { kind: "skip", reason: "no-binding" };
  }

  const jsonlPath = resolveClaudeCliSessionFilePath({
    cliSessionId,
    ...(params.homeDir ? { homeDir: params.homeDir } : {}),
  });
  if (!jsonlPath) {
    log.warn(`no claude-cli jsonl found for bound session ${cliSessionId} (${params.sessionKey})`);
    return { kind: "skip", reason: "no-jsonl" };
  }

  let mtimeMs: number;
  try {
    mtimeMs = fs.statSync(jsonlPath).mtimeMs;
  } catch {
    return { kind: "skip", reason: "no-jsonl" };
  }

  if (binding.lastReconciledMtimeMs === mtimeMs) {
    return { kind: "skip", reason: "noop" };
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

  const localTail = readLocalTranscriptTail({ ...resolved, sessionId: params.entry.sessionId });
  const candidates = messages.filter((message) => !isRepresentedInLocalTail(message, localTail));

  return { kind: "candidates", candidates, cliSessionId, mtimeMs, resolved };
}

/**
 * Persists the drained mtime watermark via a read-current/CAS replacement
 * rather than writing the caller's (possibly stale) `entry` snapshot
 * directly, so a concurrent mutation to unrelated fields on this session
 * can't be clobbered. Best-effort: if storePath is unavailable, skip
 * persisting — the next call simply re-parses the jsonl (still correct, just
 * not O(1)).
 */
async function persistDrainWatermark(params: {
  agentId: string;
  cliSessionId: string;
  entry: SessionEntry;
  mtimeMs: number;
  sessionKey: string;
  storePath?: string;
}): Promise<void> {
  if (!params.storePath) {
    return;
  }
  await applySessionEntryReplacements({
    agentId: params.agentId,
    sessionKeys: [params.sessionKey],
    storePath: params.storePath,
    update: (entries) => {
      const current = entries.find((candidate) => candidate.sessionKey === params.sessionKey);
      if (!current || current.entry.sessionId !== params.entry.sessionId) {
        return { result: undefined };
      }
      const currentBinding = getCliSessionBinding(current.entry, CLAUDE_CLI_PROVIDER);
      if (!currentBinding || currentBinding.sessionId !== params.cliSessionId) {
        return { result: undefined };
      }
      setCliSessionBinding(current.entry, CLAUDE_CLI_PROVIDER, {
        ...currentBinding,
        lastReconciledMtimeMs: params.mtimeMs,
      });
      return {
        result: undefined,
        replacements: [{ entry: current.entry, sessionKey: current.sessionKey }],
      };
    },
  });
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
    const resolution = resolveDrainCandidates(params);
    if (resolution.kind === "skip") {
      if (resolution.reason === "noop") {
        return { status: "noop" };
      }
      return { status: "skipped", reason: resolution.reason };
    }
    const { candidates, cliSessionId, mtimeMs, resolved } = resolution;

    let backfilled = 0;
    await runExclusiveSqliteSessionWrite(resolved, async () => {
      // Gate on the local tail: the live mirror persists normal turns itself,
      // so the drain backfills only rows with no local representation
      // (in-flight turns lost to a crash). Without this gate every drained
      // row duplicates its mirrored counterpart under a second eventId
      // namespace. Read inside the exclusive lock so a concurrent turn cannot
      // append between the gate and the write.
      if (candidates.length === 0) {
        return;
      }
      runOpenClawAgentWriteTransaction((database) => {
        const transcriptScope = { ...resolved, sessionId: params.entry.sessionId };
        for (const message of candidates) {
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

    await persistDrainWatermark({
      agentId: resolved.agentId,
      cliSessionId,
      entry: params.entry,
      mtimeMs,
      sessionKey: params.sessionKey,
      storePath: params.storePath,
    });

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

export type DrainTailForResumeParams = ReconcileCliTranscriptParams & {
  /**
   * Test-only hook invoked after the drain appends (inside the drain
   * transaction) and before the resume-epoch marker write. Throwing here
   * proves the marker write rolls back together with the appended rows.
   * Always undefined in production.
   */
  failureHookAfterAppends?: () => void;
};

export type DrainTailForResumeResult = { backfilled: number; epoch: number };

/**
 * Drains an interrupted turn's tail into SQLite and commits the
 * `session_resume_epoch` marker as `drained` in the SAME transaction
 * (PHASE-4.md §4 CS-3). Unlike `reconcileCliTranscript`, this always opens
 * the transaction — even with zero candidates (no binding, no jsonl, or an
 * already-covered watermark) — because the marker must advance every resume,
 * not only resumes with a CLI transcript to drain. Errors PROPAGATE (no
 * swallow): a caller must not dispatch the resumed turn unless this resolves.
 */
export async function drainTailForResume(
  params: DrainTailForResumeParams,
): Promise<DrainTailForResumeResult> {
  const resolution = resolveDrainCandidates(params);
  const resolved =
    resolution.kind === "candidates"
      ? resolution.resolved
      : resolveSqliteScope({
          ...(params.agentId ? { agentId: params.agentId } : {}),
          ...(params.env ? { env: params.env } : {}),
          sessionKey: params.sessionKey,
          ...(params.storePath ? { storePath: params.storePath } : {}),
        });
  const candidates = resolution.kind === "candidates" ? resolution.candidates : [];
  const cliSessionId = resolution.kind === "candidates" ? resolution.cliSessionId : undefined;

  let backfilled = 0;
  let epoch = 0;
  await runExclusiveSqliteSessionWrite(resolved, async () => {
    // Phase 1: mark drain_pending BEFORE the drain commits, in its own
    // transaction, so a crash between phase 1 and phase 2 leaves a durably
    // committed drain_pending row for the CS-4 reader to refuse on — the
    // refusal guard is unreachable in production unless this phase commits
    // on its own first. Epoch is NOT incremented here (still the prior,
    // fully-drained epoch); only phase 2's commit advances it.
    runOpenClawAgentWriteTransaction((database) => {
      const current = readSessionResumeEpoch(database, params.sessionKey);
      writeSessionResumeEpoch(database, {
        sessionKey: params.sessionKey,
        epoch: current?.epoch ?? 0,
        state: "drain_pending",
        sessionId: params.entry.sessionId,
        drainedThroughSeq: current?.drainedThroughSeq ?? null,
      });
    }, toDatabaseOptions(resolved));

    // Phase 2: append the drained tail and commit the drained marker in the
    // SAME transaction (PHASE-4.md §4 CS-3) — drain + marker stay atomic.
    runOpenClawAgentWriteTransaction((database) => {
      const transcriptScope = { ...resolved, sessionId: params.entry.sessionId };
      for (const message of candidates) {
        const uuid = readMessageExternalId(message);
        if (!uuid || !cliSessionId) {
          // No stable external id (or no bound CLI session) to dedup on: skip
          // rather than fabricate one.
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
      params.failureHookAfterAppends?.();
      const current = readSessionResumeEpoch(database, params.sessionKey);
      epoch = (current?.epoch ?? 0) + 1;
      const seqRow = database.db
        .prepare("SELECT MAX(seq) AS max_seq FROM transcript_events WHERE session_id = ?")
        .get(params.entry.sessionId) as { max_seq?: unknown } | undefined;
      const drainedThroughSeq =
        typeof seqRow?.max_seq === "number"
          ? seqRow.max_seq
          : seqRow?.max_seq === null || seqRow?.max_seq === undefined
            ? null
            : Number(seqRow.max_seq);
      writeSessionResumeEpoch(database, {
        sessionKey: params.sessionKey,
        epoch,
        state: "drained",
        sessionId: params.entry.sessionId,
        drainedThroughSeq,
      });
    }, toDatabaseOptions(resolved));
  });

  if (resolution.kind === "candidates") {
    await persistDrainWatermark({
      agentId: resolved.agentId,
      cliSessionId: resolution.cliSessionId,
      entry: params.entry,
      mtimeMs: resolution.mtimeMs,
      sessionKey: params.sessionKey,
      storePath: params.storePath,
    });
  }

  if (backfilled > 0) {
    log.info(
      `drained cli transcript tail for resume: ${backfilled} turns backfilled for ${params.sessionKey}`,
    );
  }
  return { backfilled, epoch };
}
