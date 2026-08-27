/**
 * Loads and renders persisted session history for CLI session reseeding and
 * context-engine synchronization.
 */
import fsp from "node:fs/promises";
import path from "node:path";
import { timestampMsToIsoString } from "@openclaw/normalization-core/number-coercion";
import { isRecord } from "@openclaw/normalization-core/record-coerce";
import { sliceUtf16Safe, truncateUtf16Safe } from "@openclaw/normalization-core/utf16-slice";
import {
  resolveSessionFilePathCore,
  resolveSessionFilePathOptions,
} from "../../config/sessions/paths.js";
import {
  isSessionTranscriptProjectionUnavailableError,
  readSessionTranscriptMessageEvents,
} from "../../config/sessions/session-accessor.sqlite-active-events.js";
import { readSessionResumeEpochForScope } from "../../config/sessions/session-accessor.sqlite-active-projection.js";
import { SessionResumeDrainPendingError } from "../../config/sessions/session-resume-drain-pending-error.js";
import {
  parseSessionTranscriptTreeEntry,
  scanSessionTranscriptTree,
  selectSessionTranscriptLeafControlledPath,
} from "../../config/sessions/transcript-tree.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { formatErrorMessage } from "../../infra/errors.js";
import { readFileWindowFully } from "../../infra/file-read.js";
import { isPathInside } from "../../infra/path-guards.js";
import { resolveSessionAgentIds } from "../agent-scope.js";
import {
  limitAgentHookHistoryMessages,
  MAX_AGENT_HOOK_HISTORY_MESSAGES,
} from "../harness/hook-history.js";
import type { AgentMessage } from "../runtime/index.js";
import { migrateSessionEntries, parseSessionEntries } from "../sessions/session-manager.js";
import { cliBackendLog } from "./log.js";

/** Maximum transcript size read for CLI session history. */
const MAX_CLI_SESSION_HISTORY_FILE_BYTES = 5 * 1024 * 1024;
/** Maximum transcript messages exposed to CLI hook history. */
const MAX_CLI_SESSION_HISTORY_MESSAGES = MAX_AGENT_HOOK_HISTORY_MESSAGES;
/** Minimum reseed-history prompt budget for fresh CLI sessions. */
const MAX_CLI_SESSION_RESEED_HISTORY_CHARS = 12 * 1024;
/** Maximum automatic reseed-history prompt budget derived from context size. */
const MAX_AUTO_CLI_SESSION_RESEED_HISTORY_CHARS = 256 * 1024;
const CLI_SESSION_RESEED_HISTORY_CONTEXT_SHARE = 0.08;
const CHARS_PER_TOKEN_ESTIMATE = 4;
const CLI_SESSION_HISTORY_HEADER_READ_BYTES = 64 * 1024;
const CLI_SESSION_RESEED_CURRENCY_GUIDANCE =
  "[Recovered history may be stale; verify current and time-sensitive facts before acting.]";

type HistoryMessage = {
  role?: unknown;
  content?: unknown;
  summary?: unknown;
  timestamp?: unknown;
};
type HistoryEntry = {
  type?: unknown;
  message?: unknown;
  summary?: unknown;
  customType?: unknown;
  content?: unknown;
  display?: unknown;
  details?: unknown;
  timestamp?: unknown;
  fromId?: unknown;
  firstKeptEntryId?: unknown;
  tokensBefore?: unknown;
  tokensAfter?: unknown;
};

export type RawTranscriptReseedReason =
  | "auth-profile"
  | "auth-epoch"
  | "message-policy"
  | "system-prompt"
  | "cwd"
  | "mcp"
  | "missing-transcript"
  | "no-cli-session"
  | "orphaned-tool-use"
  | "session-expired";

const RAW_TRANSCRIPT_RESEED_ALLOWED_REASONS = new Set<RawTranscriptReseedReason>([
  "missing-transcript",
  // No CLI session to resume, so the OpenClaw transcript is the only copy of the
  // conversation. An explicit reset truncates that transcript at the reset boundary
  // (projectLatestCliHistoryBoundary), so a deliberate fresh start stays fresh, and a
  // genuinely new chat reseeds nothing because its history is empty.
  "no-cli-session",
  "orphaned-tool-use",
  "message-policy",
  "system-prompt",
  "cwd",
  "mcp",
  "session-expired",
]);

