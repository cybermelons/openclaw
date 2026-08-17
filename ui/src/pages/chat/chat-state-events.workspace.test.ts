import { describe, expect, it, vi } from "vitest";
import { makeChatHost } from "./chat-host.test-support.ts";
import { handlePageGatewayEvent } from "./chat-state-events.ts";
import type { ChatPageHost } from "./chat-state-host.ts";
import { createSessionWorkspaceProps } from "./components/chat-session-workspace.ts";
import { openSlot } from "./sidebar-layout.ts";

describe("terminal chat workspace refresh", () => {
  it("uses status only when the stored workspace tab is not active", async () => {
    const sessionKey = "agent:main:current";
    const host = makeChatHost({
      hello: {
        type: "hello-ok",
        protocol: 3,
        auth: { role: "operator", scopes: ["operator.admin"] },
        features: { methods: ["sessions.workspace.status"] },
      },
      requestHandlers: {
        "artifacts.list": { artifacts: [] },
        "sessions.files.list": { files: [], gitCheckout: true, sessionKey },
        "sessions.workspace.status": { gitCheckout: true, sessionKey },
      },
      sessionKey,
    });
    const state = host as unknown as ChatPageHost;
    state.chatMessagesBySession = new Map();
    state.chatStreamRenderFrame = null;
    state.pendingSessionMessageReloadSessionKey = null;
    state.requestUpdate = vi.fn();
    state.sidebarLayout = openSlot(openSlot({ columns: [] }, "workspace"), "terminal");

    createSessionWorkspaceProps(state, { expanded: true });
    await vi.waitFor(() => expect(state.sessionWorkspaceState).toMatchObject({ loading: false }));
    const request = host.request;
    request.mockClear();

    handlePageGatewayEvent(state, {
      type: "event",
      event: "chat",
      payload: {
        message: { role: "assistant", content: [{ type: "text", text: "Done." }] },
        runId: "run-1",
        sessionKey,
        state: "final",
      },
    });

    await vi.waitFor(() =>
      expect(request).toHaveBeenCalledWith("sessions.workspace.status", {
        agentId: "main",
        sessionKey,
      }),
    );
    expect(request.mock.calls.some(([method]) => method === "sessions.files.list")).toBe(false);
    expect(request.mock.calls.some(([method]) => method === "artifacts.list")).toBe(false);
  });
});
