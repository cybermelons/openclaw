// Sanctioned low-level scope/Kysely entry point for doctor, migrations, and infrastructure.
// Runtime feature code imports the session accessor barrel instead of this module.
import path from "node:path";
import type { Insertable, Updateable } from "kysely";
import { getNodeSqliteKysely } from "../../infra/kysely-sync.js";
import { getChildLogger } from "../../logging/logger.js";
import {
  isIncognitoSessionKey,
  normalizeAgentId,
  parseAgentSessionKey,
  resolveAgentIdFromSessionKey,
  toAgentStoreSessionKey,
} from "../../routing/session-key.js";
import { runQueuedStoreWrite, type StoreWriterQueue } from "../../shared/store-writer-queue.js";
import type { DB as OpenClawAgentKyselyDatabase } from "../../state/openclaw-agent-db.generated.js";
import {
  resolveIncognitoOpenClawAgentSqlitePath,
  resolveOpenClawAgentSqlitePath,
  type OpenClawAgentDatabaseOptions,
} from "../../state/openclaw-agent-db.js";
import { formatSqliteSessionFileMarker } from "./legacy-sqlite-marker.js";
import type {
  SessionAccessScope,
  SessionTranscriptReadScope,
  SessionTranscriptWriteScope,
} from "./session-accessor.sqlite-contract.js";
import { resolveSqliteTargetFromSessionStorePath } from "./session-sqlite-target.js";
import { normalizeStoreSessionKey } from "./store-entry.js";
import type { SessionEntry } from "./types.js";

type SessionSqliteDatabase = Pick<
  OpenClawAgentKyselyDatabase,
  | "acp_parent_stream_events"
  | "board_tabs"
  | "board_widgets"
  | "conversation_deliveries"
  | "conversations"
  | "heartbeat_outcomes"
  | "session_conversations"
  | "session_members"
  | "session_nodes"
  | "session_participants"
  | "session_suggestions"
  | "session_transcript_archives"
  | "session_transcript_active_events"
  | "session_transcript_index_state"
  | "session_windows"
  | "transcript_rewrite_watermarks"
  | "trajectory_runtime_events"
  | "transcript_event_identities"
  | "transcript_events"
> & {
  sqlite_schema: { name: string | null; type: string };
};

export type ResolvedSqliteScope = {
  agentId: string;
  databaseAgentId?: string;
  env?: NodeJS.ProcessEnv;
  path?: string;
  sessionKey: string;
};

export type ResolvedSqliteReadScope = {
  agentId: string;
  databaseAgentId?: string;
  env?: NodeJS.ProcessEnv;
  path?: string;
  sessionKey?: string;
};

export type ResolvedTranscriptScope = ResolvedSqliteScope & {
  sessionId: string;
};

type ResolvedTranscriptReadScope = ResolvedSqliteReadScope & {
  sessionId: string;
};

export type SessionSqliteTargetResolutionCache = Map<
  NodeJS.ProcessEnv | undefined,
  Map<string, ReturnType<typeof resolveSqliteTargetFromSessionStorePath>>
>;

const SQLITE_SESSION_SLOW_WRITE_MS = 1_000;
const SQLITE_SESSION_WRITER_QUEUES = new Map<string, StoreWriterQueue>();

export function getSessionKysely(database: import("node:sqlite").DatabaseSync) {
  return getNodeSqliteKysely<SessionSqliteDatabase>(database);
}

type Conv = OpenClawAgentKyselyDatabase["session_conversations"];
// `db` is a passed handle, never captured, so cross-store repair targets its own store.
export function upsertSessionConversationLink(
  db: ReturnType<typeof getSessionKysely>,
  values: Insertable<Conv> | Insertable<Conv>[],
  updateSet: Updateable<Conv>,
) {
  return db
    .insertInto("session_conversations")
    .values(values)
    .onConflict((c) => c.columns(["session_id", "conversation_id", "role"]).doUpdateSet(updateSet));
}

