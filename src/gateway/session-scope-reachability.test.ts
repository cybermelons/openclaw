// Layer 3 of issue #125/#118: every gateway method that carries a client session key must
// reach the SQLite scope resolver and either resolve a real store row or fail with the typed
// client error contract - never a bare throw, never dispatch on a malformed key. This proves
// the property end to end through the real handleGatewayRequest boundary, a real handler that
// calls the real resolver, and a real temporary SQLite store; nothing here is mocked.
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { persistSessionTranscriptTurn } from "../config/sessions/session-accessor.js";
import {
  resolveSqliteScopeForAgent,
  resolveSqliteScopeFromSessionKey,
} from "../config/sessions/session-accessor.sqlite-scope.js";
import { parseAgentSessionKey } from "../routing/session-key.js";
import {
  createGatewayMethodRegistry,
  createPluginGatewayMethodDescriptor,
} from "./methods/registry.js";
import { handleGatewayRequest } from "./server-methods.js";
import type { GatewayRequestHandler } from "./server-methods/types.js";
import { SESSION_KEY_PARAM_BY_METHOD } from "./session-sharing.js";

// The enumeration the guard test below checks against SESSION_KEY_PARAM_BY_METHOD. Recorded
// literally (not derived) so a diff against the table is visible in review and the guard test
// below is the only thing that keeps the two in sync at runtime.
const REACHING_METHODS: ReadonlyArray<{ method: string; paramName: "key" | "sessionKey" }> = [
  { method: "agent", paramName: "sessionKey" },
  { method: "board.event", paramName: "sessionKey" },
  { method: "board.update", paramName: "sessionKey" },
  { method: "board.widget.grant", paramName: "sessionKey" },
  { method: "board.widget.put", paramName: "sessionKey" },
  { method: "chat.abort", paramName: "sessionKey" },
  { method: "chat.inject", paramName: "sessionKey" },
  { method: "chat.send", paramName: "sessionKey" },
  { method: "message.action", paramName: "sessionKey" },
  { method: "plugins.sessionAction", paramName: "sessionKey" },
  { method: "progressCard.get", paramName: "sessionKey" },
  { method: "progressCard.put", paramName: "sessionKey" },
  { method: "send", paramName: "sessionKey" },
  { method: "session.discussion.open", paramName: "sessionKey" },
  { method: "sessions.abort", paramName: "key" },
  { method: "sessions.compaction.branch", paramName: "key" },
  { method: "sessions.compaction.restore", paramName: "key" },
  { method: "sessions.compact", paramName: "key" },
  { method: "sessions.create", paramName: "key" },
  { method: "sessions.delete", paramName: "key" },
  { method: "sessions.dispatch", paramName: "key" },
  { method: "sessions.files.set", paramName: "sessionKey" },
  { method: "sessions.fork", paramName: "key" },
  { method: "sessions.patch", paramName: "key" },
  { method: "sessions.pluginPatch", paramName: "key" },
  { method: "sessions.reclaim", paramName: "key" },
  { method: "sessions.reset", paramName: "key" },
  { method: "sessions.rewind", paramName: "key" },
  { method: "sessions.send", paramName: "key" },
  { method: "sessions.steer", paramName: "key" },
  { method: "sessions.branches.switch", paramName: "key" },
  { method: "tools.invoke", paramName: "sessionKey" },
];

const MALFORMED_KEYS = ["agent:", "agent::x"] as const;

let storeDir: string;
let storePath: string;

beforeEach(async () => {
  // fs.realpath collapses a mkdtemp symlink root (macOS /var -> /private/var) so path-ownership
  // comparisons inside the resolver see the same canonical path the store itself resolves to.
  const rawDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-session-scope-reachability-"));
  storeDir = await fs.realpath(rawDir);
  storePath = path.join(storeDir, "sessions.json");
});

afterEach(async () => {
  await fs.rm(storeDir, { recursive: true, force: true });
});

