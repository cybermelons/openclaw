// Covers git root and HEAD path discovery.
import { execFileSync } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { withTestDir } from "../test-helpers/temp-dir.js";
import {
  findGitRoot,
  findUsableGitCheckoutRoot,
  hasUsableGitMetadata,
  resolveGitHeadPath,
} from "./git-root.js";

async function expectGitRootResolution(params: {
  label: string;
  setup: (
    temp: string,
  ) => Promise<{ startPath: string; expectedRoot: string | null; expectedHead: string | null }>;
}): Promise<void> {
  await withTestDir({ prefix: `openclaw-${params.label}-` }, async (temp) => {
    const { startPath, expectedRoot, expectedHead } = await params.setup(temp);
    expect(findGitRoot(startPath)).toBe(expectedRoot);
    expect(resolveGitHeadPath(startPath)).toBe(expectedHead);
  });
}

describe("git-root", () => {
  it.each([
    {
      name: "starting at the repo root itself",
      label: "git-root-self",
      setup: async (temp: string) => {
        const repoRoot = path.join(temp, "repo");
        await fs.mkdir(path.join(repoRoot, ".git"), { recursive: true });
        return {
          startPath: repoRoot,
          expectedRoot: repoRoot,
          expectedHead: path.join(repoRoot, ".git", "HEAD"),
        };
      },
    },
    {
      name: ".git is a directory",
      label: "git-root-dir",
      setup: async (temp: string) => {
        const repoRoot = path.join(temp, "repo");
        const workspace = path.join(repoRoot, "nested", "workspace");
        await fs.mkdir(path.join(repoRoot, ".git"), { recursive: true });
        await fs.mkdir(workspace, { recursive: true });
        return {
          startPath: workspace,
          expectedRoot: repoRoot,
          expectedHead: path.join(repoRoot, ".git", "HEAD"),
        };
      },
    },
    {
      name: ".git is a gitdir pointer file",
      label: "git-root-file",
      setup: async (temp: string) => {
        const repoRoot = path.join(temp, "repo");
        const workspace = path.join(repoRoot, "nested", "workspace");
        const gitDir = path.join(repoRoot, ".actual-git");
        await fs.mkdir(workspace, { recursive: true });
        await fs.mkdir(gitDir, { recursive: true });
        await fs.writeFile(path.join(repoRoot, ".git"), "gitdir: .actual-git\n", "utf-8");
        return {
          startPath: workspace,
          expectedRoot: repoRoot,
          expectedHead: path.join(gitDir, "HEAD"),
        };
      },
    },
    {
      name: "invalid gitdir content still keeps root detection",
      label: "git-root-invalid-file",
      setup: async (temp: string) => {
        const parentRoot = path.join(temp, "repo");
        const childRoot = path.join(parentRoot, "child");
        const nested = path.join(childRoot, "nested");
        await fs.mkdir(path.join(parentRoot, ".git"), { recursive: true });
        await fs.mkdir(nested, { recursive: true });
        await fs.writeFile(path.join(childRoot, ".git"), "not-a-gitdir-pointer\n", "utf-8");
        return {
          startPath: nested,
          expectedRoot: childRoot,
          expectedHead: path.join(parentRoot, ".git", "HEAD"),
        };
      },
    },
    {
      name: "invalid gitdir content without a parent repo",
      label: "git-root-invalid-only",
      setup: async (temp: string) => {
        const repoRoot = path.join(temp, "repo");
        const nested = path.join(repoRoot, "nested");
        await fs.mkdir(nested, { recursive: true });
        await fs.writeFile(path.join(repoRoot, ".git"), "not-a-gitdir-pointer\n", "utf-8");
        return {
          startPath: nested,
          expectedRoot: repoRoot,
          expectedHead: null,
        };
      },
    },
  ])("resolves git roots when $name", async ({ label, setup }) => {
    await expectGitRootResolution({ label, setup });
  });

  it("respects maxDepth traversal limit", async () => {
    await withTestDir({ prefix: "openclaw-git-root-depth-" }, async (temp) => {
      const repoRoot = path.join(temp, "repo");
      const nested = path.join(repoRoot, "a", "b", "c");
      await fs.mkdir(path.join(repoRoot, ".git"), { recursive: true });
      await fs.mkdir(nested, { recursive: true });

      expect(findGitRoot(nested, { maxDepth: 2 })).toBeNull();
      expect(resolveGitHeadPath(nested, { maxDepth: 2 })).toBeNull();
    });
  });

  it("requires usable metadata at the nearest checkout marker", async () => {
    await withTestDir({ prefix: "openclaw-git-root-usable-" }, async (temp) => {
      const parentRoot = path.join(temp, "parent");
      const checkoutRoot = path.join(parentRoot, "checkout");
      const nested = path.join(checkoutRoot, "nested");
      await fs.mkdir(path.join(parentRoot, ".git", "objects"), { recursive: true });
      await fs.mkdir(path.join(parentRoot, ".git", "refs"), { recursive: true });
      await fs.writeFile(path.join(parentRoot, ".git", "HEAD"), "ref: refs/heads/main\n");
      await fs.mkdir(path.join(checkoutRoot, ".git"), { recursive: true });
      await fs.mkdir(nested, { recursive: true });

      expect(hasUsableGitMetadata(nested)).toBe(false);

      await fs.mkdir(path.join(checkoutRoot, ".git", "objects"));
      await fs.mkdir(path.join(checkoutRoot, ".git", "refs"));
      await fs.writeFile(path.join(checkoutRoot, ".git", "HEAD"), "ref: refs/heads/main\n");
      expect(hasUsableGitMetadata(nested)).toBe(true);
    });
  });

  it("accepts linked-worktree metadata through its common directory", async () => {
    await withTestDir({ prefix: "openclaw-git-root-linked-" }, async (temp) => {
      const checkoutRoot = path.join(temp, "checkout");
      const nested = path.join(checkoutRoot, "nested");
      const commonGitDir = path.join(temp, "repo.git");
      const worktreeGitDir = path.join(commonGitDir, "worktrees", "checkout");
      await fs.mkdir(path.join(commonGitDir, "objects"), { recursive: true });
      await fs.mkdir(path.join(commonGitDir, "refs"), { recursive: true });
      await fs.mkdir(worktreeGitDir, { recursive: true });
      await fs.mkdir(nested, { recursive: true });
      await fs.writeFile(path.join(checkoutRoot, ".git"), `gitdir: ${worktreeGitDir}\n`);
      await fs.writeFile(path.join(worktreeGitDir, "HEAD"), "ref: refs/heads/main\n");
      await fs.writeFile(path.join(worktreeGitDir, "commondir"), "../..\n");

      expect(hasUsableGitMetadata(nested)).toBe(true);
    });
  });

  it("accepts metadata created by Git's reftable backend", async () => {
    await withTestDir({ prefix: "openclaw-git-root-reftable-" }, async (temp) => {
      const repoRoot = path.join(temp, "repo");
      const nested = path.join(repoRoot, "nested");
      await fs.mkdir(nested, { recursive: true });
      execFileSync("git", ["init", "--quiet", "--ref-format=reftable"], { cwd: repoRoot });

      expect(hasUsableGitMetadata(nested)).toBe(true);
    });
  });

  it("honors Git directory and worktree environment overrides", async () => {
    await withTestDir({ prefix: "openclaw-git-root-env-" }, async (temp) => {
      const gitDir = path.join(temp, "repo.git");
      const metadataSource = path.join(temp, "metadata-source");
      const workTree = path.join(temp, "workspace");
      const unrelatedCwd = path.join(temp, "elsewhere");
      await fs.mkdir(metadataSource);
      await fs.mkdir(workTree);
      await fs.mkdir(unrelatedCwd);
      execFileSync("git", ["init", "--bare", "--quiet", gitDir]);
      execFileSync("git", ["init", "--quiet"], { cwd: metadataSource });

      expect(findGitRoot(unrelatedCwd)).toBeNull();
      expect(
        findUsableGitCheckoutRoot(unrelatedCwd, {
          GIT_DIR: gitDir,
          GIT_WORK_TREE: workTree,
        }),
      ).toBe(workTree);
      expect(
        findUsableGitCheckoutRoot(unrelatedCwd, {
          GIT_DIR: path.join(metadataSource, ".git"),
        }),
      ).toBe(unrelatedCwd);
      expect(findUsableGitCheckoutRoot(unrelatedCwd, { GIT_DIR: gitDir })).toBeNull();
      expect(findUsableGitCheckoutRoot(metadataSource, { GIT_WORK_TREE: workTree })).toBe(workTree);
    });
  });
});
