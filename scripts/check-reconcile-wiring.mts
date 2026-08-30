#!/usr/bin/env -S node --import tsx

/**
 * Verifies that the CLI transcript reconcile wiring survives the compiled dist build.
 *
 * `reconcileCliTranscript` (src/agents/cli-transcript-reconcile.ts) must reach both of its
 * known call sites in the compiled output:
 *   - src/agents/main-session-recovery/main-session-restart-dispatch.ts (resume + re-drain)
 *   - src/gateway/server-methods/chat-history-pages.ts
 *
 * The dist build (tsdown/Rolldown) splits source into content-hashed chunk files, so chunk
 * filenames are not stable across builds and cannot be checked by path. Instead this greps the
 * whole dist tree by content: the symbol name is preserved at every import/call site even when
 * the underlying binding is minified to a short alias (e.g. `import { n as reconcileCliTranscript }`),
 * so a text search for the literal identifier is a reliable, build-independent signal.
 *
 * Guards issue #53: a stripped/broken build must not silently ship without this wiring.
 */

import { existsSync, readFileSync } from "node:fs";
import { glob } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const SYMBOL = "reconcileCliTranscript";
const DEFINITION_RE = /\basync function reconcileCliTranscript\s*\(/u;
const CALL_RE = /\breconcileCliTranscript\s*\(/u;
const MIN_CALL_SITE_FILES = 2;

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
let callSiteFileCount = 0;

if (matchingFiles.length === 0) {
  console.error(`MISSING SYMBOL: "${SYMBOL}" does not appear anywhere in dist/.`);
  console.error(
    "The CLI transcript reconcile wiring is absent from the compiled build (issue #53).",
  );
  missing += 1;
} else {
  const callSiteFiles: string[] = [];
  for (const filePath of matchingFiles) {
    const content = readFileSync(filePath, "utf8");
    const isDefinitionFile = DEFINITION_RE.test(content);
    if (isDefinitionFile) {
      definitionFileCount += 1;
    }
    // A definition file's own function declaration also matches CALL_RE incidentally only if it
    // calls itself, which it does not; exclude definition files to count real call sites.
    if (!isDefinitionFile && CALL_RE.test(content)) {
      callSiteFiles.push(filePath);
    }
  }
  callSiteFileCount = callSiteFiles.length;

  if (definitionFileCount === 0) {
    console.error(
      `MISSING DEFINITION: "${SYMBOL}" appears in dist/ but its function definition was not found.`,
    );
    console.error("The reconcile implementation may have been stripped or renamed during build.");
    missing += 1;
  }

  if (callSiteFileCount < MIN_CALL_SITE_FILES) {
    console.error(
      `MISSING CALL SITES: "${SYMBOL}" is invoked from only ${callSiteFileCount} compiled chunk(s), expected at least ${MIN_CALL_SITE_FILES}.`,
    );
    console.error(
      "Expected call sites: main-session-restart-dispatch.ts (resume + re-drain) and chat-history-pages.ts.",
    );
    for (const filePath of callSiteFiles) {
      console.error(`  found call site: ${filePath}`);
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
  console.error(
    "called from main-session-restart-dispatch.ts and chat-history-pages.ts, then rebuild.",
  );
  process.exit(1);
}

console.log(
  `OK: "${SYMBOL}" wiring verified in dist/ (${definitionFileCount} definition chunk(s), ${callSiteFileCount} call-site chunk(s)).`,
);
