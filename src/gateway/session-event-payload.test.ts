import { SESSION_EVENT_TOMBSTONE_FIELDS } from "@openclaw/gateway-protocol";
import { expect, it } from "vitest";
import { buildGatewaySessionEventFields } from "./session-event-payload.js";

it("projects present session actors and omits absent attribution (no null tombstone)", () => {
  const withActor = buildGatewaySessionEventFields({
    sessionRow: {
      key: "agent:main:owned",
      kind: "direct",
      updatedAt: 1,
      createdActor: { type: "human", id: "profile-ada", label: "Ada" },
      participants: [{ type: "human", id: "profile-bob", label: "Bob" }],
      participantCount: 1,
    },
  });
  expect(withActor).toMatchObject({
    createdActor: { type: "human", id: "profile-ada", label: "Ada" },
    participants: [{ type: "human", id: "profile-bob", label: "Bob" }],
    participantCount: 1,
  });
  // createdActor/archivedBy are not tombstone fields: an absent source value is
  // omitted, never sent as a null delete signal (issue #105).
  expect(withActor).not.toHaveProperty("archivedBy");

  const withArchiver = buildGatewaySessionEventFields({
    sessionRow: {
      key: "agent:main:archived",
      kind: "direct",
      updatedAt: 2,
      archivedBy: { type: "human", id: "profile-bob", label: "Bob" },
    },
  });
  expect(withArchiver).toMatchObject({
    archivedBy: { type: "human", id: "profile-bob", label: "Bob" },
    participants: [],
    participantCount: 0,
  });
  expect(withArchiver).not.toHaveProperty("createdActor");
});

it("projects the prepared permission boundary only for an explicit mode", () => {
  const ordinary = buildGatewaySessionEventFields({
    sessionRow: {
      key: "agent:main:ordinary",
      kind: "direct",
      sessionRoot: "/workspace/private",
      updatedAt: 3,
    },
  });
  // permissionMode is not a tombstone: an absent mode is omitted, not nulled.
  expect(ordinary).not.toHaveProperty("permissionMode");
  expect(ordinary).not.toHaveProperty("sessionRoot");

  expect(
    buildGatewaySessionEventFields({
      sessionRow: {
        key: "agent:main:workspace",
        kind: "direct",
        permissionMode: "workspace",
        sessionRoot: "/workspace/project",
        updatedAt: 4,
      },
    }),
  ).toMatchObject({ permissionMode: "workspace", sessionRoot: "/workspace/project" });
});

it("never serializes an undefined source field to a null (partial-patch invariant)", () => {
  // A row with only the minimum identity fields. Every other field is undefined.
  const built = buildGatewaySessionEventFields({
    sessionRow: {
      key: "agent:main:sparse",
      kind: "direct",
      updatedAt: 8,
    },
  });
  // No key may carry a null value: undefined sources are omitted, and no genuine
  // clear was requested here.
  const nullKeys = Object.keys(built).filter((key) => built[key] === null);
  expect(nullKeys).toEqual([]);
  // The absent optional fields are not present at all (true partial patch).
  for (const field of ["category", "thinkingLevel", "lastRunError", "toolOverrides", "goal"]) {
    expect(built).not.toHaveProperty(field);
  }
});

it("omits every undefined field regardless of whether it is a tombstone", () => {
  const built = buildGatewaySessionEventFields({
    agentId: "main",
    sessionRow: {
      key: "agent:main:undefined-fields",
      kind: "direct",
      updatedAt: 5,
      category: undefined,
      thinkingLevel: undefined,
      lastRunError: undefined,
      toolOverrides: undefined,
      observerDigest: undefined,
      controlOwnerSessionKey: undefined,
      restartRecoveryStatus: undefined,
      goal: undefined,
    },
  });
  for (const field of [
    "category",
    "thinkingLevel",
    "lastRunError",
    "toolOverrides",
    "observerDigest",
    "controlOwnerSessionKey",
    "restartRecoveryStatus",
    "goal",
  ]) {
    expect(built).not.toHaveProperty(field);
  }
});

// One test per intentional tombstone: a genuine null source serializes as a real
// clear so the client drops the field during merge-reconcile.
it("serializes a genuine null category as a real clear", () => {
  const built = buildGatewaySessionEventFields({
    sessionRow: { key: "agent:main:cat", kind: "direct", updatedAt: 6, category: null },
  });
  expect(built).toHaveProperty("category");
  expect(built.category).toBeNull();
});

it("serializes a genuine null thinkingLevel as a real clear", () => {
  const built = buildGatewaySessionEventFields({
    sessionRow: { key: "agent:main:think", kind: "direct", updatedAt: 6, thinkingLevel: null },
  });
  expect(built).toHaveProperty("thinkingLevel");
  expect(built.thinkingLevel).toBeNull();
});

it("serializes a genuine null lastRunError as a real clear", () => {
  const built = buildGatewaySessionEventFields({
    sessionRow: { key: "agent:main:err", kind: "direct", updatedAt: 6, lastRunError: null },
  });
  expect(built).toHaveProperty("lastRunError");
  expect(built.lastRunError).toBeNull();
});

it("serializes a cleared hasAutomation flag as a real clear", () => {
  // hasAutomation falls back to false when absent; a false value drops the flag
  // on the client just as a null tombstone would.
  const cleared = buildGatewaySessionEventFields({
    sessionRow: { key: "agent:main:auto-off", kind: "direct", updatedAt: 6 },
  });
  expect(cleared).toHaveProperty("hasAutomation");
  expect(cleared.hasAutomation).toBe(false);

  const set = buildGatewaySessionEventFields({
    sessionRow: {
      key: "agent:main:auto-on",
      kind: "direct",
      updatedAt: 6,
      hasAutomation: true,
    },
  });
  expect(set.hasAutomation).toBe(true);
});

it("keeps the shared tombstone list as the single declared source of truth", () => {
  expect([...SESSION_EVENT_TOMBSTONE_FIELDS].sort()).toEqual(
    ["category", "hasAutomation", "lastRunError", "thinkingLevel"].sort(),
  );
});
