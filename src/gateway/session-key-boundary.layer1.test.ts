// issue #124 Layer 1: the gateway request boundary must reject a present but structurally
// malformed client session key before any handler or storage call runs. This proves the
// proactive guard in runWithGatewayRequestEnvelope (server-methods.ts), not the reactive
// Layer 0 catch — see session-scope-dos.layer0.test.ts for that ring.
import { describe, expect, it, vi } from "vitest";
import {
  createGatewayMethodRegistry,
  createPluginGatewayMethodDescriptor,
} from "./methods/registry.js";
import { handleGatewayRequest } from "./server-methods.js";
import type { GatewayRequestHandler } from "./server-methods/types.js";
import { SESSION_KEY_PARAM_BY_METHOD } from "./session-sharing.js";

const MALFORMED_KEY = "agent::x";

async function dispatchWithKey(params: {
  method: string;
  paramName: "key" | "sessionKey";
  keyValue: string;
  handler: GatewayRequestHandler;
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
    client: {
      connId: "conn-session-key-boundary",
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
  return respond;
}

// One method per param name, covering both entries in SESSION_KEY_PARAM_BY_METHOD, plus a
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

  it("validates every method registered in SESSION_KEY_PARAM_BY_METHOD, not just the representative set", async () => {
    // Coverage-sync guard: a new session method added to SESSION_KEY_PARAM_BY_METHOD is exercised
    // here automatically, so it cannot silently ship without boundary validation.
    for (const [method, paramName] of SESSION_KEY_PARAM_BY_METHOD.entries()) {
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
});
