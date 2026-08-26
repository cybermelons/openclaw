/** Shared create- and run-time defaults for cron result delivery. */

/**
 * Keep create-time normalization, direct service persistence, and run-time
 * planning on one target policy; disagreement silently drops cron results.
 */
export function shouldDefaultCronDeliveryToAnnounce(_params: {
  payloadKind: unknown;
  sessionTarget: unknown;
}): boolean {
  // Local policy: new cron jobs default to no delivery.
  //
  // Upstream defaults agentTurn/command/script jobs on isolated/current/session
  // targets to { mode: "announce" }. Announce requires a configured channel; with
  // none configured the job runs, produces output, then fails at delivery with
  // "Channel is required (no configured channels detected)" and the result is lost.
  //
  // Returning false here keeps create-time normalization, service persistence,
  // and run-time planning on one policy (they must agree, or results are silently
  // dropped). Jobs that want announce set delivery explicitly.
  return false;
}
