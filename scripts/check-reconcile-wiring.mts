#!/usr/bin/env -S node --import tsx

/**
 * Verifies that the CLI transcript reconcile wiring survives the compiled dist build.
 *
 * `reconcileCliTranscript` (src/agents/cli-transcript-reconcile.ts) must reach both of its
 * known call sites in the compiled output, both in the crash-recovery path:
 *   - src/agents/main-session-recovery/main-session-restart-dispatch.ts (resume, reason: "recovery")
 *   - src/agents/main-session-recovery/main-session-restart-dispatch.ts (settle-ambiguous retry, reason: "recovery")
 *
 * A read path (src/gateway/server-methods/chat-history-pages.ts) used to hold a third call site,
 * but that caller was removed (issue #14): a chat-history READ must not WRITE a transcript
 * backfill, since it raced the live mirror's end-of-turn append and produced duplicate turns on
 * resume. Crash-recovery dispatch already re-drains genuinely lost turns, so backfill belongs to
 * recovery only. Do not re-add a reconcile call on the history-serve read path.
 *
 * The dist build (tsdown/Rolldown) splits source into content-hashed chunk files, so chunk
 * filenames are not stable across builds and cannot be checked by path. Instead this greps the
 * whole dist tree by content: the symbol name is preserved at every import/call site even when
 * the underlying binding is minified to a short alias (e.g. `import { n as reconcileCliTranscript }`),
 * so a text search for the literal identifier is a reliable, build-independent signal.
 *
 * Both call sites now live in the source file that also contains the only other caller, so
 * Rolldown may inline the shared `cli-transcript-reconcile.ts` module into the same chunk as its
 * caller rather than splitting it into its own chunk. That means a chunk can legitimately contain
 * both the function definition AND its call sites. `CALL_RE` also incidentally matches the
 * definition line itself (`async function reconcileCliTranscript(`), so this counts total call-like
 * occurrences per matching file and subtracts one per definition found in that file to get the
 * real call count, rather than assuming call sites and the definition live in disjoint files.
 *
 * Guards issue #53: a stripped/broken build must not silently ship without this wiring.
 */

import { existsSync, readFileSync } from "node:fs";
import { glob } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const SYMBOL = "reconcileCliTranscript";
const DEFINITION_RE = /\basync function reconcileCliTranscript\s*\(/gu;
const CALL_RE = /\breconcileCliTranscript\s*\(/gu;
const MIN_CALL_COUNT = 2;

const scriptDir = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(scriptDir, "..");
const distDir = resolve(repoRoot, "dist");

let missing = 0;

if (!existsSync(distDir)) {
  console.error(`MISSING DIST: ${distDir} does not exist. Run a build before this check.`);
  process.exit(1);
}

const matchingFiles: string[] = [];
for await (const entry of glob("**/*.{js,mjs,cjs}", { cwd: distDir })) {
  const filePath = resolve(distDir, entry);
  let content: string;
  try {
    content = readFileSync(filePath, "utf8");
  } catch {
    continue;
  }
  if (content.includes(SYMBOL)) {
    matchingFiles.push(filePath);
  }
}

let definitionFileCount = 0;
let totalCallCount = 0;
const callSiteFiles: string[] = [];

if (matchingFiles.length === 0) {
  console.error(`MISSING SYMBOL: "${SYMBOL}" does not appear anywhere in dist/.`);
  console.error(
    "The CLI transcript reconcile wiring is absent from the compiled build (issue #53).",
  );
  missing += 1;
} else {
  for (const filePath of matchingFiles) {
    const content = readFileSync(filePath, "utf8");
    const definitionMatches = content.match(DEFINITION_RE)?.length ?? 0;
    const rawCallMatches = content.match(CALL_RE)?.length ?? 0;
    if (definitionMatches > 0) {
      definitionFileCount += 1;
    }
    // CALL_RE also matches each definition's own declaration line
    // (`async function reconcileCliTranscript(`), so subtract those out to get
    // the real invocation count. A chunk can legitimately hold both the
    // definition and its call sites (Rolldown may inline a single-consumer
    // shared module into its caller's chunk), so this no longer excludes
    // definition files from the call count.
    const realCallMatches = rawCallMatches - definitionMatches;
    if (realCallMatches > 0) {
      totalCallCount += realCallMatches;
      callSiteFiles.push(filePath);
    }
  }

  if (definitionFileCount === 0) {
    console.error(
      `MISSING DEFINITION: "${SYMBOL}" appears in dist/ but its function definition was not found.`,
    );
    console.error("The reconcile implementation may have been stripped or renamed during build.");
    missing += 1;
  }

  if (totalCallCount < MIN_CALL_COUNT) {
    console.error(
      `MISSING CALL SITES: "${SYMBOL}" is invoked only ${totalCallCount} time(s) across dist/, expected at least ${MIN_CALL_COUNT}.`,
    );
    console.error(
      "Expected call sites: both in main-session-restart-dispatch.ts (recovery resume, and settle-ambiguous retry).",
    );
    for (const filePath of callSiteFiles) {
      console.error(`  found call site(s) in: ${filePath}`);
    }
    missing += 1;
  }
}

if (missing > 0) {
  console.error(`\nERROR: ${missing} reconcile-wiring check(s) failed.`);
  console.error(
    "This means a shipped build could silently omit the CLI transcript reconcile wiring.",
  );
  console.error(
    "Verify reconcileCliTranscript is exported from src/agents/cli-transcript-reconcile.ts and",
  );
  console.error("called from main-session-restart-dispatch.ts (recovery path), then rebuild.");
  process.exit(1);
}

console.log(
  `OK: "${SYMBOL}" wiring verified in dist/ (${definitionFileCount} definition chunk(s), ${totalCallCount} call site(s) across ${callSiteFiles.length} chunk(s)).`,
);