export async function runExclusiveSqliteSessionWrite<T>(
  scope: Pick<ResolvedSqliteReadScope, "agentId" | "env" | "path">,
  fn: () => Promise<T>,
): Promise<T> {
  const databaseOptions = toDatabaseOptions(scope);
  const storePath = resolveOpenClawAgentSqlitePath(databaseOptions);
  const startedAt = Date.now();
  try {
    const result = await runQueuedStoreWrite({
      queues: SQLITE_SESSION_WRITER_QUEUES,
      storePath,
      label: "runExclusiveSqliteSessionWrite",
      fn,
    });
    const elapsedMs = Date.now() - startedAt;
    if (elapsedMs >= SQLITE_SESSION_SLOW_WRITE_MS) {
      getChildLogger({ subsystem: "session-sqlite" }).warn("slow SQLite session write", {
        agentId: scope.agentId,
        elapsedMs,
        storePath,
      });
    }
    return result;
  } catch (error) {
    getChildLogger({ subsystem: "session-sqlite" }).warn("SQLite session write failed", {
      agentId: scope.agentId,
      elapsedMs: Date.now() - startedAt,
      error,
      storePath,
    });
    throw error;
  }
}

// issue #118: a malformed or agent-less session key must produce a typed, classifiable
// error, not a bare Error that a detached promise rejection can turn into a fatal
// process exit. The stable `code` lets the gateway boundary map it to a client error and
// lets the unhandled-rejection backstop classify it as non-fatal.
export class SqliteScopeResolutionError extends Error {
  readonly code = "invalid_session_key" as const;
  constructor(message: string) {
    super(message);
    this.name = "SqliteScopeResolutionError";
  }
}

export function isSqliteScopeResolutionError(error: unknown): error is SqliteScopeResolutionError {
  return error instanceof SqliteScopeResolutionError;
}

// issue #118: An explicit agent id that disagrees with the store-owner agent id is a distinct,
// classifiable failure. It is not a bad client key and not an internal defect, so it carries its
// own stable `code`. The gateway boundary can map it to a client error; the unhandled-rejection
// backstop can classify it as non-fatal.
export class SqliteAgentKeyMismatchError extends Error {
  readonly code = "agent_key_mismatch" as const;
  constructor(message: string) {
    super(message);
    this.name = "SqliteAgentKeyMismatchError";
  }
}

export function isSqliteAgentKeyMismatchError(
  error: unknown,
): error is SqliteAgentKeyMismatchError {
  return error instanceof SqliteAgentKeyMismatchError;
}

// issue #118: A Result carries a resolution failure without a throw. The session-key path
// derives an agent id from client input, so it can fail on bad input. It returns this Result
// and never throws. Callers must handle `ok: false` and must not assume a scope.
export type SqliteScopeResult =
  | { ok: true; scope: ResolvedSqliteScope }
  | { ok: false; error: SqliteScopeResolutionError };

type SqliteScopeCoreInput = Pick<
  SessionAccessScope,
  "agentId" | "defaultAgentId" | "env" | "sessionKey" | "storePath"
>;

