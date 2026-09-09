// @vitest-environment node
import { describe, expect, it, test } from "vitest";
import type { SessionsListResult } from "../../api/types.ts";
import {
  preserveRosterPresentationMetadata,
  reconcileSessionChanged,
  reconcileSessionHistory,
} from "./reconcile.ts";

function buildResult(sessions: SessionsListResult["sessions"]): SessionsListResult {
  return {
    ts: 1,
    path: "store",
    count: sessions.length,
    defaults: { modelProvider: null, model: null, contextTokens: null },
    sessions,
  };
}

describe("preserveRosterPresentationMetadata", () => {
  it("does not preserve presentation metadata without a known matching session identity", () => {
    const key = "agent:main:dashboard:replacement";

    expect(
      preserveRosterPresentationMetadata(
        { key, kind: "direct", sessionId: "replacement-session", updatedAt: 20 },
        {
          key,
          kind: "direct",
          updatedAt: 10,
          derivedTitle: "Previous session title",
          lastMessagePreview: "Previous session preview",
        },
      ),
    ).toEqual({
      key,
      kind: "direct",
      sessionId: "replacement-session",
      updatedAt: 20,
    });
  });

  it("does not infer archive state from row timestamps", () => {
    const key = "agent:main:dashboard:archived";

    expect(
      preserveRosterPresentationMetadata(
        { key, kind: "direct", sessionId: "s1", updatedAt: 10, archived: false },
        {
          key,
          kind: "direct",
          sessionId: "s1",
          updatedAt: 20,
          archived: true,
          archivedAt: 20,
        },
      ),
    ).toEqual({ key, kind: "direct", sessionId: "s1", updatedAt: 10, archived: false });
  });
});

test("sessions.changed keeps a label when a null arrives (label is not a tombstone)", () => {
  // label/displayName are not on the shared tombstone list, so an incoming null
  // can never delete them (issue #105). The real builder never sends null for
  // these; a stray null must be ignored, not treated as a clear.
  const result: SessionsListResult = {
    ts: 1,
    path: "",
    count: 1,
    defaults: { modelProvider: null, model: null, contextTokens: null },
    sessions: [
      {
        key: "agent:main:main",
        kind: "global",
        updatedAt: 1,
        label: "Named session",
        displayName: "Named session",
      },
    ],
  };

  const reconciled = reconcileSessionChanged(result, {
    sessionKey: "agent:main:main",
    reason: "patch",
    updatedAt: 2,
    label: null,
    displayName: null,
  } as never);

  expect(reconciled.applied).toBe(true);
  expect(reconciled.result?.sessions[0]?.label).toBe("Named session");
  expect(reconciled.result?.sessions[0]?.displayName).toBe("Named session");
});

test("reconciling the same sessions.changed twice keeps result identity on the second pass", () => {
  const result: SessionsListResult = {
    ts: 1,
    path: "",
    count: 1,
    defaults: { modelProvider: null, model: null, contextTokens: null },
    sessions: [{ key: "agent:main:main", kind: "direct", updatedAt: 1 }],
  };
  const payload = {
    sessionKey: "agent:main:main",
    reason: "patch",
    updatedAt: 2,
    label: "Renamed",
  };

  const first = reconcileSessionChanged(result, payload);
  expect(first.applied).toBe(true);
  expect(first.result).not.toBe(result);
  expect(first.result?.sessions[0]?.label).toBe("Renamed");

  // The capability handler and the chat page both drive the same event; the
  // second reconcile must return the identical result object so downstream
  // result === state.result publish gates skip the duplicate re-render.
  const second = reconcileSessionChanged(first.result ?? null, payload);
  expect(second.result).toBe(first.result);
});