/** Resolves how much prior transcript text may reseed a fresh CLI session. */
export function resolveAutoCliSessionReseedHistoryChars(contextWindowTokens: number): number {
  if (!Number.isFinite(contextWindowTokens) || contextWindowTokens <= 0) {
    return MAX_CLI_SESSION_RESEED_HISTORY_CHARS;
  }
  const contextShareChars = Math.floor(
    contextWindowTokens * CLI_SESSION_RESEED_HISTORY_CONTEXT_SHARE * CHARS_PER_TOKEN_ESTIMATE,
  );
  return Math.max(
    MAX_CLI_SESSION_RESEED_HISTORY_CHARS,
    Math.min(MAX_AUTO_CLI_SESSION_RESEED_HISTORY_CHARS, contextShareChars),
  );
}

function coerceHistoryText(content: unknown): string {
  if (typeof content === "string") {
    return content.trim();
  }
  if (!Array.isArray(content)) {
    return "";
  }
  return content
    .flatMap((block) => {
      if (!block || typeof block !== "object") {
        return [];
      }
      const text = (block as { text?: unknown }).text;
      return typeof text === "string" && text.trim().length > 0 ? [text.trim()] : [];
    })
    .join("\n")
    .trim();
}

function coerceHistoryTimestamp(value: unknown): number | string {
  if (typeof value === "number" && Number.isFinite(value)) {
    return value;
  }
  if (typeof value === "string") {
    return value;
  }
  return 0;
}

function projectReseedMessage(message: unknown, timestamp: unknown): unknown {
  // The transcript row owns persistence time; nested provider timestamps can
  // be stale or absent when history is recovered into a fresh CLI session.
  return isRecord(message) ? { ...message, timestamp } : message;
}

function formatHistoryTimestamp(value: unknown): string | undefined {
  if (typeof value !== "string") {
    return undefined;
  }
  const timestamp = timestampMsToIsoString(Date.parse(value));
  return timestamp === value ? timestamp : undefined;
}

function historyEntryToContextEngineMessage(entry: HistoryEntry): AgentMessage | undefined {
  if (entry.type === "message") {
    return entry.message as AgentMessage;
  }
  if (entry.type === "custom_message") {
    return {
      role: "custom",
      customType: typeof entry.customType === "string" ? entry.customType : "custom",
      content: entry.content,
      display: entry.display !== false,
      details: entry.details,
      timestamp: coerceHistoryTimestamp(entry.timestamp),
    } as AgentMessage;
  }
  if (entry.type === "branch_summary") {
    return {
      role: "branchSummary",
      summary: typeof entry.summary === "string" ? entry.summary : "",
      fromId: typeof entry.fromId === "string" ? entry.fromId : "root",
      timestamp: coerceHistoryTimestamp(entry.timestamp),
    } as AgentMessage;
  }
  return undefined;
}

function loadContextEngineMessagesFromEntries(entries: unknown[]): AgentMessage[] {
  return entries.flatMap((entry) => {
    const message = historyEntryToContextEngineMessage(entry as HistoryEntry);
    return message ? [message] : [];
  });
}

function renderHistoryMessage(message: unknown): string | undefined {
  if (!message || typeof message !== "object") {
    return undefined;
  }
  const entry = message as HistoryMessage;
  const role =
    entry.role === "assistant"
      ? "Assistant"
      : entry.role === "user"
        ? "User"
        : entry.role === "compactionSummary"
          ? "Compaction summary"
          : undefined;
  if (!role) {
    return undefined;
  }
  const text =
    entry.role === "compactionSummary" && typeof entry.summary === "string"
      ? entry.summary.trim()
      : coerceHistoryText(entry.content);
  if (!text) {
    return undefined;
  }
  const timestamp = formatHistoryTimestamp(entry.timestamp);
  return `${timestamp ? `[${timestamp}] ` : ""}${role}: ${text}`;
}

