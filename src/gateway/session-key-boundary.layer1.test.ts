// issue #124 Layer 1 / #127: the gateway request boundary must reject a present but
// structurally malformed client session key before any handler, authorization, or storage
// call runs. This proves the proactive guard in handleGatewayRequest (server-methods.ts),
// which now sits ahead of authorizeGatewayRequestPreDispatch, not the reactive Layer 0 catch —
// see session-scope-dos.layer0.test.ts for that ring.
import {
  AgentParamsSchema,
  BoardLegacyEventParamsSchema,
  BoardUpdateParamsSchema,
  BoardWidgetGrantParamsSchema,
  BoardWidgetPutParamsSchema,
  ChatAbortParamsSchema,
  ChatInjectParamsSchema,
  ChatSendParamsSchema,
  MessageActionParamsSchema,
  PluginsSessionActionParamsSchema,
  ProgressCardGetParamsSchema,
  ProgressCardPutParamsSchema,
  SendParamsSchema,
  SessionDiscussionOpenParamsSchema,
  SessionsAbortParamsSchema,
  SessionsBranchesSwitchParamsSchema,
  SessionsCompactionBranchParamsSchema,
  SessionsCompactionRestoreParamsSchema,
  SessionsCompactParamsSchema,
  SessionsCreateParamsSchema,
  SessionsDeleteParamsSchema,
  SessionsDispatchParamsSchema,
  SessionsFilesSetParamsSchema,
  SessionsForkParamsSchema,
  SessionsPatchParamsSchema,
  SessionsPluginPatchParamsSchema,
  SessionsReclaimParamsSchema,
  SessionsResetParamsSchema,
  SessionsRewindParamsSchema,
  SessionsSendParamsSchema,
  ToolsInvokeParamsSchema,
} from "@openclaw/gateway-protocol/schema";
import { describe, expect, it, vi } from "vitest";
import {
  createGatewayMethodRegistry,
  createPluginGatewayMethodDescriptor,
} from "./methods/registry.js";
import { handleGatewayRequest } from "./server-methods.js";
import type { GatewayRequestContext, GatewayRequestHandler } from "./server-methods/types.js";
import { readClientSessionKeys } from "./session-mutation-targets.js";

/**
 * Hand-derived method -> protocol-schema map for every entry in
 * SESSION_KEY_PARAM_BY_METHOD, checked one-by-one against the schema files under
 * packages/gateway-protocol/src/schema/*.ts (no generic method->schema registry exists in
 * this repo to iterate instead). "sessions.steer" is intentionally absent: it reuses
 * SessionsSendParamsSchema through the same sessionMessagingHandlers dispatch as
 * "sessions.send", so it is asserted against that schema directly below instead of here.
 */
const SCHEMA_BY_METHOD: ReadonlyMap<string, unknown> = new Map<string, unknown>([
  ["agent", AgentParamsSchema],
  ["board.event", BoardLegacyEventParamsSchema],
  ["board.update", BoardUpdateParamsSchema],
  ["board.widget.grant", BoardWidgetGrantParamsSchema],
  ["board.widget.put", BoardWidgetPutParamsSchema],
  ["chat.abort", ChatAbortParamsSchema],
  ["chat.inject", ChatInjectParamsSchema],
  ["chat.send", ChatSendParamsSchema],
  ["message.action", MessageActionParamsSchema],
  ["plugins.sessionAction", PluginsSessionActionParamsSchema],
  ["progressCard.get", ProgressCardGetParamsSchema],
  ["progressCard.put", ProgressCardPutParamsSchema],
  ["send", SendParamsSchema],
  ["session.discussion.open", SessionDiscussionOpenParamsSchema],
  ["sessions.abort", SessionsAbortParamsSchema],
  ["sessions.compaction.branch", SessionsCompactionBranchParamsSchema],
  ["sessions.compaction.restore", SessionsCompactionRestoreParamsSchema],
  ["sessions.compact", SessionsCompactParamsSchema],
  ["sessions.create", SessionsCreateParamsSchema],
  ["sessions.delete", SessionsDeleteParamsSchema],
  ["sessions.dispatch", SessionsDispatchParamsSchema],
  ["sessions.files.set", SessionsFilesSetParamsSchema],
  ["sessions.fork", SessionsForkParamsSchema],
  ["sessions.patch", SessionsPatchParamsSchema],
  ["sessions.pluginPatch", SessionsPluginPatchParamsSchema],
  ["sessions.reclaim", SessionsReclaimParamsSchema],
  ["sessions.reset", SessionsResetParamsSchema],
  ["sessions.rewind", SessionsRewindParamsSchema],
  ["sessions.send", SessionsSendParamsSchema],
  ["sessions.steer", SessionsSendParamsSchema],
  ["sessions.branches.switch", SessionsBranchesSwitchParamsSchema],
  ["tools.invoke", ToolsInvokeParamsSchema],
]);

