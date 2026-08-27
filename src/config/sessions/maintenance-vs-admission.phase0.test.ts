// Phase-0 characterization test: maintenance pass vs an active session work admission.
// runSessionRegistryMaintenanceForStore (session-registry-maintenance.ts) threads
// collectActiveSessionWorkAdmissionKeys as preserveKeys into pruneStaleEntries, so
// an admitted (in-turn) session is expected to be skipped rather than pruned.
// This pins the OBSERVED decision for both admission-by-sessionId and
// admission-by-session-key, and for both preview and apply modes.
import fs from "node:fs/promises";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { beginSessionWorkAdmission } from "../../sessions/session-lifecycle-admission.js";
import { closeOpenClawAgentDatabasesForTest } from "../../state/openclaw-agent-db.js";
import { closeOpenClawStateDatabaseForTest } from "../../state/openclaw-state-db.js";
import { createFixtureSuite } from "../../test-utils/fixture-suite.js";
import { loadSessionEntry, replaceSessionEntry } from "./session-accessor.js";
import { runSessionRegistryMaintenanceForStore } from "./session-registry-maintenance.js";
import type { SessionEntry } from "./types.js";

const DAY_MS = 24 * 60 * 60 * 1000;
const fixtureSuite = createFixtureSuite("openclaw-phase0-maintenance-vs-admission-");

beforeAll(async () => {
  await fixtureSuite.setup();
});

afterAll(async () => {
  closeOpenClawAgentDatabasesForTest();
  closeOpenClawStateDatabaseForTest();
  await fixtureSuite.cleanup();
});

function sessionEntry(sessionId: string, updatedAt: number): SessionEntry {
  return { sessionId, updatedAt, delivery: { kind: "none" } };
}

async function createStore(entries: Record<string, SessionEntry>): Promise<string> {
  const dir = await fixtureSuite.createCaseDir("store");
  const storePath = path.join(dir, "sessions.json");
  await fs.mkdir(dir, { recursive: true });
  for (const [sessionKey, entry] of Object.entries(entries)) {
    await replaceSessionEntry({ sessionKey, storePath }, entry);
  }
  return storePath;
}

describe("phase0: maintenance vs admission", () => {
  it("skips pruning a cron-run session admitted by sessionId, in apply mode", async () => {
    const now = Date.now();
    const sessionKey = "agent:main:cron:done-job:run:active-run";
    const sessionId = "active-run";
    const storePath = await createStore({
      [sessionKey]: sessionEntry(sessionId, now - 8 * DAY_MS),
    });
    const admission = await beginSessionWorkAdmission({
      scope: storePath,
      identities: [sessionId],
      assertAllowed: () => {},
    });

    try {
      const result = await runSessionRegistryMaintenanceForStore({
        apply: true,
        retentionMs: 7 * DAY_MS,
        runningCronJobIds: new Set(),
        storePath,
      });
      // Safe: maintenance observes the active admission and skips pruning.
      expect(result.pruned).toBe(0);
      expect(loadSessionEntry({ sessionKey, storePath })).toBeDefined();
    } finally {
      admission.release();
    }
  });

  it("skips pruning a cron-run session admitted by session key (not sessionId), in apply mode", async () => {
    const now = Date.now();
    const sessionKey = "agent:main:cron:done-job:run:active-run-by-key";
    const sessionId = "active-run-by-key";
    const storePath = await createStore({
      [sessionKey]: sessionEntry(sessionId, now - 8 * DAY_MS),
    });
    // Admit using the session KEY as the identity, rather than the sessionId.
    const admission = await beginSessionWorkAdmission({
      scope: storePath,
      identities: [sessionKey],
      assertAllowed: () => {},
    });

    try {
      const result = await runSessionRegistryMaintenanceForStore({
        apply: true,
        retentionMs: 7 * DAY_MS,
        runningCronJobIds: new Set(),
        storePath,
      });
      // Safe: collectActiveSessionWorkAdmissionKeys matches on normalized store
      // key as well as sessionId, so admission-by-key is still honored.
      expect(result.pruned).toBe(0);
      expect(loadSessionEntry({ sessionKey, storePath })).toBeDefined();
    } finally {
      admission.release();
    }
  });

  it("also reports the admitted session as not-pruned in preview mode (apply: false)", async () => {
    const now = Date.now();
    const sessionKey = "agent:main:cron:done-job:run:active-run-preview";
    const sessionId = "active-run-preview";
    const storePath = await createStore({
      [sessionKey]: sessionEntry(sessionId, now - 8 * DAY_MS),
    });
    const admission = await beginSessionWorkAdmission({
      scope: storePath,
      identities: [sessionId],
      assertAllowed: () => {},
    });

    try {
      const result = await runSessionRegistryMaintenanceForStore({
        apply: false,
        retentionMs: 7 * DAY_MS,
        runningCronJobIds: new Set(),
        storePath,
      });
      // Safe: preview mode runs the same preserveKeys computation, so the
      // admitted session is also excluded from the reported prune count.
      expect(result.pruned).toBe(0);
      expect(loadSessionEntry({ sessionKey, storePath })).toBeDefined();
    } finally {
      admission.release();
    }
  });

  it("prunes the session immediately once the admission releases", async () => {
    const now = Date.now();
    const sessionKey = "agent:main:cron:done-job:run:release-then-prune";
    const sessionId = "release-then-prune";
    const storePath = await createStore({
      [sessionKey]: sessionEntry(sessionId, now - 8 * DAY_MS),
    });
    const admission = await beginSessionWorkAdmission({
      scope: storePath,
      identities: [sessionId],
      assertAllowed: () => {},
    });
    admission.release();

    const result = await runSessionRegistryMaintenanceForStore({
      apply: true,
      retentionMs: 7 * DAY_MS,
      runningCronJobIds: new Set(),
      storePath,
    });
    expect(result.pruned).toBe(1);
    expect(loadSessionEntry({ sessionKey, storePath })).toBeUndefined();
  });
});
