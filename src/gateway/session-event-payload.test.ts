import { expect, it } from "vitest";
import { buildGatewaySessionEventFields } from "./session-event-payload.js";

it("projects session actors and explicitly clears absent attribution", () => {
  expect(
    buildGatewaySessionEventFields({
      sessionRow: {
        key: "agent:main:owned",
        kind: "direct",
        updatedAt: 1,
        createdActor: { type: "human", id: "profile-ada", label: "Ada" },
        participants: [{ type: "human", id: "profile-bob", label: "Bob" }],
        participantCount: 1,
      },
    }),
  ).toMatchObject({
    createdActor: { type: "human", id: "profile-ada", label: "Ada" },
    archivedBy: null,
    participants: [{ type: "human", id: "profile-bob", label: "Bob" }],
    participantCount: 1,
  });

  expect(
    buildGatewaySessionEventFields({
      sessionRow: {
        key: "agent:main:archived",
        kind: "direct",
        updatedAt: 2,
        archivedBy: { type: "human", id: "profile-bob", label: "Bob" },
      },
    }),
  ).toMatchObject({
    createdActor: null,
    archivedBy: { type: "human", id: "profile-bob", label: "Bob" },
    participants: [],
    participantCount: 0,
  });
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
  expect(ordinary).toMatchObject({ permissionMode: null });
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

const UNDEFINED_TOLERANT_TOMBSTONE_FIELDS = [
  "category",
  "toolOverrides",
  "observerDigest",
  "controlOwnerSessionKey",
  "restartRecoveryStatus",
  "goal",
] as const;

it("omits undefined-tolerant fields instead of leaking a null tombstone", () => {
  const built = buildGatewaySessionEventFields({
    agentId: "main",
    sessionRow: {
      key: "agent:main:undefined-fields",
      kind: "direct",
      updatedAt: 5,
      category: undefined,
      toolOverrides: undefined,
      observerDigest: undefined,
      controlOwnerSessionKey: undefined,
      restartRecoveryStatus: undefined,
      goal: undefined,
    },
  });

  for (const field of UNDEFINED_TOLERANT_TOMBSTONE_FIELDS) {
    expect(built).not.toHaveProperty(field);
  }
});

it("still serializes a genuine null category as a real clear", () => {
  const built = buildGatewaySessionEventFields({
    sessionRow: {
      key: "agent:main:cleared-category",
      kind: "direct",
      updatedAt: 6,
      category: null,
    },
  });

  expect(built).toMatchObject({ category: null });
  expect(built).toHaveProperty("category");
});

it("freezes the declared tombstone list so a new field can't silently join it", () => {
  const declaredTombstones = ["thinkingLevel", "category", "lastRunError", "hasAutomation"];
  const built = buildGatewaySessionEventFields({
    sessionRow: {
      key: "agent:main:tombstone-freeze",
      kind: "direct",
      updatedAt: 7,
      thinkingLevel: undefined,
      category: undefined,
      lastRunError: undefined,
      hasAutomation: undefined,
      toolOverrides: undefined,
      observerDigest: undefined,
      controlOwnerSessionKey: undefined,
      restartRecoveryStatus: undefined,
      goal: undefined,
    },
  });

  const undefinedTolerantFields = [
    ...UNDEFINED_TOLERANT_TOMBSTONE_FIELDS,
    "thinkingLevel",
    "lastRunError",
    "hasAutomation",
  ];
  const nullFieldsFromUndefinedTolerantPath = undefinedTolerantFields.filter(
    (field) => built[field as keyof typeof built] === null,
  );

  for (const field of nullFieldsFromUndefinedTolerantPath) {
    expect(declaredTombstones).toContain(field);
  }
  // category and hasAutomation are declared tombstones but don't surface as `null` when
  // undefined: category is omitted (real fix), hasAutomation falls back to `false`.
  // toolOverrides/observerDigest/controlOwnerSessionKey/restartRecoveryStatus/goal are
  // also omitted, not nulled. Only thinkingLevel/lastRunError still leak `null` here —
  // both remain declared tombstones, so the freeze holds.
  expect(nullFieldsFromUndefinedTolerantPath.sort()).toEqual(["lastRunError", "thinkingLevel"]);
});
