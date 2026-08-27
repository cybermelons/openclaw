// Publish per-agent-database LKG snapshots after a clean startup, then on an
// hourly cadence thereafter (CORRUPTION-FALLBACK.md Item 2, PHASE-1.md §6b).
//
// Runs off the gateway's post-ready idle-task admission so it never competes
// with request-serving work, and never on the hot write path: publishing is
// throttled internally to at most once per hour per database regardless of
// how often this scheduler fires.
import { getActiveGatewayRootWorkCount } from "../process/gateway-work-admission.js";
import { publishOpenClawAgentDatabaseLkgSnapshot } from "../state/openclaw-agent-db-lkg.js";
import { listOpenClawRegisteredAgentDatabases } from "../state/openclaw-agent-db-registry-listing.js";
import { scheduleGatewayIdleTask } from "./server-idle-task.js";

const LKG_PUBLISH_START_DELAY_MS = 5_000;
const LKG_PUBLISH_RETRY_DELAY_MS = 250;
const LKG_PUBLISH_INTERVAL_MS = 60 * 60 * 1000;

type GatewayLkgPublishHandle = {
  stop: () => void;
};

async function publishAllRegisteredAgentDatabaseLkgSnapshots(params: {
  log: { warn: (msg: string) => void };
}): Promise<void> {
  let entries: ReturnType<typeof listOpenClawRegisteredAgentDatabases>;
  try {
    entries = listOpenClawRegisteredAgentDatabases();
  } catch (error) {
    params.log.warn(
      `post-ready.agent-db-lkg-publish failed to list registered databases: ${String(error)}`,
    );
    return;
  }
  for (const entry of entries) {
    try {
      await publishOpenClawAgentDatabaseLkgSnapshot(entry.path);
    } catch (error) {
      params.log.warn(`post-ready.agent-db-lkg-publish failed for ${entry.path}: ${String(error)}`);
    }
  }
}

/**
 * Schedule the recurring LKG snapshot publish. Fires once after the initial
 * idle-task delay, then every hour thereafter, until `stop()` is called.
 */
export function scheduleAgentDatabaseLkgPublish(params: {
  log: { warn: (msg: string) => void };
}): GatewayLkgPublishHandle {
  let stopped = false;
  let idleTask: ReturnType<typeof scheduleGatewayIdleTask> | undefined;
  let interval: ReturnType<typeof setInterval> | undefined;

  const runOnce = (delayMs: number) => {
    idleTask?.stop();
    idleTask = scheduleGatewayIdleTask({
      delayMs,
      retryDelayMs: LKG_PUBLISH_RETRY_DELAY_MS,
      isClosing: () => stopped,
      isBusy: () => getActiveGatewayRootWorkCount({ excludeCurrent: true }) > 0,
      run: () => publishAllRegisteredAgentDatabaseLkgSnapshots(params),
      log: params.log,
      errorMessage: "post-ready.agent-db-lkg-publish failed",
    });
  };

  runOnce(LKG_PUBLISH_START_DELAY_MS);
  interval = setInterval(() => {
    if (stopped) {
      return;
    }
    runOnce(0);
  }, LKG_PUBLISH_INTERVAL_MS);
  interval.unref?.();

  return {
    stop: () => {
      stopped = true;
      idleTask?.stop();
      if (interval) {
        clearInterval(interval);
        interval = undefined;
      }
    },
  };
}
