// Phase 3 CS-5 — runtime soak tripwire, merge-time proxy (PHASE-3.md §4.2).
//
// §4.2 calls for a RUNTIME tripwire that logs any live SELECT of a droppable
// session_windows column ("status", "display_name") outside the
// allow-listed writers, running for a full soak release cycle in
// production. Adding live logging to the hot read path is invasive for a
// merge-time deliverable and the actual soak only starts after CS-6/CS-7
// land (§4.2 step 3, §5 CS-7 gate) — a production runtime signal has
// nothing to soak against yet at CS-5 time.
//
// This file is the merge-time PROXY for that soak signal: a static grep
// over the built read paths, asserting the source tree has ZERO live
// SELECTs of session_windows.status / session_windows.display_name outside
// the sanctioned carve-out (session-accessor.sqlite-history.ts) and the
// canonical writer. It reuses the exact FENCE 3 detector
// (session-entry-parse-boundary.phase2.test.ts) narrowed to session_windows
// + {status, display_name}, so this file and FENCE 3 cannot silently
// diverge on what counts as a "SELECT of the value."
//
// The production runtime tripwire (an actual log-on-SELECT hook wired into
// the accessor read path) is a POST-MERGE step: it ships once there is a
// running soak build to log against, per §4.2. This static test is what
// gates CS-5's merge today; it does not replace the runtime tripwire.
import fs from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";

const SRC_ROOT = path.resolve(import.meta.dirname, "..", "..");
const TEST_FILE_SUFFIXES = [".test.ts", ".test-support.ts", ".test-utils.ts", ".test-helpers.ts"];

function isTestSourceFile(name: string): boolean {
  return TEST_FILE_SUFFIXES.some((suffix) => name.endsWith(suffix));
}

async function listSourceFiles(root: string): Promise<string[]> {
  const entries = await fs.readdir(root, { withFileTypes: true });
  const files: string[] = [];
  for (const entry of entries) {
    const fullPath = path.join(root, entry.name);
    if (entry.isDirectory()) {
      files.push(...(await listSourceFiles(fullPath)));
      continue;
    }
    if (!entry.isFile() || !entry.name.endsWith(".ts")) {
      continue;
    }
    files.push(fullPath);
  }
  return files;
}

function toRepoRelativePath(file: string): string {
  return path.relative(SRC_ROOT, file).replaceAll(path.sep, "/");
}

// The two droppable session_windows columns this tripwire watches (§4.1
// expected-drop candidates, §4.2 soak scope). A narrower set than FENCE 3's
// full demoted-column list because the runtime soak tripwire specifically
// gates the DROP decision (§4.3), which only concerns columns with zero
// class (a) accesses — status/display_name are the ones with no shipped
// filter/sort use, per the audit.
const DROPPABLE_SESSION_WINDOWS_COLUMNS = ["status", "display_name"] as const;

function kyselySelectedDroppableColumns(source: string): Set<string> {
  const found = new Set<string>();
  const selectFromRe = /\.selectFrom\("session_windows"\)/gu;
  const selectCallRe = /\.select\(\s*(\[[^\]]*\]|"[^"]*"|'[^']*')\s*\)/gu;
  for (const fromMatch of source.matchAll(selectFromRe)) {
    const windowStart = fromMatch.index ?? 0;
    const window = source.slice(windowStart, windowStart + 2000);
    selectCallRe.lastIndex = 0;
    const selectMatch = selectCallRe.exec(window);
    if (!selectMatch) {
      continue;
    }
    for (const column of DROPPABLE_SESSION_WINDOWS_COLUMNS) {
      if (new RegExp(`["'](?:\\w+\\.)?${column}["']`, "u").test(selectMatch[1]!)) {
        found.add(column);
      }
    }
  }
  return found;
}

function rawSqlSelectedDroppableColumns(source: string): Set<string> {
  const found = new Set<string>();
  const selectClauseRe = /\bSELECT\b([^;]*?)\bFROM\b\s+session_windows\b/giu;
  for (const match of source.matchAll(selectClauseRe)) {
    const columnList = match[1];
    for (const column of DROPPABLE_SESSION_WINDOWS_COLUMNS) {
      if (new RegExp(`(^|[\\s,(])${column}([\\s,)]|$)`, "u").test(columnList!)) {
        found.add(column);
      }
    }
  }
  return found;
}

function droppableColumnLiveSelects(source: string): Set<string> {
  return new Set([
    ...kyselySelectedDroppableColumns(source),
    ...rawSqlSelectedDroppableColumns(source),
  ]);
}

// Carve-out + writer allow-list (mirrors FENCE 3's allow-list, narrowed to
// the entries that actually touch status/display_name on session_windows):
//   - session-accessor.sqlite-history.ts: the documented historical-
//     generation carve-out (PHASE-3.md §5 CS-5). It selects
//     parent_session_key/spawned_by, not status/display_name — included
//     here defensively in case that changes, per the spec's carve-out name.
// The canonical writer (session-accessor.sqlite-session-row.ts) never
// SELECTs these columns (INSERT/UPDATE only), so it needs no entry — same
// reasoning as FENCE 3.
const DROPPABLE_COLUMN_TRIPWIRE_ALLOW_LIST = new Set([
  "config/sessions/session-accessor.sqlite-history.ts",
]);

describe("Phase 3 CS-5 — droppable session_windows column tripwire (static merge-time proxy for §4.2 runtime soak)", () => {
  it("zero live SELECTs of session_windows.status / .display_name outside the carve-out + writers", async () => {
    const files = await listSourceFiles(SRC_ROOT);
    const offenders: string[] = [];
    for (const file of files) {
      const relative = toRepoRelativePath(file);
      if (isTestSourceFile(relative) || DROPPABLE_COLUMN_TRIPWIRE_ALLOW_LIST.has(relative)) {
        continue;
      }
      const source = await fs.readFile(file, "utf8");
      if (droppableColumnLiveSelects(source).size > 0) {
        offenders.push(relative);
      }
    }
    expect(offenders).toStrictEqual([]);
  });
});