/** Builds a reseed prompt that carries prior OpenClaw transcript context. */
export function buildCliSessionHistoryPrompt(params: {
  messages: unknown[];
  prompt: string;
  maxHistoryChars?: number;
}): string | undefined {
  const maxHistoryChars = params.maxHistoryChars ?? MAX_CLI_SESSION_RESEED_HISTORY_CHARS;
  const historyBudget = maxHistoryChars - CLI_SESSION_RESEED_CURRENCY_GUIDANCE.length - "\n".length;
  if (historyBudget <= 0) {
    return undefined;
  }

  // loadCliSessionReseedMessages deliberately places a `compactionSummary`
  // entry first when the session was compacted, so the compacted prior
  // context survives reseed. Pin that summary as a prefix and only
  // tail-truncate the post-summary transcript — a blind tail-slice of the
  // joined history would drop the summary whenever the post-summary tail
  // alone exceeds the cap.
  const firstEntry = params.messages[0];
  const firstIsCompaction =
    Boolean(firstEntry) &&
    typeof firstEntry === "object" &&
    (firstEntry as HistoryMessage).role === "compactionSummary";
  const summaryRendered = firstIsCompaction ? renderHistoryMessage(firstEntry) : undefined;
  const tailMessages = firstIsCompaction ? params.messages.slice(1) : params.messages;

  const tailRaw = tailMessages
    .flatMap((message) => {
      const rendered = renderHistoryMessage(message);
      return rendered ? [rendered] : [];
    })
    .join("\n\n")
    .trim();

  const truncationMarker = "[OpenClaw reseed history truncated; older turns dropped]";
  const renderTruncatedTail = (raw: string, budget: number): string => {
    if (budget <= truncationMarker.length + "\n".length) {
      return sliceUtf16Safe(raw, -budget).trimStart();
    }
    const tailBudget = budget - truncationMarker.length - "\n".length;
    return `${truncationMarker}\n${sliceUtf16Safe(raw, -tailBudget).trimStart()}`;
  };
  const renderTruncatedSummaryWithTail = (renderedSummary: string): string => {
    if (historyBudget <= truncationMarker.length + "\n".length) {
      return tailRaw.length > 0
        ? sliceUtf16Safe(tailRaw, -historyBudget).trimStart()
        : truncateUtf16Safe(renderedSummary, historyBudget).trimEnd();
    }
    const tailBudget =
      tailRaw.length > 0 ? Math.min(tailRaw.length, Math.floor(historyBudget / 2)) : 0;
    const separatorBudget = tailBudget > 0 ? 2 : 1;
    const summaryBudget = Math.max(
      0,
      historyBudget - truncationMarker.length - separatorBudget - tailBudget,
    );
    const summaryTruncated = truncateUtf16Safe(renderedSummary, summaryBudget).trimEnd();
    const tailTruncated = tailBudget > 0 ? sliceUtf16Safe(tailRaw, -tailBudget).trimStart() : "";
    return [truncationMarker, summaryTruncated, tailTruncated].filter(Boolean).join("\n");
  };

  let renderedHistory: string;
  if (summaryRendered) {
    // Reserve the summary from the budget so the post-summary tail cap is
    // the remaining headroom. If the summary alone meets or exceeds the
    // cap, the summary itself must be truncated — pinning a summary that
    // blows past `maxHistoryChars` would defeat the cap that prevents
    // reseeding fresh CLI sessions with unexpectedly huge prompts.
    if (summaryRendered.length >= historyBudget) {
      // Truncate the summary to fit the budget (less the marker line),
      // keeping the head. Still reserve budget for the post-summary tail so
      // recent exact turns survive even when the summary itself is oversize.
      renderedHistory = renderTruncatedSummaryWithTail(summaryRendered);
    } else if (tailRaw.length === 0) {
      renderedHistory = summaryRendered;
    } else {
      const summaryBlock = `${summaryRendered}\n\n`;
      const remainingBudget = historyBudget - summaryBlock.length;
      if (tailRaw.length <= remainingBudget) {
        renderedHistory = `${summaryBlock}${tailRaw}`;
      } else if (remainingBudget <= truncationMarker.length + "\n".length) {
        // The summary leaves too little room to announce truncation. Reuse
        // the oversize-summary path so the marker and recent exact turns
        // both retain budget.
        renderedHistory = renderTruncatedSummaryWithTail(summaryRendered);
      } else {
        renderedHistory = `${summaryBlock}${renderTruncatedTail(tailRaw, remainingBudget)}`;
      }
    }
  } else {
    // No compaction summary to pin: tail-slice the full rendered history
    // and lead with the marker so it correctly describes what follows
    // (older turns dropped, recent tail retained).
    renderedHistory =
      tailRaw.length > historyBudget ? renderTruncatedTail(tailRaw, historyBudget) : tailRaw;
  }

  if (!renderedHistory) {
    return undefined;
  }

  return [
    "Continue this conversation using the OpenClaw transcript below as prior session history.",
    "Treat it as authoritative context for this fresh CLI session.",
    "",
    "<conversation_history>",
    CLI_SESSION_RESEED_CURRENCY_GUIDANCE,
    renderedHistory,
    "</conversation_history>",
    "",
    "<next_user_message>",
    params.prompt,
    "</next_user_message>",
  ].join("\n");
}

