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
  // Phase 3 CS-3 added a sanctioned blob re-verification here:
  // hasSessionEntriesByStatusReadOnly projects each pre-narrowed row via
  // projectSessionEntry and decides membership on the blob status, not the
  // status COLUMN (§8c trap #1). That is exactly a blob reader, so this file
  // is an allowed importer.
  "config/sessions/session-accessor.sqlite-entry.ts",
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
      match[1]!
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
    tables.add(match[1]!);
  }
  for (const match of source.matchAll(RAW_TABLE_SQL_RE)) {
    tables.add(match[1]!.toLowerCase());
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
      const allowed = REASSEMBLY_FINGERPRINT_ALLOWED_FILES[token]!;
      const offenders = all
        .filter(({ relative, source }) => !isTestSourceFile(relative) && source.includes(token))
        .map(({ relative }) => relative)
        .filter((relative) => !allowed.has(relative));

      expect(offenders).toStrictEqual([]);
    },
  );
});

// FENCE 3 (Phase 3 §6/§8, CS-5): a demoted-column FACT-READ outside the
// writer allow-list fails lint. Phase 3 makes these columns write-only query
// indexes (PHASE-3.md §1): logic must read entry_json via
// projectSessionEntry, never a demoted column value as a fact. SQL may still
// FILTER/SORT on them (class (a), §2.2) — that is the index job and stays
// legal everywhere. What this fence blocks is a *named SELECT* of the
// column's VALUE (`.select([...  "status" ...])` / `SELECT status` raw-SQL
// style) in a file not on the allow-list below. `.selectAll()` and bare
// WHERE/ORDER BY references are not matched — they don't name the column as
// a picked-out value, and `.selectAll()` sites in this tree thread only the
// blob-projected `entry` through call sites, not raw column values (verified
// per site during Phase 3 CS-5 audit).
describe("session-entry-parse boundary fence (Phase 3 CS-5, §6/§8) — FENCE 3: demoted-column fact-read", () => {
  // The demoted columns (PHASE-3.md §6, CS-5 spec): their VALUE must never
  // be read as a fact outside the writer/sanctioned allow-list below.
  const DEMOTED_SESSION_NODES_COLUMNS = [
    "status",
    "archived_at",
    "last_activity_at",
    "parent_session_key",
  ] as const;
  const DEMOTED_SESSION_WINDOWS_COLUMNS = [
    "status",
    "display_name",
    "parent_session_key",
    "spawned_by",
  ] as const;
  const ALL_DEMOTED_COLUMNS = [
    ...new Set([...DEMOTED_SESSION_NODES_COLUMNS, ...DEMOTED_SESSION_WINDOWS_COLUMNS]),
  ];

  const DEMOTED_COLUMN_PROJECTION_TABLES = ["session_nodes", "session_windows"] as const;

  // Kysely-builder-style array select: `.select([..., "status", ...])` (also
  // matches the single-column form `.select("status")`). Scoped to a
  // `.selectFrom("session_nodes"|"session_windows")...select(...)` chain
  // (a bounded window after the matching `.selectFrom(`) so an unrelated
  // table's same-named column (e.g. a cron/task `status`) is not flagged —
  // the same table-scoping discipline FENCE 1b uses.
  function kyselySelectedDemotedColumns(source: string): Set<string> {
    const found = new Set<string>();
    const selectFromRe = new RegExp(
      `\\.selectFrom\\("(${DEMOTED_COLUMN_PROJECTION_TABLES.join("|")})"\\)`,
      "gu",
    );
    const selectCallRe = /\.select\(\s*(\[[^\]]*\]|"[^"]*"|'[^']*')\s*\)/gu;
    for (const fromMatch of source.matchAll(selectFromRe)) {
      const windowStart = fromMatch.index ?? 0;
      // 2000 chars is generous headroom past chained .leftJoin/.innerJoin
      // clauses (which can themselves span several lines) before the
      // `.select(` call that follows a `.selectFrom(...)` chain — wide
      // enough to reach the real select-array's closing `]` intact.
      const window = source.slice(windowStart, windowStart + 2000);
      selectCallRe.lastIndex = 0;
      const selectMatch = selectCallRe.exec(window);
      if (!selectMatch) {
        continue;
      }
      for (const column of ALL_DEMOTED_COLUMNS) {
        if (new RegExp(`["'](?:\\w+\\.)?${column}["']`, "u").test(selectMatch[1]!)) {
          found.add(column);
        }
      }
    }
    return found;
  }

  // Raw-SQL style: `SELECT ... FROM session_nodes|session_windows`-shaped
  // statements naming a demoted column in the column list (not inside a
  // WHERE/ORDER BY clause, which is a separate, still-legal class (a)
  // filter/sort use). Scoped to statements whose FROM target is one of the
  // two demoted-column tables so an unrelated table's same-named column is
  // not flagged.
  function rawSqlSelectedDemotedColumns(source: string): Set<string> {
    const found = new Set<string>();
    const selectClauseRe = new RegExp(
      `\\bSELECT\\b([^;]*?)\\bFROM\\b\\s+(${DEMOTED_COLUMN_PROJECTION_TABLES.join("|")})\\b`,
      "giu",
    );
    for (const match of source.matchAll(selectClauseRe)) {
      const columnList = match[1]!;
      for (const column of ALL_DEMOTED_COLUMNS) {
        if (new RegExp(`(^|[\\s,(])${column}([\\s,)]|$)`, "u").test(columnList)) {
          found.add(column);
        }
      }
    }
    return found;
  }

  function demotedColumnFactReads(source: string): Set<string> {
    return new Set([
      ...kyselySelectedDemotedColumns(source),
      ...rawSqlSelectedDemotedColumns(source),
    ]);
  }

  // Allow-list seeded from the current tree (2026-08-27, pre-CS-5 landing).
  // Every entry is a real, justified sanctioned site — not a Phase 3 leak:
  const DEMOTED_COLUMN_FACT_READ_ALLOW_LIST = new Set([
    // Note: the canonical writer, session-accessor.sqlite-session-row.ts,
    // binds/writes these columns (INSERT/UPDATE) but never SELECTs them, so
    // it is out of this fence's scope entirely and needs no allow-list
    // entry — writes are the columns' whole job (PHASE-3.md §1) and this
    // fence only flags SELECTs.
    //
    // Historical-generation reader (PHASE-3.md §5 CS-5 spec, documented
    // carve-out): SELECTs parent_session_key + spawned_by from
    // session_windows as generation/fork-lineage facts. This is the one
    // sanctioned non-writer fact-read Phase 3 keeps.
    "config/sessions/session-accessor.sqlite-history.ts",
    // Doctor/repair tooling: bypasses the accessor layer by design (see
    // FENCE 1b's non-config allow-list) to inspect and repair rows the
    // accessor layer cannot. Selects session_windows.parent_session_key +
    // spawned_by to rebuild incognito-key linkage during repair.
    "commands/doctor-session-incognito-key-repair.ts",
    // DB schema/migration + open-time validation ownership: reads
    // session_nodes.parent_session_key/spawned_by (via a leftJoin select)
    // as part of the canonical-key validation scan, not as
    // business-logic facts about a session's current state.
    "config/sessions/session-canonical-key.ts",
  ]);

  it("FENCE 3: no file outside the allow-list SELECTs a demoted column's value", async () => {
    const all = await loadSources();
    const offenders: string[] = [];
    for (const { relative, source } of all) {
      if (isTestSourceFile(relative) || DEMOTED_COLUMN_FACT_READ_ALLOW_LIST.has(relative)) {
        continue;
      }
      if (demotedColumnFactReads(source).size > 0) {
        offenders.push(relative);
      }
    }
    expect(offenders).toStrictEqual([]);
  });

  it("FENCE 3: every seeded allow-list entry is still live (no stale entries)", async () => {
    const all = await loadSources();
    const bySource = new Map(all.map((entry) => [entry.relative, entry.source]));
    for (const relative of DEMOTED_COLUMN_FACT_READ_ALLOW_LIST) {
      const source = bySource.get(relative);
      expect(source, `expected ${relative} to exist`).toBeDefined();
      expect(
        demotedColumnFactReads(source ?? "").size > 0,
        `expected ${relative} to still SELECT a demoted column`,
      ).toBe(true);
    }
  });

  it("FENCE 3 BITE TEST: the detector flags a planted violation and does not flag the clean tree", () => {
    const plantedViolationKysely = `
      const rows = db
        .selectFrom("session_nodes")
        .select(["session_key", "status", "entry_json"])
        .where("session_key", "=", key);
    `;
    expect(kyselySelectedDemotedColumns(plantedViolationKysely).has("status")).toBe(true);
    expect(demotedColumnFactReads(plantedViolationKysely).has("status")).toBe(true);

    const plantedViolationRawSql = `
      const stmt = "SELECT session_key, archived_at, entry_json FROM session_nodes WHERE session_key = ?";
    `;
    expect(rawSqlSelectedDemotedColumns(plantedViolationRawSql).has("archived_at")).toBe(true);
    expect(demotedColumnFactReads(plantedViolationRawSql).has("archived_at")).toBe(true);

    // A legal class (a) filter/sort use — the column appears only in WHERE,
    // never named in the SELECT list — must NOT be flagged.
    const legalFilterOnly = `
      const rows = db
        .selectFrom("session_nodes")
        .select(["session_key", "entry_json", "revision"])
        .where("status", "in", ["running"])
        .orderBy("archived_at", "desc");
    `;
    expect(demotedColumnFactReads(legalFilterOnly).size).toBe(0);

    // .selectAll() must not be flagged (matches the real readExactSessionEntryRow shape).
    const selectAllUse = `
      const row = db.selectFrom("session_nodes").selectAll().where("session_key", "=", key);
    `;
    expect(demotedColumnFactReads(selectAllUse).size).toBe(0);
  });
});