/** Reads a typebox object schema's declared top-level property names. */
function declaredPropertyNames(schema: unknown): string[] {
  const candidate = schema as { properties?: unknown };
  return candidate.properties && typeof candidate.properties === "object"
    ? Object.keys(candidate.properties)
    : [];
}

/**
 * The session-key param name a method's own protocol schema declares. Derived from the schema
 * rather than read back from the production table, so an assertion built on it stays an
 * independent check: a table entry naming a param the schema never declares disagrees with this
 * and fails, instead of being self-consistently wrong.
 */
function schemaSessionKeyParam(schema: unknown): "key" | "sessionKey" | undefined {
  const declared = declaredPropertyNames(schema);
  if (declared.includes("sessionKey")) {
    return "sessionKey";
  }
  return declared.includes("key") ? "key" : undefined;
}

const MALFORMED_KEY = "agent::x";

function buildOperatorClient(scopes: string[]) {
  return {
    connId: "conn-session-key-boundary",
    connect: {
      role: "operator",
      scopes,
      client: { id: "test", version: "1", platform: "test", mode: "test" },
      minProtocol: 1,
      maxProtocol: 1,
    },
  } as Parameters<typeof handleGatewayRequest>[0]["client"];
}

async function dispatchWithKey(params: {
  method: string;
  paramName: "key" | "sessionKey";
  keyValue: string;
  handler: GatewayRequestHandler;
  scopes?: string[];
  getRuntimeConfig?: GatewayRequestContext["getRuntimeConfig"];
}) {
  const methodRegistry = createGatewayMethodRegistry([
    createPluginGatewayMethodDescriptor({
      pluginId: "session-key-boundary-proof",
      name: params.method,
      handler: params.handler,
      scope: "operator.write",
    }),
  ]);
  const respond = vi.fn();
  await handleGatewayRequest({
    req: {
      type: "req",
      id: `req-${params.method}`,
      method: params.method,
      params: { [params.paramName]: params.keyValue },
    },
    respond,
    client: buildOperatorClient(params.scopes ?? ["operator.write", "operator.admin"]),
    isWebchatConnect: () => false,
    context: {
      logGateway: { warn: vi.fn() },
      ...(params.getRuntimeConfig ? { getRuntimeConfig: params.getRuntimeConfig } : {}),
    } as unknown as Parameters<typeof handleGatewayRequest>[0]["context"],
    methodRegistry,
  });
  return respond;
}

// One method per param name, covering both param-name variants the table uses, plus a
// representative spread of "key"-param and "sessionKey"-param methods named in the issue.
const REPRESENTATIVE_METHODS: Array<{ method: string; paramName: "key" | "sessionKey" }> = [
  { method: "sessions.patch", paramName: "key" },
  { method: "sessions.delete", paramName: "key" },
  { method: "sessions.reset", paramName: "key" },
  { method: "sessions.send", paramName: "key" },
  { method: "chat.send", paramName: "sessionKey" },
  { method: "tools.invoke", paramName: "sessionKey" },
  { method: "agent", paramName: "sessionKey" },
];