// issue #118: The shared resolution body. `resolveSqliteScope` is deleted. The two public
// entry points below wrap this core with different required inputs, so the type system forces
// each caller to prove it has either an explicit agent id or a parseable session key.
function resolveSqliteScopeCore(scope: SqliteScopeCoreInput): ResolvedSqliteScope {
  const parsedAgentId = parseAgentSessionKey(scope.sessionKey)?.agentId;
  const scopedAgentId = scope.agentId ? normalizeAgentId(scope.agentId) : parsedAgentId;
  const incognitoAgentId = isIncognitoSessionKey(scope.sessionKey)
    ? resolveAgentIdFromSessionKey(scope.sessionKey)
    : undefined;
  const effectiveStorePath = incognitoAgentId
    ? resolveIncognitoOpenClawAgentSqlitePath({ agentId: incognitoAgentId, env: scope.env })
    : scope.storePath;
  const effectiveAgentId = incognitoAgentId ?? scopedAgentId;
  const storeTarget = effectiveStorePath
    ? resolveSqliteTargetFromSessionStorePath(effectiveStorePath, {
        agentId: effectiveAgentId,
        defaultAgentId: scope.defaultAgentId,
        ...(scope.env ? { env: scope.env } : {}),
      })
    : undefined;
  const agentId = resolveSqliteAgentId({
    scopedAgentId: effectiveAgentId,
    sessionKey: scope.sessionKey,
    storeAgentId: storeTarget?.agentId,
    storeShared: storeTarget?.shared,
  });
  if (!agentId) {
    throw new SqliteScopeResolutionError("Cannot resolve SQLite session scope without an agent id");
  }
  const normalizedSessionKey = normalizeSqliteSessionKey(scope.sessionKey);
  const sessionKey =
    !normalizedSessionKey ||
    normalizedSessionKey === "global" ||
    normalizedSessionKey === "unknown" ||
    parseAgentSessionKey(normalizedSessionKey)
      ? normalizedSessionKey
      : toAgentStoreSessionKey({ agentId, requestKey: normalizedSessionKey });
  return {
    agentId,
    ...(storeTarget?.shared && storeTarget.agentId ? { databaseAgentId: storeTarget.agentId } : {}),
    ...(scope.env ? { env: scope.env } : {}),
    ...(storeTarget ? { path: storeTarget.path } : {}),
    sessionKey,
  };
}

// issue #118: Resolve a scope from an explicit agent id. The caller holds the agent id, so the
// resolver cannot fail for a missing agent and does not throw for one. An absent `sessionKey`
// means "agent-wide scope, no single session"; it maps to the old `sessionKey: ""` idiom plus
// an explicit `agentId`. An empty `agentId` is a programmer error, not client input, so it
// throws a `TypeError` at this one place.
export function resolveSqliteScopeForAgent(
  input: {
    agentId: string;
  } & Pick<SessionAccessScope, "defaultAgentId" | "env" | "storePath"> & {
      sessionKey?: string;
    },
): ResolvedSqliteScope {
  if (input.agentId === "") {
    throw new TypeError("resolveSqliteScopeForAgent requires a non-empty agentId");
  }
  return resolveSqliteScopeCore({
    agentId: input.agentId,
    ...(input.defaultAgentId !== undefined ? { defaultAgentId: input.defaultAgentId } : {}),
    ...(input.env ? { env: input.env } : {}),
    sessionKey: input.sessionKey ?? "",
    ...(input.storePath !== undefined ? { storePath: input.storePath } : {}),
  });
}

// issue #118: Resolve a scope from a session key alone, with no explicit agent id. The agent id
// is derived from the key, so a malformed or agent-less key fails. It returns a Result and never
// throws. The caller must handle `ok: false`.
export function resolveSqliteScopeFromSessionKey(
  input: {
    sessionKey: string;
  } & Pick<SessionAccessScope, "defaultAgentId" | "env" | "storePath">,
): SqliteScopeResult {
  try {
    const scope = resolveSqliteScopeCore({
      ...(input.defaultAgentId !== undefined ? { defaultAgentId: input.defaultAgentId } : {}),
      ...(input.env ? { env: input.env } : {}),
      sessionKey: input.sessionKey,
      ...(input.storePath !== undefined ? { storePath: input.storePath } : {}),
    });
    return { ok: true, scope };
  } catch (error) {
    if (isSqliteScopeResolutionError(error)) {
      return { ok: false, error };
    }
    throw error;
  }
}