async function safeRealpath(filePath: string): Promise<string | undefined> {
  try {
    return await fsp.realpath(filePath);
  } catch {
    return undefined;
  }
}

function isFileNotFoundError(error: unknown): boolean {
  return Boolean(
    error &&
    typeof error === "object" &&
    "code" in error &&
    (error as { code?: unknown }).code === "ENOENT",
  );
}

async function readCliSessionHeaderLine(filePath: string): Promise<string | undefined> {
  const handle = await fsp.open(filePath, "r");
  try {
    const buffer = Buffer.alloc(CLI_SESSION_HISTORY_HEADER_READ_BYTES);
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
    const firstChunk = buffer.subarray(0, bytesRead).toString("utf-8");
    const lineEnd = firstChunk.indexOf("\n");
    if (lineEnd < 0) {
      return undefined;
    }
    const line = firstChunk.slice(0, lineEnd);
    const parsed = JSON.parse(line) as { type?: unknown };
    return parsed.type === "session" ? line : undefined;
  } catch {
    return undefined;
  } finally {
    await handle.close();
  }
}

async function readBoundedCliSessionTranscript(
  filePath: string,
): Promise<{ content: string; truncated: boolean }> {
  const handle = await fsp.open(filePath, "r");
  try {
    let buffer = Buffer.alloc(0);
    let bytesRead = 0;
    let position = 0;
    // Compaction can shrink the open file between stat and read. Retry from
    // the new tail after EOF so a stale offset cannot discard valid history.
    for (let attempt = 0; attempt < 2; attempt += 1) {
      const currentSize = (await handle.stat()).size;
      const readLength = Math.min(currentSize, MAX_CLI_SESSION_HISTORY_FILE_BYTES);
      position = Math.max(0, currentSize - readLength);
      buffer = Buffer.alloc(readLength);
      bytesRead = await readFileWindowFully(handle, buffer, position);
      if (bytesRead === buffer.length || position === 0) {
        break;
      }
    }
    const tail = buffer.subarray(0, bytesRead).toString("utf-8");
    if (position === 0) {
      return { content: tail, truncated: false };
    }

    cliBackendLog.warn(
      `cli session history truncated to last ${MAX_CLI_SESSION_HISTORY_FILE_BYTES} bytes: ${filePath}`,
    );
    const firstLineEnd = tail.indexOf("\n");
    const completeTail = firstLineEnd >= 0 ? tail.slice(firstLineEnd + 1) : "";
    const headerLine = await readCliSessionHeaderLine(filePath);
    return {
      content: headerLine ? `${headerLine}\n${completeTail}` : completeTail,
      truncated: true,
    };
  } finally {
    await handle.close();
  }
}

