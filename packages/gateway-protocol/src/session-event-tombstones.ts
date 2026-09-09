/**
 * Single source of truth for the session-event fields a clear-event may set to
 * `null` as a real "delete this field" tombstone.
 *
 * The session-event protocol has no wire-level distinction between "field absent
 * from this event" (no information — client keeps its prior value) and "field
 * explicitly cleared" (client must drop it). We resolve that ambiguity with two
 * rules that both sides honor:
 *
 *   1. The payload builder (src/gateway/session-event-payload.ts) sends only the
 *      fields it has information about. Omission means "no information".
 *   2. The client reconcile loop (ui/src/lib/sessions/reconcile.ts) treats an
 *      incoming `null` as a delete tombstone ONLY for a field named here. A field
 *      not on this list can never be a delete signal, so a new nullable field is
 *      safe by default: if the builder does not send it, reconcile does not touch it.
 *
 * `updatedAt` and `activeLeafEntryId` are the schema's only legitimately nullable
 * row fields; reconcile keeps its own explicit handling for those and they are NOT
 * tombstones. Do not add them here.
 *
 * See issue #105 (class-fix) and #102 (the per-field quick fix this replaces).
 */
export const SESSION_EVENT_TOMBSTONE_FIELDS = [
  "thinkingLevel",
  "category",
  "lastRunError",
  "hasAutomation",
] as const;

export type SessionEventTombstoneField = (typeof SESSION_EVENT_TOMBSTONE_FIELDS)[number];

const TOMBSTONE_FIELD_SET: ReadonlySet<string> = new Set(SESSION_EVENT_TOMBSTONE_FIELDS);

/** True when a `null` for this field is an intentional clear, not accidental drift. */
export function isSessionEventTombstoneField(field: string): field is SessionEventTombstoneField {
  return TOMBSTONE_FIELD_SET.has(field);
}
