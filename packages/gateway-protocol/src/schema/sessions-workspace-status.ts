import { type Static, Type } from "typebox";
import { closedObject } from "./closed-object.js";
import { NonEmptyString } from "./primitives.js";

/** Reads lightweight workspace facts without scanning a session transcript. */
export const SessionsWorkspaceStatusParamsSchema = closedObject({
  sessionKey: NonEmptyString,
  agentId: Type.Optional(NonEmptyString),
});

/** Lightweight workspace facts used by collapsed session controls. */
export const SessionsWorkspaceStatusResultSchema = closedObject({
  sessionKey: NonEmptyString,
  root: Type.Optional(NonEmptyString),
  gitCheckout: Type.Optional(Type.Boolean()),
});

export type SessionsWorkspaceStatusParams = Static<typeof SessionsWorkspaceStatusParamsSchema>;
export type SessionsWorkspaceStatusResult = Static<typeof SessionsWorkspaceStatusResultSchema>;