describe("issue #124 Layer 1: gateway request boundary rejects a malformed client session key", () => {
  for (const { method, paramName } of REPRESENTATIVE_METHODS) {
    it(`rejects method=${method} param=${paramName} without dispatching to the handler`, async () => {
      const storageEntry = vi.fn<GatewayRequestHandler>(({ respond }) =>
        respond(true, { ok: true }),
      );
      const respond = await dispatchWithKey({
        method,
        paramName,
        keyValue: MALFORMED_KEY,
        handler: storageEntry,
      });

      expect(storageEntry).not.toHaveBeenCalled();
      expect(respond).toHaveBeenCalledTimes(1);
      const [ok, , error] = respond.mock.calls[0] as [
        boolean,
        unknown,
        { code: string; details?: unknown },
      ];
      expect(ok).toBe(false);
      expect(error.code).toBe("INVALID_REQUEST");
      expect((error.details as { code?: string } | undefined)?.code).toBe("INVALID_SESSION_KEY");
    });
  }

  it("does not reject the method when its session key param is entirely absent", async () => {
    // Methods like sessions.abort legitimately fall back to a runId or board ticket instead of a
    // key param; absence must stay allowed and reach the handler.
    const storageEntry = vi.fn<GatewayRequestHandler>(({ respond }) => respond(true, { ok: true }));
    const methodRegistry = createGatewayMethodRegistry([
      createPluginGatewayMethodDescriptor({
        pluginId: "session-key-boundary-proof",
        name: "sessions.abort",
        handler: storageEntry,
        scope: "operator.write",
      }),
    ]);
    const respond = vi.fn();
    await handleGatewayRequest({
      req: { type: "req", id: "req-sessions-abort", method: "sessions.abort", params: {} },
      respond,
      client: {
        connId: "conn-session-key-boundary-absent",
        connect: {
          role: "operator",
          scopes: ["operator.write", "operator.admin"],
          client: { id: "test", version: "1", platform: "test", mode: "test" },
          minProtocol: 1,
          maxProtocol: 1,
        },
      } as Parameters<typeof handleGatewayRequest>[0]["client"],
      isWebchatConnect: () => false,
      context: { logGateway: { warn: vi.fn() } } as unknown as Parameters<
        typeof handleGatewayRequest
      >[0]["context"],
      methodRegistry,
    });
    expect(storageEntry).toHaveBeenCalledTimes(1);
  });

  it('accepts a legacy/alias key ("main") and dispatches to the handler', async () => {
    // Regression proof: "main" is valid client input (a bare relative key that
    // toAgentStoreSessionKey resolves to the default agent), not a malformed key. The boundary
    // must not reject it before that resolution runs.
    const storageEntry = vi.fn<GatewayRequestHandler>(({ respond }) => respond(true, { ok: true }));
    const respond = await dispatchWithKey({
      method: "sessions.patch",
      paramName: "key",
      keyValue: "main",
      handler: storageEntry,
    });

    expect(storageEntry).toHaveBeenCalledTimes(1);
    expect(respond).toHaveBeenCalledWith(true, { ok: true });
  });

  it("validates every key-bearing method against its own protocol schema, not just the representative set", async () => {
    // Coverage-sync guard, driven by SCHEMA_BY_METHOD rather than by the production table: a
    // method whose table entry names a param its schema never declares fails here instead of
    // silently skipping validation, which is the exact bug this issue fixed for
    // sessions.rewind/fork/branches.switch.
    for (const [method, schema] of SCHEMA_BY_METHOD) {
      const paramName = schemaSessionKeyParam(schema);
      expect(
        paramName,
        `method "${method}" schema declares neither "key" nor "sessionKey"`,
      ).toBeDefined();
      if (!paramName) {
        continue;
      }
      const storageEntry = vi.fn<GatewayRequestHandler>(({ respond }) =>
        respond(true, { ok: true }),
      );
      const respond = await dispatchWithKey({
        method,
        paramName,
        keyValue: MALFORMED_KEY,
        handler: storageEntry,
      });
      expect(
        storageEntry,
        `method "${method}" dispatched despite a malformed key`,
      ).not.toHaveBeenCalled();
      const [ok, , error] = respond.mock.calls[0] as [
        boolean,
        unknown,
        { code: string; details?: unknown },
      ];
      expect(ok, `method "${method}" did not reject the malformed key`).toBe(false);
      expect((error.details as { code?: string } | undefined)?.code).toBe("INVALID_SESSION_KEY");
    }
  });

  it("rejects a malformed key for a non-admin caller before authorization reads session storage", async () => {
    // Every case above used operator.admin, which resolveSessionMutationAuthorization
    // short-circuits before it ever reads storage on the raw key. A non-admin caller reaches
    // that storage read unless the boundary guard runs first; getRuntimeConfig is the earliest
    // probe resolveSessionMutationAuthorization makes on that path, so it must stay uncalled.
    const getRuntimeConfig: GatewayRequestContext["getRuntimeConfig"] = vi.fn(
      () => ({}) as ReturnType<GatewayRequestContext["getRuntimeConfig"]>,
    );
    const storageEntry = vi.fn<GatewayRequestHandler>(({ respond }) => respond(true, { ok: true }));
    const respond = await dispatchWithKey({
      method: "sessions.patch",
      paramName: "key",
      keyValue: MALFORMED_KEY,
      handler: storageEntry,
      scopes: ["operator.write"],
      getRuntimeConfig,
    });

    expect(storageEntry).not.toHaveBeenCalled();
    expect(getRuntimeConfig).not.toHaveBeenCalled();
    expect(respond).toHaveBeenCalledTimes(1);
    const [ok, , error] = respond.mock.calls[0] as [
      boolean,
      unknown,
      { code: string; details?: unknown },
    ];
    expect(ok).toBe(false);
    expect(error.code).toBe("INVALID_REQUEST");
    expect((error.details as { code?: string } | undefined)?.code).toBe("INVALID_SESSION_KEY");
  });

  describe("sessions.patchMany", () => {
    async function dispatchPatchMany(targetKeys: string[]) {
      const storageEntry = vi.fn<GatewayRequestHandler>(({ respond }) =>
        respond(true, { ok: true }),
      );
      const methodRegistry = createGatewayMethodRegistry([
        createPluginGatewayMethodDescriptor({
          pluginId: "session-key-boundary-proof",
          name: "sessions.patchMany",
          handler: storageEntry,
          scope: "operator.write",
        }),
      ]);
      const respond = vi.fn();
      await handleGatewayRequest({
        req: {
          type: "req",
          id: "req-sessions-patchMany",
          method: "sessions.patchMany",
          params: { targets: targetKeys.map((key) => ({ key })) },
        },
        respond,
        client: buildOperatorClient(["operator.write", "operator.admin"]),
        isWebchatConnect: () => false,
        context: { logGateway: { warn: vi.fn() } } as unknown as Parameters<
          typeof handleGatewayRequest
        >[0]["context"],
        methodRegistry,
      });
      return { respond, storageEntry };
    }

    it("rejects a malformed nested targets[].key without dispatching to the handler", async () => {
      // sessions.patchMany has no entry in SESSION_KEY_PARAM_BY_METHOD: its keys live at the
      // nested targets[].key array, not a flat param. readClientSessionKeys must still surface
      // them so the boundary guard catches a malformed one here.
      const { respond, storageEntry } = await dispatchPatchMany(["main", MALFORMED_KEY]);

      expect(storageEntry).not.toHaveBeenCalled();
      expect(respond).toHaveBeenCalledTimes(1);
      const [ok, , error] = respond.mock.calls[0] as [
        boolean,
        unknown,
        { code: string; details?: unknown },
      ];
      expect(ok).toBe(false);
      expect(error.code).toBe("INVALID_REQUEST");
      expect((error.details as { code?: string } | undefined)?.code).toBe("INVALID_SESSION_KEY");
    });

    it("dispatches to the handler when every target key is well-formed", async () => {
      const { respond, storageEntry } = await dispatchPatchMany(["main", "agent:main:main"]);

      expect(storageEntry).toHaveBeenCalledTimes(1);
      expect(respond).toHaveBeenCalledWith(true, { ok: true });
    });
  });

  describe("the session-key param table stays in sync with protocol schemas", () => {
    // Coverage-sync guard for the bug class this issue fixed: a method mapped to the wrong param
    // name (e.g. "key" when the schema only declares "sessionKey") previously passed every other
    // test here silently, because readClientSessionKeys read a field the request never carried
    // and returned no keys. These cases iterate SCHEMA_BY_METHOD — derived by hand from the
    // protocol schema files, independent of the production table — and probe the production
    // reader with the field name the SCHEMA declares. Driving the probe from the table's own
    // value instead would be self-consistent with a wrong entry and could not expose this class.
    for (const [method, schema] of SCHEMA_BY_METHOD) {
      const schemaFieldName = schemaSessionKeyParam(schema);

      it(`${method}'s protocol schema declares a session-key param`, () => {
        expect(
          schemaFieldName,
          `method "${method}" schema declares neither "key" nor "sessionKey"`,
        ).toBeDefined();
      });

      it(`readClientSessionKeys sees the key for method=${method} sent under its schema's own field name`, () => {
        expect(
          readClientSessionKeys(method, { [schemaFieldName as string]: MALFORMED_KEY }),
        ).toEqual([MALFORMED_KEY]);
      });
    }
  });
});