export function resolveSqliteReadScope(
  scope: Pick<
    SessionTranscriptReadScope,
    "agentId" | "defaultAgentId" | "env" | "sessionKey" | "storePath"
  >,
  targetCache?: SessionSqliteTargetResolutionCache,
): ResolvedSqliteReadScope {
  const sessionKey = scope.sessionKey ? normalizeSqliteSessionKey(scope.sessionKey) : undefined;
  const parsedAgentId = parseAgentSessionKey(sessionKey)?.agentId;
  const scopedAgentId = scope.agentId ? normalizeAgentId(scope.agentId) : parsedAgentId;
  const incognitoAgentId = isIncognitoSessionKey(sessionKey)
    ? resolveAgentIdFromSessionKey(sessionKey)
    : undefined;
  const effectiveStorePath = incognitoAgentId
    ? resolveIncognitoOpenClawAgentSqlitePath({ agentId: incognitoAgentId, env: scope.env })
    : scope.storePath;
  const effectiveAgentId = incognitoAgentId ?? scopedAgentId;
  const storeTarget = effectiveStorePath
    ? resolveCachedSqliteStoreTarget(
        {
          agentId: effectiveAgentId,
          defaultAgentId: scope.defaultAgentId,
          env: scope.env,
          storePath: effectiveStorePath,
        },
        targetCache,
      )
    : undefined;
  const agentId = resolveSqliteAgentId({
    scopedAgentId: effectiveAgentId,
    sessionKey,
    storeAgentId: storeTarget?.agentId,
    storeShared: storeTarget?.shared,
  });
  if (!agentId) {
    throw new SqliteScopeResolutionError(
      "Cannot resolve SQLite transcript read scope without an agent id",
    );
  }
  return {
    agentId,
    ...(storeTarget?.shared && storeTarget.agentId ? { databaseAgentId: storeTarget.agentId } : {}),
    ...(scope.env ? { env: scope.env } : {}),
    ...(storeTarget ? { path: storeTarget.path } : {}),
    ...(sessionKey ? { sessionKey } : {}),
  };
}

function resolveCachedSqliteStoreTarget(
  params: {
    agentId?: string;
    defaultAgentId?: string;
    env?: NodeJS.ProcessEnv;
    storePath: string;
  },
  targetCache: SessionSqliteTargetResolutionCache | undefined,
): ReturnType<typeof resolveSqliteTargetFromSessionStorePath> {
  if (!targetCache) {
    return resolveSqliteTargetFromSessionStorePath(params.storePath, {
      agentId: params.agentId,
      defaultAgentId: params.defaultAgentId,
      ...(params.env ? { env: params.env } : {}),
    });
  }
  // Store ownership is stable for this batch. Scope the cache to the caller so later requests
  // still observe owner changes after migration, install, or doctor flows.
  const envCache = targetCache.get(params.env) ?? new Map();
  targetCache.set(params.env, envCache);
  const cacheKey = JSON.stringify([params.storePath, params.agentId, params.defaultAgentId]);
  const cached = envCache.get(cacheKey);
  if (cached) {
    return cached;
  }
  const resolved = resolveSqliteTargetFromSessionStorePath(params.storePath, {
    agentId: params.agentId,
    defaultAgentId: params.defaultAgentId,
    ...(params.env ? { env: params.env } : {}),
  });
  envCache.set(cacheKey, resolved);
  return resolved;
}

// issue #118: The store path owns an agent id when the database is owned. When the caller also
// gives an explicit agent id, use the explicit-agent path. When it does not, the store path is
// the only source of the agent id, so derive it through the session-key Result path (empty key)
// and let the store-owner rule inside the core supply the agent id. A store with no owner and no
// explicit agent id cannot resolve; the Result reports that without a throw.
export function resolveSqliteStoreScope(
  storePath: string,
  options: { agentId?: string } = {},
): ResolvedSqliteScope {
  if (options.agentId) {
    return resolveSqliteScopeForAgent({
      agentId: options.agentId,
      storePath,
    });
  }
  const result = resolveSqliteScopeFromSessionKey({ sessionKey: "", storePath });
  if (!result.ok) {
    throw result.error;
  }
  return result.scope;
}

