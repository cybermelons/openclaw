// Whole-DB last-known-good (LKG) snapshot publish + synchronous corruption-fallback restore.
//
// CORRUPTION-FALLBACK.md Item 2/3, PHASE-1.md §6b. Publish runs off the async
// snapshot primitives (`sqlite-snapshot.ts`) after a clean boot. Restore runs
// synchronously inside the DB-open failure catch (`openclaw-agent-db.ts`),
// which is itself a fully synchronous call graph with 79 call sites that do
// not await it — restore therefore cannot invoke the async snapshot/publish
// primitives. It uses a plain verified file copy instead, then the caller
// re-enters the synchronous open funnel so the Phase 1 migration re-runs.
import fs from "node:fs";
import path from "node:path";
import type { DatabaseSync } from "node:sqlite";
import { openNodeSqliteDatabase } from "../infra/node-sqlite.js";
import { assertSqliteIntegrity } from "../infra/sqlite-integrity.js";
import { createVerifiedSqliteSnapshot } from "../infra/sqlite-snapshot.js";
import { createSubsystemLogger } from "../logging/subsystem.js";

const lkgLog = createSubsystemLogger("state/agent-db-lkg");

const OPENCLAW_AGENT_DB_LKG_SUFFIX = ".lkg";
const OPENCLAW_AGENT_DB_LKG_RETAINED_GENERATIONS = 2;
const OPENCLAW_AGENT_DB_LKG_MIN_PUBLISH_INTERVAL_MS = 60 * 60 * 1000;

/** Resolve the current LKG snapshot path for one agent database file. */
export function resolveOpenClawAgentDatabaseLkgPath(pathname: string): string {
  return `${pathname}${OPENCLAW_AGENT_DB_LKG_SUFFIX}`;
}

function resolveOpenClawAgentDatabaseLkgGenerationPath(
  pathname: string,
  generation: number,
): string {
  return `${resolveOpenClawAgentDatabaseLkgPath(pathname)}.${generation}`;
}

/** Move a terminally-corrupt database file aside for forensics; never overwrites. */
export function quarantineCorruptOpenClawAgentDatabaseFileSync(
  pathname: string,
): string | undefined {
  if (!fs.existsSync(pathname)) {
    return undefined;
  }
  const epochMs = Date.now();
  const basePath = `${pathname}.corrupt-${epochMs}`;
  for (let suffix = 0; ; suffix += 1) {
    const candidate = suffix === 0 ? basePath : `${basePath}-${suffix}`;
    try {
      fs.copyFileSync(pathname, candidate, fs.constants.COPYFILE_EXCL);
      fs.rmSync(pathname, { force: true });
      // WAL/journal sidecars are unusable once the main file is quarantined:
      // clear them so a fresh open never rehydrates the corrupt page state.
      for (const suffixName of ["-wal", "-shm", "-journal"]) {
        fs.rmSync(`${pathname}${suffixName}`, { force: true });
      }
      return candidate;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") {
        throw error;
      }
    }
  }
}

/**
 * Restore `pathname` synchronously from its LKG snapshot, if one exists.
 *
 * Returns the LKG snapshot's mtime (the "restored to snapshot from <timestamp>"
 * point) on success, or `undefined` when no LKG snapshot is present — callers
 * then fall back to an empty re-initialized database. Never silent: callers
 * must log the returned timestamp as the lossy-rewind caveat (CORRUPTION-FALLBACK
 * Item 2).
 */
export function restoreOpenClawAgentDatabaseFromLkgSync(pathname: string): Date | undefined {
  const lkgPath = resolveOpenClawAgentDatabaseLkgPath(pathname);
  if (!fs.existsSync(lkgPath)) {
    return undefined;
  }
  const lkgStat = fs.statSync(lkgPath);
  // Verify the LKG copy itself before trusting it as a restore source: a
  // damaged snapshot must never be promoted over the quarantined corrupt file.
  const verifyDb = openNodeSqliteDatabase(lkgPath, { readOnly: true });
  try {
    assertSqliteIntegrity(verifyDb, lkgPath);
  } finally {
    verifyDb.close();
  }
  fs.rmSync(pathname, { force: true });
  for (const suffixName of ["-wal", "-shm", "-journal"]) {
    fs.rmSync(`${pathname}${suffixName}`, { force: true });
  }
  fs.copyFileSync(lkgPath, pathname);
  return lkgStat.mtime;
}