test("sessions.changed ignores a null on a non-tombstone field (no delete drift)", () => {
  // These five fields used to leak literal null and get deleted by the old
  // hand-kept exempt loop. They are not on the shared tombstone list, so a null
  // must now be ignored and the prior value kept (issue #105 class-fix).
  const result: SessionsListResult = {
    ts: 1,
    path: "",
    count: 1,
    defaults: { modelProvider: null, model: null, contextTokens: null },
    sessions: [
      {
        key: "agent:main:main",
        kind: "direct",
        updatedAt: 1,
        toolOverrides: { profile: "coding" },
        controlOwnerSessionKey: "agent:main:owner",
        restartRecoveryStatus: "pending",
        goal: "ship it",
      } as never,
    ],
  };

  const reconciled = reconcileSessionChanged(result, {
    sessionKey: "agent:main:main",
    reason: "patch",
    updatedAt: 2,
    toolOverrides: null,
    observerDigest: null,
    controlOwnerSessionKey: null,
    restartRecoveryStatus: null,
    goal: null,
  } as never);

  expect(reconciled.applied).toBe(true);
  const row = reconciled.result?.sessions[0] as Record<string, unknown> | undefined;
  // Prior values survive; a null on a non-tombstone field is not a delete signal.
  expect(row?.toolOverrides).toEqual({ profile: "coding" });
  expect(row?.controlOwnerSessionKey).toBe("agent:main:owner");
  expect(row?.restartRecoveryStatus).toBe("pending");
  expect(row?.goal).toBe("ship it");
  expect(row?.updatedAt).toBe(2);
});

test("sessions.changed clears each shared-list tombstone field on a null", () => {
  // The 4 intentional tombstones must still clear on a genuine null.
  const result: SessionsListResult = {
    ts: 1,
    path: "",
    count: 1,
    defaults: { modelProvider: null, model: null, contextTokens: null },
    sessions: [
      {
        key: "agent:main:main",
        kind: "direct",
        updatedAt: 1,
        category: "Gita",
        thinkingLevel: "high",
        lastRunError: "boom",
        hasAutomation: true,
      } as never,
    ],
  };

  const reconciled = reconcileSessionChanged(result, {
    sessionKey: "agent:main:main",
    reason: "patch",
    updatedAt: 2,
    category: null,
    thinkingLevel: null,
    lastRunError: null,
    hasAutomation: null,
  } as never);

  expect(reconciled.applied).toBe(true);
  const row = reconciled.result?.sessions[0] as Record<string, unknown> | undefined;
  for (const field of ["category", "thinkingLevel", "lastRunError", "hasAutomation"]) {
    expect(row?.[field], field).toBeUndefined();
  }
  expect(row?.updatedAt).toBe(2);
});

test("sessions.changed invalidates the complete creator facet until canonical refresh", () => {
  const key = "agent:main:main";
  const result = buildResult([
    {
      key,
      kind: "global",
      updatedAt: 1,
      createdActor: { type: "human", id: "profile-ada", label: "Ada" },
    },
  ]);
  result.creators = [{ id: "profile-ada", label: "Ada" }];

  const reconciled = reconcileSessionChanged(result, {
    sessionKey: key,
    reason: "reset",
    updatedAt: 2,
    createdActor: { type: "human", id: "profile-bob", label: "Bob" },
  });

  expect(reconciled.result?.sessions[0]?.createdActor?.id).toBe("profile-bob");
  expect(reconciled.result?.creators).toBeUndefined();
});

test("sessions.changed preserves the creator facet when ownership is unchanged", () => {
  const key = "agent:main:main";
  const createdActor = { type: "human" as const, id: "profile-ada", label: "Ada" };
  const result = buildResult([{ key, kind: "global", updatedAt: 1, createdActor }]);
  result.creators = [{ id: createdActor.id, label: createdActor.label }];

  const reconciled = reconcileSessionChanged(result, {
    sessionKey: key,
    reason: "send",
    updatedAt: 2,
    createdActor,
  });

  expect(reconciled.result?.creators).toEqual([{ id: createdActor.id, label: createdActor.label }]);
});