function isSafeTruncatedCliSessionTail(entries: readonly unknown[]): boolean {
  const tree = scanSessionTranscriptTree(entries);
  if (tree.hasLeafControl) {
    return !tree.hasInvalidLeafControl;
  }
  const rawIds = new Set<string>();
  const childParentIds = new Set<string>();
  let truncatedRootParentId: string | undefined;
  for (const entry of entries) {
    const node = parseSessionTranscriptTreeEntry(entry);
    if (!node) {
      continue;
    }
    if (node.appendMode === "side") {
      return false;
    }
    if (node.parentId === null) {
      rawIds.add(node.id);
      continue;
    }
    if (!rawIds.has(node.parentId)) {
      if (truncatedRootParentId !== undefined || childParentIds.size > 0) {
        return false;
      }
      truncatedRootParentId = node.parentId;
      rawIds.add(node.id);
      continue;
    }
    if (childParentIds.has(node.parentId)) {
      return false;
    }
    childParentIds.add(node.parentId);
    rawIds.add(node.id);
  }
  return true;
}

function parseCliSessionEntries(
  content: string,
): ReturnType<typeof parseSessionEntries> | undefined {
  for (const line of content.trim().split("\n")) {
    if (!line.trim()) {
      continue;
    }
    try {
      JSON.parse(line);
    } catch (error) {
      cliBackendLog.warn(`cli session history parse failed: ${formatErrorMessage(error)}`);
      return undefined;
    }
  }
  return parseSessionEntries(content);
}

function resolveSafeCliSessionFile(params: {
  sessionId: string;
  sessionFile: string;
  sessionKey?: string;
  agentId?: string;
  config?: OpenClawConfig;
}): { sessionFile: string; sessionsDir: string } {
  const { defaultAgentId, sessionAgentId } = resolveSessionAgentIds({
    sessionKey: params.sessionKey,
    config: params.config,
    agentId: params.agentId,
  });
  const pathOptions = resolveSessionFilePathOptions({
    agentId: sessionAgentId ?? defaultAgentId,
    storePath: params.config?.session?.store,
  });
  const sessionFile = resolveSessionFilePathCore(
    params.sessionId,
    { sessionFile: params.sessionFile },
    pathOptions,
  );
  return {
    sessionFile,
    sessionsDir: pathOptions?.sessionsDir ?? path.dirname(sessionFile),
  };
}

/**
 * Reads transcript entries from the canonical SQLite store. Returns undefined only
 * when the store holds nothing for this session, so callers fall through to the
 * legacy filesystem reader.
 *
 * Deliberately does not gate on the `sqlite:` sessionFile sentinel: entries written
 * after the SQLite migration usually carry no `sessionFile` at all, and the path
 * resolver then derives a .jsonl path that never exists. Gating on the sentinel
 * silently skipped the store for exactly the sessions that live in it.
 */
function readSqliteCliSessionEntriesOnce(params: {
  sessionId: string;
  sessionFile: string;
  sessionKey?: string;
  agentId?: string;
}): unknown[] | undefined {
  const rows = readSessionTranscriptMessageEvents({
    sessionId: params.sessionId,
    ...(params.sessionKey ? { sessionKey: params.sessionKey } : {}),
    ...(params.agentId ? { agentId: params.agentId } : {}),
  });
  // Store rows are {event, seq} envelopes; downstream projection expects the bare
  // transcript entries the file reader yields, so unwrap before returning.
  const entries = rows.flatMap((row) => {
    const event = isRecord(row) ? row.event : undefined;
    return event === undefined ? [] : [event];
  });
  return entries.length > 0 ? entries : undefined;
}