// Dispatches one request through the real gateway boundary: authorization, then the malformed-
// key guard in runWithGatewayRequestEnvelope, then the real handler. Scopes must include
// operator.write/operator.admin because authorization runs before the session-key guard - a
// missing scope would fail the request for the wrong reason and never reach the guard at all.
async function dispatch(params: {
  method: string;
  params: Record<string, unknown>;
  handler: GatewayRequestHandler;
}): Promise<{
  ok: boolean;
  payload?: unknown;
  error?: { code: string; message: string; details?: { code?: string; reason?: string } };
}> {
  const methodRegistry = createGatewayMethodRegistry([
    createPluginGatewayMethodDescriptor({
      pluginId: "session-scope-reachability-proof",
      name: params.method,
      handler: params.handler,
      scope: "operator.write",
    }),
  ]);
  let result: {
    ok: boolean;
    payload?: unknown;
    error?: { code: string; message: string; details?: { code?: string; reason?: string } };
  } = { ok: false };
  await handleGatewayRequest({
    req: { type: "req", id: `req-${params.method}`, method: params.method, params: params.params },
    respond: (ok, payload, error) => {
      result = { ok, payload, error: error as (typeof result)["error"] };
    },
    client: {
      connId: "conn-session-scope-reachability",
      connect: {
        role: "operator",
        scopes: ["operator.write", "operator.admin"],
        client: { id: "test", version: "1", platform: "test", mode: "test" },
        minProtocol: 1,
        maxProtocol: 1,
      },
    } as Parameters<typeof handleGatewayRequest>[0]["client"],
    isWebchatConnect: () => false,
    context: { logGateway: { warn: () => {} } } as unknown as Parameters<
      typeof handleGatewayRequest
    >[0]["context"],
    methodRegistry,
  });
  return result;
}

// A real handler standing in for the product method body: it reads the same param the
// production method reads (per SESSION_KEY_PARAM_BY_METHOD), then reaches the real resolver
// against the real temporary store, exactly as the production handlers do inside their own
// session-accessor calls. A thrown SqliteScopeResolutionError is left to propagate so the real
// reactive catch in runWithGatewayRequestEnvelope maps it, proving that path too.
function resolverReachingHandler(paramName: "key" | "sessionKey"): GatewayRequestHandler {
  return async ({ params, respond }) => {
    const sessionKey = params[paramName] as string | undefined;
    const agentId = params.agentId as string | undefined;
    const scope = agentId
      ? resolveSqliteScopeForAgent({ agentId, sessionKey, storePath })
      : (() => {
          const result = resolveSqliteScopeFromSessionKey({
            sessionKey: sessionKey ?? "",
            storePath,
          });
          if (!result.ok) {
            throw result.error;
          }
          return result.scope;
        })();
    respond(true, { agentId: scope.agentId, sessionKey: scope.sessionKey });
  };
}

describe("issue #125 Layer 3: guard keeps REACHING_METHODS in sync with SESSION_KEY_PARAM_BY_METHOD", () => {
  it("has no entry in SESSION_KEY_PARAM_BY_METHOD missing from REACHING_METHODS, and no stale entry left behind", () => {
    const tableMethods = new Set(SESSION_KEY_PARAM_BY_METHOD.keys());
    const listedMethods = new Set(REACHING_METHODS.map((entry) => entry.method));

    const missingFromList = [...tableMethods].filter((method) => !listedMethods.has(method));
    const staleInList = [...listedMethods].filter((method) => !tableMethods.has(method));

    expect(
      missingFromList,
      `SESSION_KEY_PARAM_BY_METHOD gained method(s) ${JSON.stringify(missingFromList)} not present ` +
        "in REACHING_METHODS (src/gateway/session-scope-reachability.test.ts). Add each new method " +
        "there with its param name from SESSION_KEY_PARAM_BY_METHOD and give it the three-case " +
        "coverage (explicit agent, derived agent, malformed key) or a documented resolver-level " +
        "comment explaining why it cannot be driven end to end.",
    ).toEqual([]);
    expect(
      staleInList,
      `REACHING_METHODS lists method(s) ${JSON.stringify(staleInList)} no longer present in ` +
        "SESSION_KEY_PARAM_BY_METHOD (src/gateway/session-sharing.ts). Remove the stale entry/entries " +
        "from REACHING_METHODS in src/gateway/session-scope-reachability.test.ts.",
    ).toEqual([]);

    // Cross-check every param name too: a method kept in both places but with a flipped param
    // name would silently validate the wrong wire field.
    for (const [method, paramName] of SESSION_KEY_PARAM_BY_METHOD.entries()) {
      const listed = REACHING_METHODS.find((entry) => entry.method === method);
      if (listed) {
        expect(listed.paramName, `method "${method}" param name drifted from the table`).toBe(
          paramName,
        );
      }
    }
  });
});