test("sessions.changed applies reassignment and invalidates the complete owner facet", () => {
  const key = "agent:main:main";
  const createdActor = { type: "human" as const, id: "profile-ada", label: "Ada" };
  const result = buildResult([{ key, kind: "global", updatedAt: 1, createdActor }]);
  result.creators = [{ id: createdActor.id, label: createdActor.label }];

  const reconciled = reconcileSessionChanged(result, {
    sessionKey: key,
    reason: "owner",
    updatedAt: 1,
    owner: {
      actor: { type: "agent", id: "research", label: "Research" },
      assignedBy: createdActor,
      assignedAt: 2,
    },
  });

  expect(reconciled.result?.sessions[0]?.owner).toMatchObject({
    actor: { id: "research" },
    assignedAt: 2,
  });
  expect(reconciled.result?.creators).toBeUndefined();
});

describe("reconcileSessionChanged", () => {
  it("drops a cleared category from the merged row", () => {
    const key = "agent:main:discord:channel:1";
    const result = buildResult([
      { key, kind: "group", updatedAt: 1, sessionId: "s1", category: "Research" },
    ]);
    const next = reconcileSessionChanged(result, {
      sessionKey: key,
      key,
      kind: "group",
      updatedAt: 2,
      sessionId: "s1",
      category: null,
    });
    expect(next.applied).toBe(true);
    expect(next.row?.category).toBeUndefined();
  });

  it("applies an updated category to the merged row", () => {
    const key = "agent:main:discord:channel:1";
    const result = buildResult([{ key, kind: "group", updatedAt: 1, sessionId: "s1" }]);
    const next = reconcileSessionChanged(result, {
      sessionKey: key,
      key,
      kind: "group",
      updatedAt: 2,
      sessionId: "s1",
      category: "Research",
    });
    expect(next.applied).toBe(true);
    expect(next.row?.category).toBe("Research");
  });

  it("replaces thinking metadata when the same model changes runtime", () => {
    const key = "agent:main:main";
    const result = buildResult([
      {
        key,
        kind: "global",
        updatedAt: 1,
        sessionId: "s1",
        modelProvider: "openai",
        model: "gpt-5.6-luna",
        agentRuntime: { id: "openclaw", source: "model" },
        thinkingLevels: [
          { id: "max", label: "max" },
          { id: "ultra", label: "ultra" },
        ],
        thinkingOptions: ["max", "ultra"],
      },
    ]);
    const next = reconcileSessionChanged(result, {
      sessionKey: key,
      key,
      kind: "global",
      updatedAt: 2,
      sessionId: "s1",
      modelProvider: "openai",
      model: "gpt-5.6-luna",
      agentRuntime: { id: "codex", source: "session-key" },
      thinkingLevels: [{ id: "max", label: "max" }],
      thinkingOptions: ["max"],
    });

    expect(next.row?.agentRuntime?.id).toBe("codex");
    expect(next.row?.thinkingLevels).toEqual([{ id: "max", label: "max" }]);
    expect(next.row?.thinkingOptions).toEqual(["max"]);
  });

  it("drops stale picker metadata when a runtime-change event omits catalog fields", () => {
    const key = "agent:main:main";
    const result = buildResult([
      {
        key,
        kind: "global",
        updatedAt: 1,
        sessionId: "s1",
        modelProvider: "openai",
        model: "gpt-5.6-luna",
        agentRuntime: { id: "openclaw", source: "model" },
        thinkingLevels: [
          { id: "max", label: "max" },
          { id: "ultra", label: "ultra" },
        ],
        thinkingOptions: ["max", "ultra"],
        thinkingDefault: "medium",
      },
    ]);

    const next = reconcileSessionChanged(result, {
      sessionKey: key,
      key,
      kind: "global",
      updatedAt: 2,
      sessionId: "s1",
      modelProvider: "openai",
      model: "gpt-5.6-luna",
      agentRuntime: { id: "codex", source: "session-key" },
    });

    expect(next.row?.agentRuntime?.id).toBe("codex");
    expect(next.row?.thinkingLevels).toBeUndefined();
    expect(next.row?.thinkingOptions).toBeUndefined();
    expect(next.row?.thinkingDefault).toBeUndefined();
  });

  it("does not let stale chat history overwrite a newer runtime switch", () => {
    const key = "agent:main:main";
    const current = buildResult([
      {
        key,
        kind: "global",
        updatedAt: 3,
        sessionId: "s1",
        modelProvider: "openai",
        model: "gpt-5.6-luna",
        agentRuntime: { id: "codex", source: "session-key" },
        thinkingLevels: [{ id: "max", label: "max" }],
      },
    ]);

    const next = reconcileSessionHistory(
      current,
      {
        key,
        kind: "global",
        updatedAt: 2,
        sessionId: "s1",
        modelProvider: "openai",
        model: "gpt-5.6-luna",
        agentRuntime: { id: "openclaw", source: "session-key" },
        thinkingLevels: [
          { id: "max", label: "max" },
          { id: "ultra", label: "ultra" },
        ],
      },
      undefined,
    );

    expect(next).toBe(current);
  });

  it("replaces same-model defaults when their runtime changes", () => {
    const key = "agent:main:main";
    const result: SessionsListResult = {
      ...buildResult([{ key, kind: "global", updatedAt: 1, sessionId: "s1" }]),
      defaults: {
        modelProvider: "openai",
        model: "gpt-5.6-luna",
        contextTokens: null,
        agentRuntime: { id: "openclaw", source: "model" },
        thinkingLevels: [
          { id: "max", label: "max" },
          { id: "ultra", label: "ultra" },
        ],
      },
    };

    const next = reconcileSessionHistory(
      result,
      { key, kind: "global", updatedAt: 1, sessionId: "s1" },
      {
        modelProvider: "openai",
        model: "gpt-5.6-luna",
        contextTokens: null,
        agentRuntime: { id: "codex", source: "model" },
        thinkingLevels: [{ id: "max", label: "max" }],
      },
    );

    expect(next?.defaults.agentRuntime?.id).toBe("codex");
    expect(next?.defaults.thinkingLevels).toEqual([{ id: "max", label: "max" }]);
  });

  it("preserves catalog-backed options when an event omits picker metadata", () => {
    const key = "agent:main:main";
    const thinkingLevels = [
      { id: "max", label: "max" },
      { id: "ultra", label: "ultra" },
    ];
    const result = buildResult([
      {
        key,
        kind: "global",
        updatedAt: 1,
        sessionId: "s1",
        modelProvider: "openai",
        model: "gpt-5.6-sol",
        agentRuntime: { id: "codex", source: "model" },
        thinkingLevels,
        thinkingOptions: ["max", "ultra"],
      },
    ]);
    const next = reconcileSessionChanged(result, {
      sessionKey: key,
      key,
      kind: "global",
      updatedAt: 2,
      sessionId: "s1",
      thinkingLevel: "ultra",
      agentRuntime: { id: "codex", source: "model" },
    });

    expect(next.row?.thinkingLevel).toBe("ultra");
    expect(next.row?.thinkingLevels).toEqual(thinkingLevels);
    expect(next.row?.thinkingOptions).toEqual(["max", "ultra"]);
  });

  it("clears a thinking override when the event carries null", () => {
    const key = "agent:main:main";
    const result = buildResult([
      {
        key,
        kind: "global",
        updatedAt: 1,
        sessionId: "s1",
        thinkingLevel: "ultra",
      },
    ]);
    const next = reconcileSessionChanged(result, {
      sessionKey: key,
      key,
      kind: "global",
      updatedAt: 2,
      sessionId: "s1",
      thinkingLevel: null,
    });

    expect(next.row?.thinkingLevel).toBeUndefined();
  });

  it("keeps archive-state changes in an all-status result", () => {
    const key = "agent:main:thread";
    const result = buildResult([{ key, kind: "direct", updatedAt: 1, sessionId: "s1" }]);

    const next = reconcileSessionHistory(
      result,
      { key, kind: "direct", updatedAt: 2, sessionId: "s1", archived: true },
      undefined,
      { archivedFilter: "all" },
    );

    expect(next?.sessions).toEqual([
      expect.objectContaining({ key, archived: true, updatedAt: 2 }),
    ]);
  });

  it("applies the archived=false flag on an unarchive event", () => {
    // archivedBy/archivedAt are not tombstone fields (issue #105): the builder
    // omits them when undefined, and reconcile keeps any prior value. The UI
    // gates archive attribution on the archived flag and the archived status
    // filter, so a lingering archivedBy behind archived=false is never rendered.
    // What must reconcile is the archived flag itself.
    const key = "agent:main:thread";
    const result = buildResult([
      {
        key,
        kind: "direct",
        updatedAt: 1,
        sessionId: "s1",
        archived: true,
        archivedAt: 1,
        archivedBy: { type: "human", id: "profile-ada", label: "Ada" },
      },
    ]);

    const next = reconcileSessionChanged(
      result,
      {
        sessionKey: key,
        key,
        kind: "direct",
        updatedAt: 2,
        sessionId: "s1",
        archived: false,
      },
      { archivedFilter: "all" },
    );

    expect(next.row?.archived).toBe(false);
    expect(next.result?.sessions[0]?.archived).toBe(false);
  });
});