// issue #118: A full access scope carries a session key and may carry an agent id. It resolves
// through the explicit-agent path when an agent id is present, otherwise through the session-key
// Result path. A Result failure re-throws the typed error, so this helper keeps the pre-#118
// throw contract that the session accessor callers depend on. The gateway boundary (Layer 0) and
// the key validator (Layer 1) convert that throw to a typed client error before it can escape.
export function resolveSqliteAccessScope(
  scope: Pick<
    SessionAccessScope,
    "agentId" | "defaultAgentId" | "env" | "sessionKey" | "storePath"
  >,
): ResolvedSqliteScope {
  if (scope.agentId) {
    return resolveSqliteScopeForAgent({
      agentId: scope.agentId,
      ...(scope.defaultAgentId !== undefined ? { defaultAgentId: scope.defaultAgentId } : {}),
      ...(scope.env ? { env: scope.env } : {}),
      sessionKey: scope.sessionKey,
      ...(scope.storePath !== undefined ? { storePath: scope.storePath } : {}),
    });
  }
  const result = resolveSqliteScopeFromSessionKey({
    ...(scope.defaultAgentId !== undefined ? { defaultAgentId: scope.defaultAgentId } : {}),
    ...(scope.env ? { env: scope.env } : {}),
    sessionKey: scope.sessionKey,
    ...(scope.storePath !== undefined ? { storePath: scope.storePath } : {}),
  });
  if (!result.ok) {
    throw result.error;
  }
  return result.scope;
}

// issue #118: An agent-wide list or count scope has no single session key. It formerly passed
// `sessionKey: ""`. It resolves through the explicit-agent path when an agent id is present,
// otherwise through the session-key Result path (empty key), where the store-owner rule supplies
// the agent id from a `storePath`. A scope with neither an agent id nor an owned store cannot
// resolve; it throws the typed `SqliteScopeResolutionError`, the same failure the old empty-key
// call produced, now classifiable at the boundary and the backstop.
export function resolveSqliteAgentScope(
  scope: Pick<SessionAccessScope, "agentId" | "defaultAgentId" | "env" | "storePath">,
): ResolvedSqliteScope {
  if (scope.agentId) {
    return resolveSqliteScopeForAgent({
      agentId: scope.agentId,
      ...(scope.defaultAgentId !== undefined ? { defaultAgentId: scope.defaultAgentId } : {}),
      ...(scope.env ? { env: scope.env } : {}),
      ...(scope.storePath !== undefined ? { storePath: scope.storePath } : {}),
    });
  }
  const result = resolveSqliteScopeFromSessionKey({
    ...(scope.defaultAgentId !== undefined ? { defaultAgentId: scope.defaultAgentId } : {}),
    ...(scope.env ? { env: scope.env } : {}),
    sessionKey: "",
    ...(scope.storePath !== undefined ? { storePath: scope.storePath } : {}),
  });
  if (!result.ok) {
    throw result.error;
  }
  return result.scope;
}

function resolveSqliteAgentId(params: {
  scopedAgentId?: string;
  sessionKey?: string;
  storeAgentId?: string;
  storeShared?: boolean;
}): string | undefined {
  const scopedAgentId = params.scopedAgentId ? normalizeAgentId(params.scopedAgentId) : undefined;
  if (
    scopedAgentId &&
    params.storeAgentId &&
    scopedAgentId !== params.storeAgentId &&
    !params.storeShared
  ) {
    throw new SqliteAgentKeyMismatchError(
      `SQLite session store path belongs to agent ${params.storeAgentId}; requested agent ${scopedAgentId}.`,
    );
  }
  const parsedAgentId = params.sessionKey
    ? parseAgentSessionKey(params.sessionKey)?.agentId
    : undefined;
  return scopedAgentId ?? params.storeAgentId ?? parsedAgentId;
}

