#!/usr/bin/env node

// Guards against catch clauses that turn a failure into an empty success value.
//
// `return []` for "nothing was found", "the file is missing", "I read the wrong
// storage backend", and "an error was swallowed" is the shape behind this repo's
// worst bug class: an action produces nothing, with nothing explaining why. A
// transcript reader that lost its history to a swallowed ENOENT reported exactly
// the same empty array as a genuinely new session, so the chat silently started
// over with its full history sitting unread on disk.
//
// A catch that returns empty must either prove the emptiness (rethrow anything it
// did not expect) or say something (log / return a failure-tagged value). The guard
// judges only the modules that own durable session state -- see GUARDED_PREFIXES for
// why scope is narrow -- and ratchets against a committed baseline so the existing
// sites can be paid down without blocking unrelated work.
import fs from "node:fs/promises";
import path from "node:path";
import ts from "typescript";
import { z } from "zod";
import { resolveRepoRoot } from "./lib/repo-root.mjs";
import {
  collectTypeScriptFilesFromRoots,
  resolveSourceRoots,
  runAsScript,
  toLine,
} from "./lib/ts-guard-utils.mts";

export type SilentEmptyCatchViolation = {
  file: string;
  line: number;
  fn: string;
  returns: string;
};

const violationSchema = z
  .object({
    file: z.string(),
    line: z.number(),
    fn: z.string(),
    returns: z.string(),
  })
  .strict();
const baselineSchema = z.array(violationSchema);

const baselineRelativePath = "scripts/lib/silent-empty-catch-baseline.json";
const baselineRegenCommand = "pnpm check:silent-empty-catch:gen";
const failurePrefix = "check-silent-empty-catch";

const SOURCE_ROOTS = ["src"];

/**
 * Modules that own durable session/transcript state, and the only files this guard
 * judges. Scope is deliberate: repo-wide, `catch { return false }` is overwhelmingly
 * ordinary predicate and optional-lookup code (a full-tree scan finds ~1500 such
 * sites, ~1465 of them outside this boundary). Guarding all of them would bury the
 * ~55 that can silently destroy a user's conversation, and a guard that cries wolf
 * gets suppressed rather than obeyed. Here, emptiness returned in place of a failure
 * means lost history, so it must be explained.
 */
const GUARDED_PREFIXES = [
  "src/config/sessions/",
  "src/agents/cli-runner/",
  "src/gateway/session-",
  "src/agents/sessions/",
];

/** Empty-success shapes: indistinguishable from a legitimate "nothing here". */
const EMPTY_LITERAL_KINDS = new Set<ts.SyntaxKind>([
  ts.SyntaxKind.NullKeyword,
  ts.SyntaxKind.FalseKeyword,
]);

function normalizeRelativePath(filePath: string) {
  return filePath.replaceAll(path.sep, "/");
}

export function isGuardedSource(filePath: string) {
  const normalized = normalizeRelativePath(filePath);
  return GUARDED_PREFIXES.some((prefix) => normalized.startsWith(prefix));
}

/** Doctor and migration code legitimately reads legacy shapes that may be absent. */
export function isExcludedSilentCatchSource(filePath: string) {
  const normalized = normalizeRelativePath(filePath);
  const segments = normalized.split("/");
  return (
    segments.some((segment) =>
      ["__mocks__", "__tests__", "test-helpers", "test-support", "doctor"].includes(segment),
    ) ||
    /\.(?:test|spec|e2e\.test)\.[cm]?tsx?$/u.test(normalized) ||
    /-test-(?:helpers|support)\.[cm]?[jt]s$/u.test(normalized) ||
    /(?:^|\/)(?:state-migrations|legacy)[^/]*\.[cm]?ts$/u.test(normalized)
  );
}

function describeEmptyReturn(expression: ts.Expression | undefined): string | undefined {
  if (!expression) {
    // `return;` inside a catch is an undefined success value.
    return "undefined";
  }
  if (ts.isIdentifier(expression) && expression.text === "undefined") {
    return "undefined";
  }
  if (EMPTY_LITERAL_KINDS.has(expression.kind)) {
    return expression.getText();
  }
  if (ts.isArrayLiteralExpression(expression) && expression.elements.length === 0) {
    return "[]";
  }
  if (ts.isObjectLiteralExpression(expression) && expression.properties.length === 0) {
    return "{}";
  }
  if (ts.isStringLiteralLike(expression) && expression.text === "") {
    return '""';
  }
  if (ts.isNumericLiteral(expression) && expression.text === "0") {
    return "0";
  }
  if (
    ts.isNewExpression(expression) &&
    ts.isIdentifier(expression.expression) &&
    ["Map", "Set"].includes(expression.expression.text) &&
    (expression.arguments?.length ?? 0) === 0
  ) {
    return `new ${expression.expression.text}()`;
  }
  return undefined;
}

/**
 * A catch that rethrows, reports, or returns a failure-tagged value has explained
 * itself. Anything that reaches a call expression is treated as reporting: the
 * point of the guard is silence, not a specific logger name.
 */
function catchExplainsItself(block: ts.Block): boolean {
  let explains = false;
  const visit = (node: ts.Node) => {
    if (explains) {
      return;
    }
    if (ts.isThrowStatement(node) || ts.isCallExpression(node)) {
      explains = true;
      return;
    }
    ts.forEachChild(node, visit);
  };
  ts.forEachChild(block, visit);
  return explains;
}

