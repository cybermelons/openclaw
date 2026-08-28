import fs from "node:fs";
import path from "node:path";
import { resolveControlUiRootSync } from "../infra/control-ui-assets.js";
import { resolveRuntimeServiceBuildId } from "../version.js";

export type ControlUiBuildSkew = {
  uiBuildId: string;
  gatewayBuildId: string;
};

/**
 * A partial rebuild can leave dist/ holding two builds at once: `pnpm ui:build`
 * refreshes dist/control-ui/ while dist/build-info.json keeps the previous
 * commit. The Gateway then serves a Control UI that its own admission check
 * rejects (control-ui-build-admission.ts), so every client loops on a
 * protocol-mismatch close that "reload this page" cannot clear — the skew is
 * server-side. The service worker makes it read as a browser cache problem.
 *
 * This module names that state. It reads the build id the UI build stamps into
 * the served sw.js and compares it to the Gateway's own build id. It is
 * diagnostic only: nothing here changes admission, the wire message, or the
 * close code.
 *
 * The exemptions mirror admission (minus the origin test, which is a property
 * of the request rather than of disk): a configured root serves an artifact the
 * Gateway owns no matching identity for, "dev" is the ui:dev sentinel, and an
 * absent stamp on either side means there is nothing to compare.
 */
const EMBEDDED_CACHE_VERSION_PATTERN = /EMBEDDED_CACHE_VERSION\s*=\s*"([^"]*)"/;
const BUILD_ID_PLACEHOLDER = "__OPENCLAW_CONTROL_UI_BUILD_ID__";

/** Extract the build id that the UI build stamps into sw.js. */
export function extractControlUiServiceWorkerBuildId(source: string): string | null {
  const matched = EMBEDDED_CACHE_VERSION_PATTERN.exec(source);
  const buildId = matched?.[1]?.trim();
  if (!buildId || buildId === BUILD_ID_PLACEHOLDER) {
    return null;
  }
  return buildId;
}

type CacheEntry = {
  mtimeMs: number;
  size: number;
  buildId: string | null;
};

const swBuildIdCache = new Map<string, CacheEntry>();

function readServiceWorkerBuildId(serviceWorkerPath: string): string | null {
  let stat: fs.Stats;
  try {
    stat = fs.statSync(serviceWorkerPath);
  } catch {
    return null;
  }
  const cached = swBuildIdCache.get(serviceWorkerPath);
  if (cached && cached.mtimeMs === stat.mtimeMs && cached.size === stat.size) {
    return cached.buildId;
  }
  let buildId: string | null;
  try {
    buildId = extractControlUiServiceWorkerBuildId(fs.readFileSync(serviceWorkerPath, "utf8"));
  } catch {
    buildId = null;
  }
  swBuildIdCache.set(serviceWorkerPath, { mtimeMs: stat.mtimeMs, size: stat.size, buildId });
  return buildId;
}

/**
 * Compare the served Control UI's stamp to the Gateway's build id. Returns null
 * when they agree or when the comparison does not apply.
 */
export function resolveControlUiBuildSkew(params: {
  configuredControlUiRoot?: string;
  controlUiRoot?: string | null;
  gatewayBuildId?: string | null;
}): ControlUiBuildSkew | null {
  if (params.configuredControlUiRoot) {
    return null;
  }
  const gatewayBuildId = (params.gatewayBuildId ?? resolveRuntimeServiceBuildId())?.trim();
  if (!gatewayBuildId) {
    return null;
  }
  const root =
    params.controlUiRoot ??
    resolveControlUiRootSync({
      moduleUrl: import.meta.url,
      argv1: process.argv[1],
      cwd: process.cwd(),
    });
  if (!root) {
    return null;
  }
  const uiBuildId = readServiceWorkerBuildId(path.join(root, "sw.js"));
  if (!uiBuildId || uiBuildId === "dev" || uiBuildId === gatewayBuildId) {
    return null;
  }
  return { uiBuildId, gatewayBuildId };
}

/** One operator-facing line naming both stamps and the remedy. */
export function formatControlUiBuildSkewMessage(skew: ControlUiBuildSkew): string {
  return (
    `dist/ holds two builds: Control UI is ${skew.uiBuildId} but the gateway is ` +
    `${skew.gatewayBuildId}. Every Control UI client will be rejected until dist/ ` +
    `is consistent. Run a full "pnpm build".`
  );
}

/** Test seam: drop the mtime cache. */
export function resetControlUiBuildSkewCacheForTest(): void {
  swBuildIdCache.clear();
}
