// Phase 2 CS-5 lint fence (PHASE-2.md §7, T-P2e). Two mechanical gates that
// make re-fragmenting the collapsed parser/pipeline impossible to merge
// silently: an import fence (only sanctioned accessor files may import the
// one parser/pipeline) and a re-assembly fence (the owner-merge and
// participants-attach expressions may appear only inside the pipeline file
// itself, so a new inline re-assembly elsewhere fails this test instead of
// landing quietly). Static source grep, matching the existing repo pattern
// at `src/tasks/task-boundaries.test.ts` — no new lint framework.
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

type BoundarySource = {
  relative: string;
  source: string;
};

// FENCE 1a (§7.1): the sanctioned import allow-list for `parseSessionEntryBlob`
// and `projectSessionEntry` (the pipeline entry point). Derived by grepping
// every current `import { ... } from ".../session-entry-parse.js"` statement
// repo-wide for those two symbol names (2026-08-27, pre-CS-5 tree):
//   - session-accessor.sqlite-canonical-inventory.ts (projectSessionEntry)
//   - session-accessor.sqlite-canonical-repair.ts    (parseSessionEntryBlob)
//   - session-accessor.sqlite-entry-cache.ts         (projectSessionEntry)
//   - session-accessor.sqlite-entry-store.ts         (projectSessionEntry, readCanonicalSqliteSessionEntryRow)
//   - session-accessor.sqlite-status.ts              (projectSessionEntry)
// Zero exception comments: every current importer is a sanctioned accessor
// inside src/config/sessions/. Any future entry requires a phase-naming
// comment (§7).
const SESSION_ENTRY_PARSE_IMPORT_ALLOW_LIST = new Set([
  "config/sessions/session-accessor.sqlite-canonical-inventory.ts",
  "config/sessions/session-accessor.sqlite-canonical-repair.ts",
  "config/sessions/session-accessor.sqlite-entry-cache.ts",
  "config/sessions/session-accessor.sqlite-entry-store.ts",
  "config/sessions/session-accessor.sqlite-status.ts",
]);

const GUARDED_SYMBOLS = ["parseSessionEntryBlob", "projectSessionEntry"] as const;

// Matches `import { ... } from "<...>session-entry-parse.js"` (single- or
// multi-line import lists) so the guarded-symbol check below can inspect the
// imported name list, not just presence of the module specifier.
const SESSION_ENTRY_PARSE_IMPORT_RE =
  /import\s*(?:type\s*)?\{([^}]*)\}\s*from\s*"[^"]*session-entry-parse\.js"/gu;

function importedGuardedSymbols(source: string): string[] {
  const found = new Set<string>();
  for (const match of source.matchAll(SESSION_ENTRY_PARSE_IMPORT_RE)) {
    const names = new Set(
      match[1]
        .split(",")
        .map((entry) =>
          entry
            .trim()
            .split(/\s+as\s+/u)[0]
            ?.trim(),
        )
        .filter((entry): entry is string => Boolean(entry)),
    );
    for (const symbol of GUARDED_SYMBOLS) {
      if (names.has(symbol)) {
        found.add(symbol);
      }
    }
  }
  return [...found].toSorted();
}

// FENCE 1b (§7.1): SQL naming the three projection tables may only appear in
// template SQL under src/config/sessions/. Matches both raw-SQL keyword
// style (`FROM session_nodes`, `UPDATE session_windows`, ...) and Kysely
// builder style (`.selectFrom("session_participants")`, ...).
const PROJECTION_TABLES = ["session_nodes", "session_windows", "session_participants"] as const;
const KYSELY_TABLE_SQL_RE = new RegExp(
  `\\.(?:selectFrom|insertInto|updateTable|deleteFrom)\\("(${PROJECTION_TABLES.join("|")})"\\)`,
  "gu",
);
const RAW_TABLE_SQL_RE = new RegExp(
  `\\b(?:FROM|INTO|UPDATE|JOIN|TABLE)\\s+(${PROJECTION_TABLES.join("|")})\\b`,
  "giu",
);

function referencedProjectionTables(source: string): Set<string> {
  const tables = new Set<string>();
  for (const match of source.matchAll(KYSELY_TABLE_SQL_RE)) {
    tables.add(match[1]);
  }
  for (const match of source.matchAll(RAW_TABLE_SQL_RE)) {
    tables.add(match[1].toLowerCase());
  }
  return tables;
}

// FENCE 1b non-config exceptions (§7.1): pre-existing sites outside
// src/config/sessions/ that legitimately touch `session_nodes` /
// `session_windows` template SQL directly today — DB schema/migration
// ownership and doctor/repair tooling, neither of which routes through the
// accessor layer. `session_participants` has zero exceptions (verified
// below). Seeded from the CURRENT tree (2026-08-27) so the fence lands
// green; each entry is a real pre-Phase-2 site, not a Phase 2 leak.
const PROJECTION_SQL_NON_CONFIG_ALLOW_LIST = new Set([
  // Board store reads session_nodes directly to join board data onto a
  // session row; predates Phase 2, not part of the parser/pipeline collapse.
  "boards/sqlite-board-store.ts",
  // `doctor *` commands are the repair-tool layer: they intentionally bypass
  // the accessor module to fix rows the accessor layer cannot (or should
  // not) resolve on its own. Predates Phase 2.
  "commands/doctor-session-delivery-state.ts",
  "commands/doctor-session-entry-rewrite.ts",
  "commands/doctor-session-incognito-key-repair.ts",
  "commands/doctor-session-sqlite-readers.ts",
  "commands/doctor-session-transcript-headers.ts",
  "commands/doctor-telegram-general-topic-conversations.ts",
  // DB schema/migration ownership lives in src/state/, not the accessor
  // layer: table DDL, additive-column migrations, and open-time validation
  // necessarily name the raw tables. Predates Phase 2.
  "infra/state-migrations.media-persistence.ts",
  "state/openclaw-agent-db-open-validation.ts",
  "state/openclaw-agent-db-session-migrations.ts",
  "state/openclaw-agent-db-session-nodes-migration.ts",
]);