function collectEmptyReturns(block: ts.Block): ts.ReturnStatement[] {
  const returns: ts.ReturnStatement[] = [];
  const visit = (node: ts.Node) => {
    // Nested functions have their own control flow; their returns are not this
    // catch clause's result.
    if (ts.isFunctionLike(node)) {
      return;
    }
    if (ts.isReturnStatement(node) && describeEmptyReturn(node.expression) !== undefined) {
      returns.push(node);
    }
    ts.forEachChild(node, visit);
  };
  ts.forEachChild(block, visit);
  return returns;
}

function enclosingFunctionName(node: ts.Node): string {
  let current: ts.Node | undefined = node;
  while (current) {
    if (ts.isFunctionDeclaration(current) || ts.isMethodDeclaration(current)) {
      return current.name?.getText() ?? "<anonymous>";
    }
    if (ts.isVariableDeclaration(current) && current.name) {
      return current.name.getText();
    }
    current = current.parent;
  }
  return "<module>";
}

export function findSilentEmptyCatchViolations(
  filePath: string,
  content: string,
): SilentEmptyCatchViolation[] {
  const sourceFile = ts.createSourceFile(filePath, content, ts.ScriptTarget.Latest, true);
  const violations: SilentEmptyCatchViolation[] = [];
  const visit = (node: ts.Node) => {
    if (ts.isCatchClause(node)) {
      // A bound error the handler never inspects is still silent, so the binding
      // alone does not exempt: only an explanation does.
      if (!catchExplainsItself(node.block)) {
        for (const statement of collectEmptyReturns(node.block)) {
          violations.push({
            file: normalizeRelativePath(filePath),
            line: toLine(sourceFile, statement),
            fn: enclosingFunctionName(node),
            returns: describeEmptyReturn(statement.expression) ?? "undefined",
          });
        }
      }
    }
    ts.forEachChild(node, visit);
  };
  ts.forEachChild(sourceFile, visit);
  return violations;
}

function violationKey(violation: SilentEmptyCatchViolation) {
  // Line numbers move with unrelated edits; identity is the function plus shape.
  return `${violation.file}\0${violation.fn}\0${violation.returns}`;
}

function compareViolations(left: SilentEmptyCatchViolation, right: SilentEmptyCatchViolation) {
  return violationKey(left).localeCompare(violationKey(right));
}

export async function evaluateSilentEmptyCatch(repoRoot: string) {
  const roots = resolveSourceRoots(repoRoot, SOURCE_ROOTS);
  const files = await collectTypeScriptFilesFromRoots(roots, repoRoot);
  const current: SilentEmptyCatchViolation[] = [];
  for (const filePath of files) {
    const relative = normalizeRelativePath(path.relative(repoRoot, filePath));
    if (!isGuardedSource(relative) || isExcludedSilentCatchSource(relative)) {
      continue;
    }
    const content = await fs.readFile(filePath, "utf8");
    if (!content.includes("catch")) {
      continue;
    }
    current.push(...findSilentEmptyCatchViolations(relative, content));
  }
  current.sort(compareViolations);

  let baseline: SilentEmptyCatchViolation[] | undefined;
  try {
    const raw = await fs.readFile(path.join(repoRoot, baselineRelativePath), "utf8");
    baseline = baselineSchema.parse(JSON.parse(raw));
  } catch {
    // Missing baseline is reported by the caller as an actionable error, never as
    // a pass: an unreadable baseline must not silently disable this guard.
    baseline = undefined;
  }

  const baselineKeys = new Set((baseline ?? []).map(violationKey));
  const regressions = current.filter((violation) => !baselineKeys.has(violationKey(violation)));
  return { baseline, current, regressions };
}

async function main() {
  const repoRoot = resolveRepoRoot(import.meta.url);
  if (process.argv.includes("--write-baseline")) {
    const result = await evaluateSilentEmptyCatch(repoRoot);
    await fs.writeFile(
      path.join(repoRoot, baselineRelativePath),
      `${JSON.stringify(result.current, null, 2)}\n`,
    );
    console.log(`Wrote ${baselineRelativePath} (${result.current.length} entries)`);
    return 0;
  }

  const result = await evaluateSilentEmptyCatch(repoRoot);
  if (!result.baseline) {
    console.error(
      `Missing ${baselineRelativePath}; run \`${baselineRegenCommand}\` and commit it.`,
    );
    return 1;
  }
  if (result.regressions.length === 0) {
    console.log(
      `silent empty catch guard passed (${result.current.length} current, ${result.baseline.length} baselined).`,
    );
    return 0;
  }

  console.error(`Found catch clauses that return an empty value without explaining why:`);
  for (const violation of result.regressions) {
    console.error(
      `- ${violation.file}:${violation.line} ${violation.fn}() returns ${violation.returns}`,
    );
  }
  console.error(
    "Rethrow anything the handler did not expect, log at the moment of loss, or return a failure-tagged value. Emptiness must be a positive fact, never a fallback.",
  );
  return 1;
}

runAsScript(import.meta.url, async () => {
  let exitCode = 1;
  try {
    exitCode = await main();
  } catch (error) {
    console.error(error);
  }
  if (exitCode !== 0) {
    process.exitCode = exitCode;
    console.error(`[${failurePrefix}] FAILED (exit ${exitCode})`);
  }
});