function pruneOpenClawAgentDatabaseLkgGenerations(pathname: string): void {
  const lkgDir = path.dirname(pathname);
  const lkgBase = path.basename(resolveOpenClawAgentDatabaseLkgPath(pathname));
  let entries: string[];
  try {
    entries = fs.readdirSync(lkgDir);
  } catch {
    return;
  }
  const generationPattern = new RegExp(`^${escapeRegExp(lkgBase)}\\.(\\d+)$`);
  const generations = entries
    .map((name) => {
      const match = generationPattern.exec(name);
      return match ? { name, generation: Number(match[1]) } : undefined;
    })
    .filter((entry): entry is { name: string; generation: number } => entry !== undefined)
    .sort((a, b) => b.generation - a.generation);
  for (const stale of generations.slice(OPENCLAW_AGENT_DB_LKG_RETAINED_GENERATIONS)) {
    fs.rmSync(path.join(lkgDir, stale.name), { force: true });
  }
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function readOpenClawAgentDatabaseLkgPublishedAt(pathname: string): number | undefined {
  const lkgPath = resolveOpenClawAgentDatabaseLkgPath(pathname);
  try {
    return fs.statSync(lkgPath).mtimeMs;
  } catch {
    return undefined;
  }
}

/**
 * Publish a verified LKG snapshot of `pathname` after a clean startup, or on
 * an hourly cadence thereafter. Never runs on the hot write path; the caller
 * schedules this after `unlockStartupMethods` (PHASE-1.md §6b).
 *
 * Retention: newest 2 generations. The currently-published `<path>.lkg` is
 * rotated to `<path>.lkg.<generation>` before the fresh snapshot takes its
 * place, so a crash mid-publish never leaves zero usable snapshots.
 */
export async function publishOpenClawAgentDatabaseLkgSnapshot(
  pathname: string,
  options: { nowMs?: number; force?: boolean } = {},
): Promise<{ published: boolean; path?: string }> {
  if (!fs.existsSync(pathname)) {
    return { published: false };
  }
  const nowMs = options.nowMs ?? Date.now();
  if (!options.force) {
    const lastPublishedAt = readOpenClawAgentDatabaseLkgPublishedAt(pathname);
    if (
      lastPublishedAt !== undefined &&
      nowMs - lastPublishedAt < OPENCLAW_AGENT_DB_LKG_MIN_PUBLISH_INTERVAL_MS
    ) {
      return { published: false };
    }
  }
  const lkgPath = resolveOpenClawAgentDatabaseLkgPath(pathname);
  const stagedTargetPath = `${lkgPath}.staging-${nowMs}`;
  try {
    fs.rmSync(stagedTargetPath, { force: true });
    const snapshot = await createVerifiedSqliteSnapshot({
      sourcePath: pathname,
      targetPath: stagedTargetPath,
      validate: (database: DatabaseSync, label: string) => {
        assertSqliteIntegrity(database, label);
      },
    });
    if (fs.existsSync(lkgPath)) {
      let generation = 0;
      while (fs.existsSync(resolveOpenClawAgentDatabaseLkgGenerationPath(pathname, generation))) {
        generation += 1;
      }
      fs.renameSync(lkgPath, resolveOpenClawAgentDatabaseLkgGenerationPath(pathname, generation));
    }
    fs.renameSync(snapshot.path, lkgPath);
    pruneOpenClawAgentDatabaseLkgGenerations(pathname);
    return { published: true, path: lkgPath };
  } catch (error) {
    fs.rmSync(stagedTargetPath, { force: true });
    lkgLog.warn("failed to publish agent database LKG snapshot", {
      path: pathname,
      error: error instanceof Error ? error.message : String(error),
    });
    return { published: false };
  }
}
