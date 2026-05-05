import fs from "node:fs";
import { execFileSync } from "node:child_process";

import type { DetectedRepoContext } from "./setup-config.ts";

export function detectRepoContext(cwd: string): DetectedRepoContext {
  const repoPath = runGit(["-C", cwd, "rev-parse", "--show-toplevel"]) ?? cwd;
  const remoteSlug = parseRemoteSlug(runGit(["-C", repoPath, "remote", "get-url", "origin"]));
  const defaultBranch = parseDefaultBranch(
    runGit(["-C", repoPath, "symbolic-ref", "--short", "refs/remotes/origin/HEAD"]),
  )
    ?? runGit(["-C", repoPath, "rev-parse", "--abbrev-ref", "HEAD"])
    ?? "main";

  return {
    repoPath,
    remoteSlug,
    defaultBranch,
    gitIgnoreHasAgentrail: hasAgentrailGitIgnore(repoPath),
  };
}

function runGit(args: string[]): string | null {
  try {
    return execFileSync("git", args, { encoding: "utf8" }).trim() || null;
  } catch {
    return null;
  }
}

function parseRemoteSlug(value: string | null): string | null {
  if (!value) return null;

  const trimmed = value.replace(/\.git$/, "");
  const sshMatch = trimmed.match(/github\.com[:/](?<owner>[^/]+)\/(?<repo>[^/]+)$/i);
  if (sshMatch?.groups) {
    return `${sshMatch.groups.owner}/${sshMatch.groups.repo}`;
  }

  try {
    const url = new URL(trimmed);
    const [, owner, repo] = url.pathname.split("/");
    if (owner && repo) {
      return `${owner}/${repo}`;
    }
  } catch {
    // Ignore parse failures; local paths just fall back to null.
  }

  return null;
}

function parseDefaultBranch(value: string | null): string | null {
  if (!value) return null;

  const parts = value.split("/");
  return parts.at(-1) ?? null;
}

function hasAgentrailGitIgnore(repoPath: string): boolean {
  const gitIgnorePath = `${repoPath}/.gitignore`;
  if (!fs.existsSync(gitIgnorePath)) {
    return false;
  }

  const content = fs.readFileSync(gitIgnorePath, "utf8");
  return /^\.agentrail\/?$/m.test(content);
}
