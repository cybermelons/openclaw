// Durable install guard (issue #53): a stripped/broken build must not silently ship without the
// CLI transcript reconcile wiring. This is the source-level half of the guard — cheap and fast in
// the normal test suite. See scripts/check-reconcile-wiring.mts for the compiled-dist half, which
// verifies the wiring actually survives the build.
//
// Issue #14 (Route C): the read-time reconcile call in chat-history-pages.ts was removed — a
// chat-history READ must not WRITE a transcript backfill, since it raced the live mirror's
// end-of-turn append and produced duplicate turns on resume. Crash-recovery dispatch already
// re-drains genuinely lost turns, so reconcile wiring is asserted on the recovery path only.
// Do not retarget this guard back onto chat-history-pages.ts without re-litigating that ruling.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const repoRoot = fileURLToPath(new URL("../..", import.meta.url));

describe("reconcileCliTranscript wiring guard", () => {
  it("is imported and called at both known call sites in main-session-restart-dispatch.ts", () => {
    const source = fs.readFileSync(
      path.join(repoRoot, "src/agents/main-session-recovery/main-session-restart-dispatch.ts"),
      "utf8",
    );

    expect(source).toMatch(
      /import\s*{[^}]*\breconcileCliTranscript\b[^}]*}\s*from\s*["']\.\.\/cli-transcript-reconcile\.js["']/,
    );

    const callCount = source.match(/\breconcileCliTranscript\s*\(/g)?.length ?? 0;
    expect(callCount).toBe(2);
  });

  it("is not called on the chat-history-pages.ts read path", () => {
    const source = fs.readFileSync(
      path.join(repoRoot, "src/gateway/server-methods/chat-history-pages.ts"),
      "utf8",
    );

    // A read path must not write: history-serve must never call reconcileCliTranscript.
    // Backfill belongs exclusively to crash-recovery dispatch.
    expect(source).not.toMatch(/\breconcileCliTranscript\s*\(/);
    expect(source).not.toMatch(
      /import\s*{[^}]*\breconcileCliTranscript\b[^}]*}\s*from\s*["']\.\.\/\.\.\/agents\/cli-transcript-reconcile\.js["']/,
    );
  });

  it("reconcileCliTranscript is still exported from cli-transcript-reconcile.ts", () => {
    const source = fs.readFileSync(
      path.join(repoRoot, "src/agents/cli-transcript-reconcile.ts"),
      "utf8",
    );

    expect(source).toMatch(/export\s+(?:async\s+)?function\s+reconcileCliTranscript\s*\(/);
  });
});
