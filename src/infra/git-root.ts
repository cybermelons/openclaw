// Discovers git repository roots by walking ancestor directories.
import fs from "node:fs";
import path from "node:path";
import { hasErrnoCode } from "./errno.js";

const DEFAULT_GIT_DISCOVERY_MAX_DEPTH = 12;

function walkUpFrom<T>(
  startDir: string,
  opts: { maxDepth?: number },
  resolveAtDir: (dir: string) => T | null | undefined,
): T | null {
  let current = path.resolve(startDir);
  const maxDepth = opts.maxDepth ?? DEFAULT_GIT_DISCOVERY_MAX_DEPTH;
  for (let i = 0; i < maxDepth; i += 1) {
    const resolved = resolveAtDir(current);
    if (resolved !== null && resolved !== undefined) {
      return resolved;
    }
    const parent = path.dirname(current);
    if (parent === current) {
      break;
    }
    current = parent;
  }
  return null;
}

function hasGitMarker(repoRoot: string): boolean {
  const gitPath = path.join(repoRoot, ".git");
  try {
    const stat = fs.statSync(gitPath);
    return stat.isDirectory() || stat.isFile();
  } catch {
    return false;
  }
}

export function findGitRoot(startDir: string, opts: { maxDepth?: number } = {}): string | null {
  // A `.git` file counts as a repo marker even if it is not a valid gitdir pointer.
  return walkUpFrom(startDir, opts, (repoRoot) => (hasGitMarker(repoRoot) ? repoRoot : null));
}

function resolveGitDirFromMarker(repoRoot: string): string | null {
  const gitPath = path.join(repoRoot, ".git");
  try {
    const stat = fs.statSync(gitPath);
    if (stat.isDirectory()) {
      return gitPath;
    }
    if (!stat.isFile()) {
      return null;
    }
    const raw = fs.readFileSync(gitPath, "utf-8");
    const match = raw.match(/gitdir:\s*(.+)/i);
    if (!match?.[1]) {
      return null;
    }
    return path.resolve(repoRoot, match[1].trim());
  } catch {
    return null;
  }
}

function resolveCommonGitDir(
  gitDir: string,
  startDir: string,
  env: NodeJS.ProcessEnv,
): string | null {
  const explicitCommonDir = env.GIT_COMMON_DIR?.trim();
  if (explicitCommonDir) {
    return path.resolve(startDir, explicitCommonDir);
  }
  const commonDirPath = path.join(gitDir, "commondir");
  try {
    const stat = fs.statSync(commonDirPath);
    if (!stat.isFile()) {
      return null;
    }
    const relative = fs.readFileSync(commonDirPath, "utf-8").trim();
    return relative ? path.resolve(gitDir, relative) : null;
  } catch (error) {
    return hasErrnoCode(error, "ENOENT") ? gitDir : null;
  }
}

type ResolvedGitCheckout = {
  gitDir: string;
  repoRoot: string;
  requiresNonBareGitDir: boolean;
};

function resolveGitCheckout(startDir: string, env: NodeJS.ProcessEnv): ResolvedGitCheckout | null {
  const explicitGitDir = env.GIT_DIR?.trim();
  const explicitWorkTree = env.GIT_WORK_TREE?.trim();
  const markerRoot = explicitGitDir
    ? null
    : findGitRoot(startDir, { maxDepth: Number.MAX_SAFE_INTEGER });
  const gitDir = explicitGitDir
    ? path.resolve(startDir, explicitGitDir)
    : markerRoot
      ? resolveGitDirFromMarker(markerRoot)
      : null;
  if (!gitDir) {
    return null;
  }
  const repoRoot = explicitWorkTree
    ? path.resolve(startDir, explicitWorkTree)
    : explicitGitDir
      ? path.resolve(startDir)
      : markerRoot;
  if (!repoRoot) {
    return null;
  }
  return {
    gitDir,
    repoRoot,
    requiresNonBareGitDir: Boolean(explicitGitDir && !explicitWorkTree),
  };
}

function hasBareRepositoryConfig(commonGitDir: string): boolean {
  try {
    const raw = fs.readFileSync(path.join(commonGitDir, "config"), "utf-8");
    let inCoreSection = false;
    for (const line of raw.split(/\r?\n/)) {
      const section = line.match(/^\s*\[([^\]]+)]/);
      if (section) {
        inCoreSection = section[1]?.trim().toLowerCase() === "core";
        continue;
      }
      if (!inCoreSection) {
        continue;
      }
      const bareSetting = line.match(/^\s*bare(?:\s*=\s*([^#;]*))?\s*(?:[#;].*)?$/i);
      if (bareSetting) {
        const value = bareSetting[1]?.trim().toLowerCase();
        return value === undefined || ["1", "on", "true", "yes"].includes(value);
      }
    }
    return false;
  } catch {
    return false;
  }
}

export function findUsableGitCheckoutRoot(
  startDir: string,
  env: NodeJS.ProcessEnv = process.env,
): string | null {
  const checkout = resolveGitCheckout(startDir, env);
  if (!checkout) {
    return null;
  }
  const commonGitDir = resolveCommonGitDir(checkout.gitDir, startDir, env);
  if (!commonGitDir) {
    return null;
  }
  if (checkout.requiresNonBareGitDir && hasBareRepositoryConfig(commonGitDir)) {
    return null;
  }
  try {
    const usable =
      fs.statSync(path.join(checkout.gitDir, "HEAD")).isFile() &&
      fs.statSync(path.join(commonGitDir, "objects")).isDirectory() &&
      fs.statSync(path.join(commonGitDir, "refs")).isDirectory();
    return usable ? checkout.repoRoot : null;
  } catch {
    return null;
  }
}

export function hasUsableGitMetadata(
  startDir: string,
  env: NodeJS.ProcessEnv = process.env,
): boolean {
  return findUsableGitCheckoutRoot(startDir, env) !== null;
}

export function resolveGitHeadPath(
  startDir: string,
  opts: { maxDepth?: number } = {},
): string | null {
  // Stricter than findGitRoot: keep walking until a resolvable git dir is found.
  return walkUpFrom(startDir, opts, (repoRoot) => {
    const gitDir = resolveGitDirFromMarker(repoRoot);
    return gitDir ? path.join(gitDir, "HEAD") : null;
  });
}
