// Split-build-skew (#6) tests: a UI-only `pnpm ui:build` can leave dist/
// holding two builds. These tests cover the sw.js stamp extractor, the
// gateway/UI comparison, and a contract check against the real sw.js source
// so the stamp format and the extractor cannot silently diverge.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { findGitRoot } from "../infra/git-root.js";
import {
  extractControlUiServiceWorkerBuildId,
  resetControlUiBuildSkewCacheForTest,
  resolveControlUiBuildSkew,
} from "./control-ui-build-skew.js";

describe("extractControlUiServiceWorkerBuildId", () => {
  it("reads the stamped id from a realistic sw.js snippet", () => {
    const source = [
      'const CACHE_PREFIX = "openclaw-control-";',
      'const EMBEDDED_CACHE_VERSION = "2026.08.27-abc123";',
      "const CACHE_NAME = `${CACHE_PREFIX}${EMBEDDED_CACHE_VERSION}`;",
    ].join("\n");

    expect(extractControlUiServiceWorkerBuildId(source)).toBe("2026.08.27-abc123");
  });

  it("returns null for the unreplaced placeholder", () => {
    const source = 'const EMBEDDED_CACHE_VERSION = "__OPENCLAW_CONTROL_UI_BUILD_ID__";';

    expect(extractControlUiServiceWorkerBuildId(source)).toBeNull();
  });

  it("returns null when no EMBEDDED_CACHE_VERSION assignment is present", () => {
    const source = 'const CACHE_PREFIX = "openclaw-control-";';

    expect(extractControlUiServiceWorkerBuildId(source)).toBeNull();
  });

  it("finds the stamp in the real ui/public/sw.js (contract)", () => {
    // Resolved from the repo root, not a hardcoded absolute path: this must
    // fail if the sw.js stamp format and the extractor ever diverge.
    const repoRoot = findGitRoot(path.dirname(fileURLToPath(import.meta.url)));
    if (!repoRoot) {
      throw new Error("could not locate repo root from test file location");
    }
    const swSource = fs.readFileSync(path.join(repoRoot, "ui/public/sw.js"), "utf8");

    // The real file still carries the unreplaced placeholder (the build
    // plugin stamps it at build time), so the extractor correctly reports
    // "no id yet" for it — but the assignment itself must be present and in
    // the shape the extractor looks for.
    expect(swSource).toMatch(/EMBEDDED_CACHE_VERSION\s*=\s*"[^"]*"/);
    expect(extractControlUiServiceWorkerBuildId(swSource)).toBeNull();

    // Swap in a real-looking build id and confirm the extractor finds it
    // through the exact assignment shape shipped in the real file.
    const stamped = swSource.replace("__OPENCLAW_CONTROL_UI_BUILD_ID__", "2026.08.27-contract");
    expect(extractControlUiServiceWorkerBuildId(stamped)).toBe("2026.08.27-contract");
  });
});