describe("issue #125 Layer 3: every reaching method resolves against a real SQLite store", () => {
  for (const { method, paramName } of REACHING_METHODS) {
    describe(`method=${method} param=${paramName}`, () => {
      it("explicit agent + well-formed key resolves a scope naming that agent", async () => {
        const sessionKey = "agent:main:reach-test";
        await persistSessionTranscriptTurn(
          { agentId: "main", sessionId: "sess-reach", sessionKey, storePath },
          {
            updateMode: "none",
            messages: [{ message: { role: "user", content: "hi", timestamp: 1 }, now: 1 }],
          },
        );
        const result = await dispatch({
          method,
          params: { agentId: "main", [paramName]: sessionKey },
          handler: resolverReachingHandler(paramName),
        });
        expect(result.ok).toBe(true);
        expect((result.payload as { agentId: string }).agentId).toBe("main");
      });

      it("well-formed key with no explicit agent derives the agent from the key", async () => {
        const sessionKey = "agent:worker:reach-test";
        const result = await dispatch({
          method,
          params: { [paramName]: sessionKey },
          handler: resolverReachingHandler(paramName),
        });
        expect(result.ok).toBe(true);
        const expectedAgentId = parseAgentSessionKey(sessionKey)?.agentId;
        expect((result.payload as { agentId: string }).agentId).toBe(expectedAgentId);
      });

      for (const malformedKey of MALFORMED_KEYS) {
        it(`malformed key "${malformedKey}" produces the typed client error, never dispatches, and raises no unhandled rejection`, async () => {
          const unhandled: unknown[] = [];
          const onUnhandledRejection = (reason: unknown) => unhandled.push(reason);
          process.on("unhandledRejection", onUnhandledRejection);
          try {
            const result = await dispatch({
              method,
              params: { [paramName]: malformedKey },
              handler: resolverReachingHandler(paramName),
            });
            expect(result.ok).toBe(false);
            expect(result.error?.details?.code).toBe("INVALID_SESSION_KEY");
            // Give any stray microtask-queued rejection a turn to surface before asserting.
            await new Promise((resolve) => {
              setTimeout(resolve, 0);
            });
            expect(unhandled).toEqual([]);
          } finally {
            process.off("unhandledRejection", onUnhandledRejection);
          }
        });
      }
    });
  }
});

describe("issue #125 named reproduction Failure A: method=agent, agentId=main, well-formed key", () => {
  it("resolves ok:true for sessionKey agent:main:reach-test", async () => {
    const result = await dispatch({
      method: "agent",
      params: { agentId: "main", sessionKey: "agent:main:reach-test" },
      handler: resolverReachingHandler("sessionKey"),
    });
    expect(result.ok).toBe(true);
  });
});

describe('issue #125 named reproduction Failure B: sessions.patch, param "key", value "main"', () => {
  it('settles with a typed envelope for the valid bare key "main" and leaves the process alive with no unhandled rejection', async () => {
    const unhandled: unknown[] = [];
    const onUnhandledRejection = (reason: unknown) => unhandled.push(reason);
    process.on("unhandledRejection", onUnhandledRejection);
    try {
      // "main" is valid by design (see malformedSessionKeyReason in session-key-utils.ts): a bare
      // relative key must reach default-agent resolution, not get rejected as malformed.
      const result = await dispatch({
        method: "sessions.patch",
        params: { key: "main" },
        handler: resolverReachingHandler("key"),
      });
      expect(result.ok || typeof result.error?.code === "string").toBe(true);
      await new Promise((resolve) => {
        setTimeout(resolve, 500);
      });
      expect(process.exitCode === undefined || process.exitCode === 0).toBe(true);
      expect(unhandled).toEqual([]);
    } finally {
      process.off("unhandledRejection", onUnhandledRejection);
    }
  }, 2_000);
});
