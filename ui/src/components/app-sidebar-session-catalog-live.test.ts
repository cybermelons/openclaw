// @vitest-environment node
import { describe, expect, it } from "vitest";
import { SessionCatalogLiveState } from "./app-sidebar-session-catalog-live.ts";

describe("SessionCatalogLiveState presence refreshes", () => {
  it("ignores mode-less and non-node presence churn", () => {
    const live = new SessionCatalogLiveState();

    expect(live.observePresence({ presence: [{ deviceId: "legacy-client" }] })).toBe(false);
    expect(
      live.observePresence({ presence: [{ deviceId: "operator-client", mode: "operator" }] }),
    ).toBe(false);
    expect(
      live.observePresence({ presence: [{ deviceId: "browser-client", mode: "webchat" }] }),
    ).toBe(false);
    expect(
      live.observePresence({
        presence: [{ deviceId: "operator-client", mode: "node", roles: ["operator"] }],
      }),
    ).toBe(false);
  });

  it("invalidates when explicit node presence changes", () => {
    const live = new SessionCatalogLiveState();

    expect(live.observePresence({ presence: [{ deviceId: "devbox", mode: "node" }] })).toBe(true);
    expect(live.observePresence({ presence: [{ deviceId: "devbox", mode: "node" }] })).toBe(false);
    expect(
      live.observePresence({
        presence: [{ deviceId: "devbox", mode: "node", reason: "disconnect" }],
      }),
    ).toBe(true);
  });

  it("accepts a mode-less presence entry with an authenticated node role", () => {
    const live = new SessionCatalogLiveState();

    expect(live.observePresence({ presence: [{ deviceId: "legacy-node", roles: ["node"] }] })).toBe(
      true,
    );
  });
});