describe("reconcileSessionHistory", () => {
  it("preserves roster-derived presentation fields during targeted history hydration", () => {
    const key = "agent:main:dashboard:session-1";
    const result = buildResult([
      {
        key,
        kind: "direct",
        sessionId: "session-1",
        updatedAt: 1,
        derivedTitle: "Readable planning title",
        lastMessagePreview: "Latest visible reply",
      },
    ]);

    const reconciled = reconcileSessionHistory(
      result,
      {
        key,
        kind: "direct",
        sessionId: "session-1",
        updatedAt: 2,
        status: "running",
      },
      undefined,
    );

    expect(reconciled?.sessions[0]).toMatchObject({
      key,
      updatedAt: 2,
      status: "running",
      derivedTitle: "Readable planning title",
      lastMessagePreview: "Latest visible reply",
    });
  });

  it("does not preserve roster presentation fields across a session reset", () => {
    const key = "agent:main:dashboard:session";
    const result = buildResult([
      {
        key,
        kind: "direct",
        sessionId: "session-1",
        updatedAt: 1,
        derivedTitle: "Previous session title",
      },
    ]);

    const reconciled = reconcileSessionHistory(
      result,
      {
        key,
        kind: "direct",
        sessionId: "session-2",
        updatedAt: 2,
      },
      undefined,
    );

    expect(reconciled?.sessions[0]).toMatchObject({ sessionId: "session-2", updatedAt: 2 });
    expect(reconciled?.sessions[0]?.derivedTitle).toBeUndefined();
  });
});

describe("sessions.changed category catalog propagation", () => {
  test("a sessions.changed event without a categories field does not clear the stored client catalog", () => {
    const result: SessionsListResult = {
      ...buildResult([{ key: "agent:main:main", kind: "direct", updatedAt: 1 }]),
      categories: ["Gita", "Work"],
    };

    const reconciled = reconcileSessionChanged(result, {
      sessionKey: "agent:main:main",
      reason: "patch",
      updatedAt: 2,
      label: "Renamed",
    });

    expect(reconciled.applied).toBe(true);
    expect(reconciled.result?.categories).toEqual(["Gita", "Work"]);
  });

  it("a sessions.changed event with a categories field replaces the stored catalog", () => {
    const result: SessionsListResult = {
      ...buildResult([{ key: "agent:main:main", kind: "direct", updatedAt: 1 }]),
      categories: ["Gita"],
    };

    const reconciled = reconcileSessionChanged(result, {
      sessionKey: "agent:main:main",
      reason: "patch",
      updatedAt: 2,
      categories: ["Gita", "NewCategory"],
    } as never);

    expect(reconciled.applied).toBe(true);
    expect(reconciled.result?.categories).toEqual(["Gita", "NewCategory"]);
  });
});
