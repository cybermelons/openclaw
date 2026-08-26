import type { Static } from "typebox";
import { Type } from "typebox";
import { closedObject } from "./closed-object.js";
import { NonEmptyString } from "./primitives.js";

export const WorkspaceRunBamParamsSchema = closedObject({
  sessionKey: NonEmptyString,
  path: NonEmptyString,
  line: Type.Optional(Type.Union([Type.Number(), Type.Null()])),
});
export type WorkspaceRunBamParams = Static<typeof WorkspaceRunBamParamsSchema>;

export const WorkspaceRunBamResultSchema = closedObject({
  ok: Type.Boolean(),
  path: Type.String(),
  error: Type.Optional(Type.String()),
});
export type WorkspaceRunBamResult = Static<typeof WorkspaceRunBamResultSchema>;