// Thin wrapper (PHASE-4.md §4 CS-5): CS-3 (drain+marker one txn, dispatch
// gated on COMMIT) and CS-4 (resume readers refuse drain_pending) already
// guarantee a resume read observes a consistent transcript, so this no
// longer retries a transient projection lag. Any store error — including
// SessionTranscriptProjectionUnavailableError — falls straight through to
// the file reader; sleep-based retry is forbidden here.
function readSqliteCliSessionEntries(params: {
  sessionId: string;
  sessionFile: string;
  sessionKey?: string;
  agentId?: string;
}): unknown[] | undefined {
  try {
    return readSqliteCliSessionEntriesOnce(params);
  } catch (error) {
    if (isSessionTranscriptProjectionUnavailableError(error)) {
      // Projection lag: CS-3/CS-4 already guarantee a resume read observes a
      // consistent transcript, so there is nothing to retry here. Fall
      // through to the file reader.
      cliBackendLog.warn(`sqlite cli session history read failed: ${formatErrorMessage(error)}`);
      return undefined;
    }
    // Never break history loading on a store read; fall through to the file reader.
    cliBackendLog.warn(`sqlite cli session history read failed: ${formatErrorMessage(error)}`);
    return undefined;
  }
}

/**
 * Refuses a drain-pending session_resume_epoch marker before a resume/reseed
 * transcript read (PHASE-4.md §4 CS-4, §7c). Reads the marker via the same
 * scope the subsequent `readSqliteCliSessionEntriesOnce` call resolves, so
 * marker and transcript observe one snapshot. Only `loadCliSessionReseedMessages`
 * and `loadCliSessionContextEngineMessages` call this — non-resume readers
 * (`loadCliSessionHistoryMessages`, `hasCliSessionTranscript`) must not.
 */
function refuseIfCliSessionResumeDrainPending(params: {
  sessionId: string;
  sessionKey?: string;
  agentId?: string;
}): void {
  if (!params.sessionKey) {
    // session_resume_epoch is keyed by session_key, and only sessions with a
    // session_key ever get a row via the CS-2 AFTER-INSERT trigger. Callers
    // without a durable session_key (RunCliAgentParams.sessionKey is optional —
    // ephemeral/isolated runs, e.g. src/agents/isolated-completion.ts,
    // src/cron/isolated-agent/*) never participate in the resume-epoch system,
    // so there is no marker to refuse. Nothing to check; proceed.
    return;
  }
  const marker = readSessionResumeEpochForScope(
    {
      sessionId: params.sessionId,
      sessionKey: params.sessionKey,
      ...(params.agentId ? { agentId: params.agentId } : {}),
    },
    params.sessionKey,
  );
  if (!marker) {
    throw new Error(
      `session_resume_epoch marker invariant violated: no marker row for session ${params.sessionKey} ` +
        "(CS-2 migration + AFTER-INSERT trigger guarantee a row for every session at epoch 0)",
    );
  }
  if (marker.state === "drain_pending") {
    throw new SessionResumeDrainPendingError(params.sessionKey, marker.epoch);
  }
}

async function loadCliSessionEntries(params: {
  sessionId: string;
  sessionFile: string;
  sessionKey?: string;
  agentId?: string;
  config?: OpenClawConfig;
}): Promise<unknown[]> {
  try {
    const { sessionFile, sessionsDir } = resolveSafeCliSessionFile(params);
    // SQLite-backed sessions carry a `sqlite:` sentinel instead of a real path, so the
    // filesystem walk below lstat()s a non-path, throws ENOENT, and returns no history
    // through the silent catch. Read the canonical store first: without this, resuming
    // a session whose transcript lives only in SQLite reseeds nothing, and the chat
    // starts cold even though its full history is present.
    const sqliteEntries = readSqliteCliSessionEntries(params);
    if (sqliteEntries) {
      return projectLatestCliHistoryBoundary(
        selectSessionTranscriptLeafControlledPath(sqliteEntries) ?? sqliteEntries,
      );
    }
    const entryStat = await fsp.lstat(sessionFile);
    if (!entryStat.isFile() || entryStat.isSymbolicLink()) {
      return [];
    }
    const realSessionsDir = (await safeRealpath(sessionsDir)) ?? path.resolve(sessionsDir);
    const realSessionFile = await safeRealpath(sessionFile);
    if (
      !realSessionFile ||
      realSessionFile === realSessionsDir ||
      !isPathInside(realSessionsDir, realSessionFile)
    ) {
      return [];
    }
    const stat = await fsp.stat(realSessionFile);
    if (!stat.isFile()) {
      return [];
    }
    const transcript = await readBoundedCliSessionTranscript(realSessionFile);
    const entries = parseCliSessionEntries(transcript.content);
    if (!entries) {
      return [];
    }
    const rawSessionEntries = entries.filter((entry) => entry.type !== "session");
    if (transcript.truncated && !isSafeTruncatedCliSessionTail(rawSessionEntries)) {
      cliBackendLog.warn(
        `cli session history truncated tail skipped because branch controls are incomplete: ${realSessionFile}`,
      );
      return [];
    }
    migrateSessionEntries(entries);
    const sessionEntries = entries.filter((entry) => entry.type !== "session");
    if (transcript.truncated && !isSafeTruncatedCliSessionTail(sessionEntries)) {
      cliBackendLog.warn(
        `cli session history truncated tail skipped because branch controls are incomplete: ${realSessionFile}`,
      );
      return [];
    }
    return projectLatestCliHistoryBoundary(
      selectSessionTranscriptLeafControlledPath(sessionEntries) ?? sessionEntries,
    );
  } catch (error) {
    if (!isFileNotFoundError(error)) {
      cliBackendLog.warn(`cli session history load failed: ${formatErrorMessage(error)}`);
    }
    return [];
  }
}