// FENCE 2 (§7.2): the 2 stable re-assembly fingerprints extracted from the
// pipeline (`session-entry-parse.ts`, PHASE-2.md §4):
//   - owner-merge: `projectSqliteSessionOwner(` — the one owner-projection
//     call in the shape -> owner -> participants chain. Stable because it is
//     a named, exported function call (not an inline object spread), and
//     the projection pipeline is its only caller repo-wide (its defining
//     module, `session-accessor.sqlite-owner-projection.ts`, matches only on
//     its own declaration line — not a second call site).
//   - participants-attach: `withProjectedParticipants(` — the one
//     participants-attach call. Stable for the same reason; its only callers
//     repo-wide are the pipeline file and its own defining module
//     (`session-accessor.sqlite-participant-projection.ts`, which also calls
//     it internally from `projectSqliteSessionParticipants(Batch)` — not a
//     re-assembly site, just the function's own home).
// A new inline re-assembly site reproducing either token outside these two
// files means someone rebuilt the owner or participants merge by hand
// instead of calling the pipeline — exactly the ponytail #3 regression this
// fence exists to block.
const REASSEMBLY_FINGERPRINTS = [
  { name: "owner-merge", token: "projectSqliteSessionOwner(" },
  { name: "participants-attach", token: "withProjectedParticipants(" },
] as const;

const PIPELINE_FILE = "config/sessions/session-entry-parse.ts";
const OWNER_MERGE_HOME_FILE = "config/sessions/session-accessor.sqlite-owner-projection.ts";
const PARTICIPANTS_ATTACH_HOME_FILE =
  "config/sessions/session-accessor.sqlite-participant-projection.ts";

const REASSEMBLY_FINGERPRINT_ALLOWED_FILES: Record<string, ReadonlySet<string>> = {
  "projectSqliteSessionOwner(": new Set([PIPELINE_FILE, OWNER_MERGE_HOME_FILE]),
  "withProjectedParticipants(": new Set([PIPELINE_FILE, PARTICIPANTS_ATTACH_HOME_FILE]),
};

let sources: BoundarySource[] = [];

async function loadSources(): Promise<BoundarySource[]> {
  if (sources.length === 0) {
    sources = await Promise.all(
      (await listSourceFiles(SRC_ROOT)).map(async (file) => ({
        relative: toRepoRelativePath(file),
        source: await fs.readFile(file, "utf8"),
      })),
    );
  }
  return sources;
}

describe("session-entry-parse boundary fence (Phase 2 CS-5, §7)", () => {
  it("FENCE 1a: only allow-listed accessor files import parseSessionEntryBlob/projectSessionEntry", async () => {
    const all = await loadSources();
    const importers = all
      .filter(
        ({ relative, source }) =>
          !isTestSourceFile(relative) && importedGuardedSymbols(source).length > 0,
      )
      .map(({ relative }) => relative);

    expect(importers.toSorted()).toEqual([...SESSION_ENTRY_PARSE_IMPORT_ALLOW_LIST].toSorted());
  });

  it("FENCE 1b: SQL naming session_nodes/session_windows/session_participants stays under src/config/sessions/ (or the seeded pre-existing exceptions)", async () => {
    const all = await loadSources();
    const offenders: string[] = [];
    for (const { relative, source } of all) {
      if (isTestSourceFile(relative) || relative.startsWith("config/sessions/")) {
        continue;
      }
      if (
        referencedProjectionTables(source).size > 0 &&
        !PROJECTION_SQL_NON_CONFIG_ALLOW_LIST.has(relative)
      ) {
        offenders.push(relative);
      }
    }
    expect(offenders).toStrictEqual([]);
  });

  it("FENCE 1b: session_participants has zero non-config exceptions", async () => {
    const all = await loadSources();
    const offenders = all
      .filter(
        ({ relative, source }) =>
          !isTestSourceFile(relative) &&
          !relative.startsWith("config/sessions/") &&
          referencedProjectionTables(source).has("session_participants"),
      )
      .map(({ relative }) => relative);

    expect(offenders).toStrictEqual([]);
  });

  it("FENCE 1b: every seeded non-config exception is still live (no stale allow-list entries)", async () => {
    const all = await loadSources();
    const bySource = new Map(all.map((entry) => [entry.relative, entry.source]));
    for (const relative of PROJECTION_SQL_NON_CONFIG_ALLOW_LIST) {
      const source = bySource.get(relative);
      expect(source, `expected ${relative} to exist`).toBeDefined();
      expect(
        referencedProjectionTables(source ?? "").size > 0,
        `expected ${relative} to still reference a projection table`,
      ).toBe(true);
    }
  });

  it.each(REASSEMBLY_FINGERPRINTS)(
    "FENCE 2: the $name fingerprint appears only inside its sanctioned file(s)",
    async ({ token }) => {
      const all = await loadSources();
      const allowed = REASSEMBLY_FINGERPRINT_ALLOWED_FILES[token];
      const offenders = all
        .filter(({ relative, source }) => !isTestSourceFile(relative) && source.includes(token))
        .map(({ relative }) => relative)
        .filter((relative) => !allowed.has(relative));

      expect(offenders).toStrictEqual([]);
    },
  );
});
