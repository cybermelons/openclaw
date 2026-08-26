import { describe, expect, it } from "vitest";
import {
  findSilentEmptyCatchViolations,
  isExcludedSilentCatchSource,
  isGuardedSource,
} from "../../scripts/check-silent-empty-catch.mts";

const file = "src/config/sessions/example.ts";

describe("findSilentEmptyCatchViolations", () => {
  it("flags the transcript-reader shape that silently loses history", () => {
    // The real defect: a SQLite-backed session resolves to a `sqlite:` sentinel,
    // lstat throws ENOENT, and the caller cannot tell "no history" from "wrong
    // backend" because both arrive as [].
    const violations = findSilentEmptyCatchViolations(
      file,
      `export async function loadEntries(path: string) {
        try {
          return await readTranscript(path);
        } catch {
          return [];
        }
      }`,
    );

    expect(violations).toHaveLength(1);
    expect(violations[0]).toMatchObject({ file, fn: "loadEntries", returns: "[]" });
  });

  it.each([
    ["undefined", "return undefined;"],
    ["null", "return null;"],
    ["false", "return false;"],
    ["{}", "return {};"],
    ["undefined", "return;"],
  ])("flags a bare catch returning %s", (returns, statement) => {
    const violations = findSilentEmptyCatchViolations(
      file,
      `function read() { try { return load(); } catch { ${statement} } }`,
    );
    expect(violations).toHaveLength(1);
    expect(violations[0]?.returns).toBe(returns);
  });

  it("accepts a catch that rethrows what it did not expect", () => {
    expect(
      findSilentEmptyCatchViolations(
        file,
        `function read() {
          try {
            return load();
          } catch (error) {
            if (!isMissingFile(error)) {
              throw error;
            }
            return [];
          }
        }`,
      ),
    ).toEqual([]);
  });

  it("accepts a catch that reports before returning empty", () => {
    expect(
      findSilentEmptyCatchViolations(
        file,
        `function read() {
          try {
            return load();
          } catch (error) {
            log.warn(\`load failed: \${error}\`);
            return [];
          }
        }`,
      ),
    ).toEqual([]);
  });

  it("ignores non-empty returns and nested function returns", () => {
    expect(
      findSilentEmptyCatchViolations(
        file,
        `function read() {
          try {
            return load();
          } catch {
            return { status: "error" };
          }
        }
        function withCallback() {
          try {
            return load();
          } catch {
            return items.filter(() => {
              return false;
            }).length;
          }
        }`,
      ),
    ).toEqual([]);
  });
});

describe("guard scope", () => {
  it("judges the modules that own durable session state", () => {
    expect(isGuardedSource("src/config/sessions/session-accessor.ts")).toBe(true);
    expect(isGuardedSource("src/agents/cli-runner/session-history.ts")).toBe(true);
    expect(isGuardedSource("src/gateway/session-utils-core.ts")).toBe(true);
  });

  it("leaves unrelated modules alone so the signal stays trustworthy", () => {
    expect(isGuardedSource("src/infra/net/fetch-guard.ts")).toBe(false);
    expect(isGuardedSource("extensions/discord/src/index.ts")).toBe(false);
  });

  it("excludes tests and migration code that legitimately probe absent shapes", () => {
    expect(isExcludedSilentCatchSource("src/config/sessions/paths.test.ts")).toBe(true);
    expect(isExcludedSilentCatchSource("src/gateway/session-doctor/repair.ts")).toBe(false);
    expect(isExcludedSilentCatchSource("src/config/sessions/state-migrations-legacy.ts")).toBe(
      true,
    );
  });
});