export function resolveSqliteTranscriptArchiveDirectory(
  scope: Pick<ResolvedSqliteReadScope, "agentId" | "env" | "path">,
): string {
  const databasePath = resolveOpenClawAgentSqlitePath(toDatabaseOptions(scope));
  const databaseDir = path.dirname(databasePath);
  if (path.basename(databaseDir) !== "agent") {
    return databaseDir;
  }
  return path.join(path.dirname(databaseDir), "sessions");
}

export function resolveSqliteTranscriptScope(
  scope: Pick<
    SessionTranscriptWriteScope,
    "agentId" | "env" | "sessionId" | "sessionKey" | "storePath"
  >,
): ResolvedTranscriptScope {
  if (!scope.sessionId) {
    throw new SqliteScopeResolutionError(
      `Cannot resolve SQLite transcript scope without a session id: ${scope.sessionKey}`,
    );
  }
  if (!scope.sessionKey) {
    throw new SqliteScopeResolutionError(
      `Cannot resolve SQLite transcript scope without a session key: ${scope.sessionId}`,
    );
  }
  const resolved = resolveTranscriptWriteBaseScope({
    ...(scope.agentId ? { agentId: scope.agentId } : {}),
    ...(scope.env ? { env: scope.env } : {}),
    sessionKey: scope.sessionKey,
    ...(scope.storePath !== undefined ? { storePath: scope.storePath } : {}),
  });
  return {
    ...resolved,
    sessionId: scope.sessionId,
  };
}

// issue #118: A transcript write already proved it holds a session key. It resolves through the
// explicit-agent path when an agent id is present, otherwise through the session-key Result path.
// A Result failure keeps the pre-#118 throw contract of this write scope.
function resolveTranscriptWriteBaseScope(input: {
  agentId?: string;
  env?: NodeJS.ProcessEnv;
  sessionKey: string;
  storePath?: string;
}): ResolvedSqliteScope {
  if (input.agentId) {
    return resolveSqliteScopeForAgent({
      agentId: input.agentId,
      ...(input.env ? { env: input.env } : {}),
      sessionKey: input.sessionKey,
      ...(input.storePath !== undefined ? { storePath: input.storePath } : {}),
    });
  }
  const result = resolveSqliteScopeFromSessionKey({
    ...(input.env ? { env: input.env } : {}),
    sessionKey: input.sessionKey,
    ...(input.storePath !== undefined ? { storePath: input.storePath } : {}),
  });
  if (!result.ok) {
    throw result.error;
  }
  return result.scope;
}

export function resolveSqliteTranscriptReadScope(
  scope: Pick<
    SessionTranscriptReadScope,
    "agentId" | "env" | "sessionId" | "sessionKey" | "storePath"
  >,
  targetCache?: SessionSqliteTargetResolutionCache,
): ResolvedTranscriptReadScope {
  return {
    ...resolveSqliteReadScope(scope, targetCache),
    sessionId: scope.sessionId,
  };
}

export function toDatabaseOptions(
  scope: Pick<ResolvedSqliteReadScope, "agentId" | "databaseAgentId" | "env" | "path">,
): OpenClawAgentDatabaseOptions {
  return {
    agentId: scope.databaseAgentId ?? scope.agentId,
    ...(scope.env ? { env: scope.env } : {}),
    ...(scope.path ? { path: scope.path } : {}),
  };
}

export function normalizeSqliteSessionKey(sessionKey: string): string {
  return normalizeStoreSessionKey(sessionKey);
}

export function cloneSessionEntry(entry: SessionEntry): SessionEntry {
  return structuredClone(entry);
}

export function formatSqliteSessionReferenceForScope(scope: ResolvedTranscriptScope): string {
  return scope.sessionKey;
}

/** Legacy identity string retained only for transcript artifact metadata and plugin contracts. */
export function formatLegacySqliteSessionMarkerForScope(scope: ResolvedTranscriptScope): string {
  return formatSqliteSessionFileMarker({
    agentId: scope.agentId,
    sessionId: scope.sessionId,
    storePath: scope.path ?? resolveOpenClawAgentSqlitePath(toDatabaseOptions(scope)),
  });
}