function projectLatestCliHistoryBoundary(entries: unknown[]): unknown[] {
  const boundaryIndex = entries.findLastIndex((entry) => {
    const type = (entry as { type?: unknown } | null)?.type;
    return type === "compaction" || type === "reset";
  });
  if (boundaryIndex < 0) {
    return entries;
  }
  const boundary = entries[boundaryIndex] as {
    type?: unknown;
    firstKeptEntryId?: unknown;
  };
  if (boundary.type !== "reset") {
    return entries;
  }
  const firstKeptIndex =
    typeof boundary.firstKeptEntryId === "string"
      ? entries.findIndex(
          (entry, index) =>
            index < boundaryIndex &&
            (entry as { id?: unknown } | null)?.id === boundary.firstKeptEntryId,
        )
      : -1;
  const kept =
    firstKeptIndex < 0
      ? []
      : entries.slice(firstKeptIndex, boundaryIndex).filter((entry) => {
          const candidate = entry as HistoryEntry;
          const message = candidate.message as HistoryMessage | undefined;
          return (
            candidate.type === "message" &&
            (message?.role === "user" || message?.role === "assistant")
          );
        });
  return [...kept, ...entries.slice(boundaryIndex + 1)];
}

/** Checks whether a safe, bounded transcript exists for a CLI session. */
export async function hasCliSessionTranscript(params: {
  sessionId: string;
  sessionFile: string;
  sessionKey?: string;
  agentId?: string;
  config?: OpenClawConfig;
}): Promise<boolean> {
  try {
    const { sessionFile, sessionsDir } = resolveSafeCliSessionFile(params);
    // Same sentinel branch as the loader: a SQLite-backed session has no file, so the
    // filesystem probe below would report "no transcript" for a session that has one.
    const sqliteEntries = readSqliteCliSessionEntries(params);
    if (sqliteEntries) {
      return sqliteEntries.length > 0;
    }
    const entryStat = await fsp.lstat(sessionFile);
    if (!entryStat.isFile() || entryStat.isSymbolicLink()) {
      return false;
    }
    const realSessionsDir = (await safeRealpath(sessionsDir)) ?? path.resolve(sessionsDir);
    const realSessionFile = await safeRealpath(sessionFile);
    if (
      !realSessionFile ||
      realSessionFile === realSessionsDir ||
      !isPathInside(realSessionsDir, realSessionFile)
    ) {
      return false;
    }
    const stat = await fsp.stat(realSessionFile);
    return stat.isFile();
  } catch {
    return false;
  }
}

/** Loads transcript messages for CLI lifecycle hook context. */
export async function loadCliSessionHistoryMessages(params: {
  sessionId: string;
  sessionFile: string;
  sessionKey?: string;
  agentId?: string;
  config?: OpenClawConfig;
}): Promise<unknown[]> {
  const history = (await loadCliSessionEntries(params)).flatMap((entry) => {
    const candidate = entry as HistoryEntry;
    return candidate.type === "message" ? [candidate.message] : [];
  });
  return limitAgentHookHistoryMessages(history, MAX_CLI_SESSION_HISTORY_MESSAGES);
}