describe("resolveControlUiBuildSkew", () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-control-ui-skew-"));
    resetControlUiBuildSkewCacheForTest();
  });

  afterEach(() => {
    fs.rmSync(tempDir, { force: true, recursive: true });
    resetControlUiBuildSkewCacheForTest();
  });

  function writeServiceWorker(buildId: string): void {
    fs.writeFileSync(
      path.join(tempDir, "sw.js"),
      `const EMBEDDED_CACHE_VERSION = "${buildId}";\n`,
      "utf8",
    );
  }

  it("returns a skew when the sw.js id differs from the gateway build id", () => {
    writeServiceWorker("ui-build-1");

    const skew = resolveControlUiBuildSkew({
      controlUiRoot: tempDir,
      gatewayBuildId: "gateway-build-1",
    });

    expect(skew).toEqual({ uiBuildId: "ui-build-1", gatewayBuildId: "gateway-build-1" });
  });

  it("returns null when the ids match", () => {
    writeServiceWorker("same-build");

    const skew = resolveControlUiBuildSkew({
      controlUiRoot: tempDir,
      gatewayBuildId: "same-build",
    });

    expect(skew).toBeNull();
  });

  it("returns null when configuredControlUiRoot is set", () => {
    writeServiceWorker("ui-build-1");

    const skew = resolveControlUiBuildSkew({
      configuredControlUiRoot: "/some/operator/configured/root",
      controlUiRoot: tempDir,
      gatewayBuildId: "gateway-build-1",
    });

    expect(skew).toBeNull();
  });

  it("returns null when the sw.js id is the dev sentinel", () => {
    writeServiceWorker("dev");

    const skew = resolveControlUiBuildSkew({
      controlUiRoot: tempDir,
      gatewayBuildId: "gateway-build-1",
    });

    expect(skew).toBeNull();
  });

  it("returns null when sw.js is absent", () => {
    const skew = resolveControlUiBuildSkew({
      controlUiRoot: tempDir,
      gatewayBuildId: "gateway-build-1",
    });

    expect(skew).toBeNull();
  });

  it("returns null when gatewayBuildId is empty", () => {
    writeServiceWorker("ui-build-1");

    const skew = resolveControlUiBuildSkew({
      controlUiRoot: tempDir,
      gatewayBuildId: "",
    });

    expect(skew).toBeNull();
  });

  it("returns null when gatewayBuildId is absent", () => {
    writeServiceWorker("ui-build-1");

    const skew = resolveControlUiBuildSkew({
      controlUiRoot: tempDir,
    });

    expect(skew).toBeNull();
  });

  it("stays cached until resetControlUiBuildSkewCacheForTest forces a re-read", () => {
    writeServiceWorker("ui-build-1");
    const first = resolveControlUiBuildSkew({
      controlUiRoot: tempDir,
      gatewayBuildId: "gateway-build-1",
    });
    expect(first).toEqual({ uiBuildId: "ui-build-1", gatewayBuildId: "gateway-build-1" });

    // Same content read again without a cache reset: still cached, still a skew.
    const stillCached = resolveControlUiBuildSkew({
      controlUiRoot: tempDir,
      gatewayBuildId: "gateway-build-1",
    });
    expect(stillCached).toEqual({ uiBuildId: "ui-build-1", gatewayBuildId: "gateway-build-1" });

    // Update the file to match the gateway id, then force a re-read.
    writeServiceWorker("gateway-build-1");
    resetControlUiBuildSkewCacheForTest();

    const afterReset = resolveControlUiBuildSkew({
      controlUiRoot: tempDir,
      gatewayBuildId: "gateway-build-1",
    });
    expect(afterReset).toBeNull();
  });

  it("invalidates the mtime cache on a real on-disk rewrite, no reset call", () => {
    // This is the actual "someone rebuilds the UI while the gateway keeps
    // running" path the connect-session.ts call site exists for: no test
    // helper resets the cache, the file changes under the running process.
    //
    // The cache keys on (mtimeMs, size). Some filesystems/CI runners carry
    // coarse (~1s) mtime resolution, so a same-tick rewrite could keep an
    // identical mtimeMs and be missed on mtime alone. We defend on both axes
    // so the assertion is deterministic regardless of filesystem: the second
    // write uses a longer build id string (size changes), and we additionally
    // set an explicit future mtime with fs.utimesSync (mtime changes too).
    writeServiceWorker("build-a");
    const first = resolveControlUiBuildSkew({
      controlUiRoot: tempDir,
      gatewayBuildId: "gateway-build-1",
    });
    expect(first).toEqual({ uiBuildId: "build-a", gatewayBuildId: "gateway-build-1" });

    writeServiceWorker("build-b-longer-id");
    const swPath = path.join(tempDir, "sw.js");
    const future = new Date(Date.now() + 60_000);
    fs.utimesSync(swPath, future, future);

    // No resetControlUiBuildSkewCacheForTest call: the mtime/size check on
    // the stat alone must be what invalidates the cached entry here.
    const afterRewrite = resolveControlUiBuildSkew({
      controlUiRoot: tempDir,
      gatewayBuildId: "gateway-build-1",
    });
    expect(afterRewrite).toEqual({
      uiBuildId: "build-b-longer-id",
      gatewayBuildId: "gateway-build-1",
    });
  });
});