/** Loads transcript messages formatted for context-engine updates. */
export async function loadCliSessionContextEngineMessages(params: {
  sessionId: string;
  sessionFile: string;
  sessionKey?: string;
  agentId?: string;
  config?: OpenClawConfig;
}): Promise<unknown[]> {
  refuseIfCliSessionResumeDrainPending(params);
  const entries = await loadCliSessionEntries(params);
  const latestCompactionIndex = entries.findLastIndex((entry) => {
    const candidate = entry as HistoryEntry;
    return candidate.type === "compaction" && typeof candidate.summary === "string";
  });
  if (latestCompactionIndex < 0) {
    return loadContextEngineMessagesFromEntries(entries);
  }

  const compaction = entries[latestCompactionIndex] as HistoryEntry;
  const summary = typeof compaction.summary === "string" ? compaction.summary.trim() : "";
  if (!summary) {
    return loadContextEngineMessagesFromEntries(entries);
  }

  const tailMessages = loadContextEngineMessagesFromEntries(
    entries.slice(latestCompactionIndex + 1),
  );
  return [
    {
      role: "compactionSummary",
      summary,
      timestamp: coerceHistoryTimestamp(compaction.timestamp),
      tokensBefore: typeof compaction.tokensBefore === "number" ? compaction.tokensBefore : 0,
      ...(typeof compaction.tokensAfter === "number"
        ? { tokensAfter: compaction.tokensAfter }
        : {}),
      ...(typeof compaction.firstKeptEntryId === "string"
        ? { firstKeptEntryId: compaction.firstKeptEntryId }
        : {}),
      ...(compaction.details !== undefined ? { details: compaction.details } : {}),
    },
    ...tailMessages,
  ];
}

/** Loads compacted/raw transcript messages eligible for CLI session reseeding. */
export async function loadCliSessionReseedMessages(params: {
  sessionId: string;
  sessionFile: string;
  sessionKey?: string;
  agentId?: string;
  config?: OpenClawConfig;
  allowRawTranscriptReseed?: boolean;
  rawTranscriptReseedReason?: RawTranscriptReseedReason;
}): Promise<unknown[]> {
  refuseIfCliSessionResumeDrainPending(params);
  const entries = await loadCliSessionEntries(params);
  const loadRawTail = () => {
    if (
      params.allowRawTranscriptReseed !== true ||
      !params.rawTranscriptReseedReason ||
      !RAW_TRANSCRIPT_RESEED_ALLOWED_REASONS.has(params.rawTranscriptReseedReason)
    ) {
      return [];
    }
    const rawTail = entries.flatMap((entry) => {
      const candidate = entry as HistoryEntry;
      return candidate.type === "message"
        ? [projectReseedMessage(candidate.message, candidate.timestamp)]
        : [];
    });
    return limitAgentHookHistoryMessages(rawTail, MAX_CLI_SESSION_HISTORY_MESSAGES);
  };
  const latestCompactionIndex = entries.findLastIndex((entry) => {
    const candidate = entry as HistoryEntry;
    return candidate.type === "compaction" && typeof candidate.summary === "string";
  });
  if (latestCompactionIndex < 0) {
    return loadRawTail();
  }

  const compaction = entries[latestCompactionIndex] as HistoryEntry;
  const summary = typeof compaction.summary === "string" ? compaction.summary.trim() : "";
  if (!summary) {
    return loadRawTail();
  }

  const tailMessages = entries.slice(latestCompactionIndex + 1).flatMap((entry) => {
    const candidate = entry as HistoryEntry;
    return candidate.type === "message"
      ? [projectReseedMessage(candidate.message, candidate.timestamp)]
      : [];
  });
  return [
    {
      role: "compactionSummary",
      summary,
      timestamp: compaction.timestamp,
    },
    ...limitAgentHookHistoryMessages(tailMessages, MAX_CLI_SESSION_HISTORY_MESSAGES - 1),
  ];
}
