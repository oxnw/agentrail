import { rm, writeFile } from "node:fs/promises";
import path from "node:path";

import { startServer } from "../server.ts";
import {
  configPathForHome,
  defaultAgentRailHome,
  normalizeSetupConfigLike,
  primaryRepoFromConfig,
  readSetupConfigFromHome,
  resolveAgentRailHome,
  type ConnectedRepo,
  type SetupConfigLike,
} from "./agentrail-home.ts";

interface Writer {
  write(chunk: string | Uint8Array): boolean;
}

export async function runServerStart({
  stdout,
}: {
  stdout: Writer;
}): Promise<number> {
  stdout.write("Starting AgentRail API.\n");
  try {
    startServer();
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    stdout.write(`Failed to start AgentRail API: ${message}\n`);
    return 1;
  }
  return await new Promise<number>(() => {});
}

export async function runRepoCommand(argv: string[], {
  cwd,
  stdout,
  stderr,
}: {
  cwd: string;
  stdout: Writer;
  stderr: Writer;
}): Promise<number> {
  const [subcommand, ...rest] = argv;
  const homePath = resolveAgentRailHome({ cwd, explicitHome: null });
  const config = await readSetupConfigFromHome(homePath);
  if (!config) {
    stderr.write(`No AgentRail config found in ${homePath}. Run \`agentrail init\` first.\n`);
    return 1;
  }

  if (subcommand === "list") {
    const repos = config.repos ?? [];
    if (repos.length === 0) {
      stdout.write("No connected repos.\n");
      return 0;
    }
    stdout.write(`AgentRail home: ${homePath}\n`);
    repos.forEach((repo, index) => {
      stdout.write(`${index + 1}. ${repo.slug} — ${toGitHubUrl(repo.slug)}\n`);
      stdout.write(`   path: ${repo.path}\n`);
      stdout.write(`   default branch: ${repo.defaultBranch}\n`);
    });
    return 0;
  }

  if (subcommand === "add") {
    let flags: RepoFlags;
    try {
      flags = parseRepoFlags(rest);
    } catch (error) {
      stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
      return 1;
    }
    if (!flags.repo || !flags.slug) {
      stderr.write("agentrail repo add requires --repo <path> and --slug <owner/repo|url>.\n");
      return 1;
    }
    const nextRepo = {
      path: path.resolve(cwd, flags.repo),
      slug: normalizeRepoSlug(flags.slug),
      defaultBranch: flags.defaultBranch ?? "main",
    };
    const nextConfig = {
      ...config,
      repos: mergeRepo(config.repos ?? [], nextRepo),
    };
    await writeConfig(homePath, nextConfig);
    stdout.write(`Connected repo ${nextRepo.slug}.\n`);
    return 0;
  }

  if (subcommand === "remove") {
    let flags: RepoFlags;
    try {
      flags = parseRepoFlags(rest);
    } catch (error) {
      stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
      return 1;
    }
    if (!flags.slug) {
      stderr.write("agentrail repo remove requires --slug <owner/repo|url>.\n");
      return 1;
    }
    const slug = normalizeRepoSlug(flags.slug);
    const nextRepos = (config.repos ?? []).filter((repo) => repo.slug !== slug);
    await writeConfig(homePath, {
      ...config,
      repos: nextRepos,
    });
    stdout.write(`Removed repo ${slug} from AgentRail config.\n`);
    return 0;
  }

  stderr.write("Usage: agentrail repo add|list|remove\n");
  return 1;
}

export async function runConfigCommand(argv: string[], {
  cwd,
  stdout,
  stderr,
}: {
  cwd: string;
  stdout: Writer;
  stderr: Writer;
}): Promise<number> {
  const [subcommand, ...rest] = argv;
  const homePath = resolveAgentRailHome({ cwd, explicitHome: null });
  const config = await readSetupConfigFromHome(homePath);
  if (!config) {
    stderr.write(`No AgentRail config found in ${homePath}. Run \`agentrail init\` first.\n`);
    return 1;
  }

  if (subcommand === "show") {
    const primaryRepo = primaryRepoFromConfig(config);
    stdout.write([
      `AgentRail home: ${homePath}`,
      `Config: ${configPathForHome(homePath)}`,
      `Base URL: ${config.server?.baseUrl ?? "unknown"}`,
      `Provider mode: ${config.providers?.github?.mode ?? "unknown"}`,
      `Markdown export: ${config.exports?.markdown?.enabled ? "enabled" : "disabled"}`,
      `Connected repos: ${(config.repos ?? []).length}`,
      primaryRepo ? `Primary repo: ${primaryRepo.slug} (${toGitHubUrl(primaryRepo.slug)})` : "Primary repo: none",
    ].join("\n"));
    stdout.write("\n");
    return 0;
  }

  if (subcommand === "set") {
    let flags: ConfigSetFlags;
    try {
      flags = parseConfigSetFlags(rest);
    } catch (error) {
      stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
      return 1;
    }
    const nextConfig = structuredClone(config as object) as any;
    if (flags.baseUrl) {
      nextConfig.server = nextConfig.server ?? {};
      nextConfig.server.baseUrl = flags.baseUrl;
    }
    if (flags.providerMode) {
      nextConfig.providers = nextConfig.providers ?? {};
      nextConfig.providers.github = nextConfig.providers.github ?? {};
      nextConfig.providers.circleci = nextConfig.providers.circleci ?? {};
      nextConfig.providers.linear = nextConfig.providers.linear ?? {};
      nextConfig.providers.github.mode = flags.providerMode;
      nextConfig.providers.circleci.mode = flags.providerMode;
      nextConfig.providers.linear.mode = flags.providerMode;
    }
    if (flags.markdownExport !== undefined) {
      nextConfig.exports = nextConfig.exports ?? {};
      nextConfig.exports.markdown = nextConfig.exports.markdown ?? {};
      nextConfig.exports.markdown.enabled = flags.markdownExport;
    }
    await writeConfig(homePath, nextConfig);
    stdout.write("Updated AgentRail config.\n");
    return 0;
  }

  stderr.write("Usage: agentrail config show|set\n");
  return 1;
}

interface RepoFlags {
  repo?: string;
  slug?: string;
  defaultBranch?: string;
}

function parseRepoFlags(argv: string[]): RepoFlags {
  const flags: RepoFlags = {};
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    switch (arg) {
      case "--repo":
        flags.repo = nextValue(argv, ++index, arg);
        break;
      case "--slug":
        flags.slug = nextValue(argv, ++index, arg);
        break;
      case "--default-branch":
        flags.defaultBranch = nextValue(argv, ++index, arg);
        break;
      default:
        throw new Error(`Unknown flag "${arg}".`);
    }
  }
  return flags;
}

interface ConfigSetFlags {
  baseUrl?: string;
  providerMode?: "real" | "disabled";
  markdownExport?: boolean;
}

function parseConfigSetFlags(argv: string[]): ConfigSetFlags {
  const flags: ConfigSetFlags = {};
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    switch (arg) {
      case "--base-url":
        flags.baseUrl = nextValue(argv, ++index, arg);
        break;
      case "--provider-mode":
        {
          const mode = nextValue(argv, ++index, arg);
          if (mode !== "real" && mode !== "disabled") {
            throw new Error(`Invalid --provider-mode value "${mode}". Must be "real" or "disabled".`);
          }
          flags.providerMode = mode;
        }
        break;
      case "--markdown-export":
        flags.markdownExport = true;
        break;
      case "--no-markdown-export":
        flags.markdownExport = false;
        break;
      default:
        throw new Error(`Unknown flag "${arg}".`);
    }
  }
  return flags;
}

async function writeConfig(homePath: string, config: SetupConfigLike): Promise<void> {
  // Older local installs may still have this removed store on disk; drop it whenever
  // config is rewritten so the home stays aligned with the current no-local-mapping model.
  await rm(path.join(homePath, "stores", "provider-identity-mappings.json"), { force: true });
  await writeFile(configPathForHome(homePath), `${JSON.stringify(config, null, 2)}\n`, "utf8");
}

function mergeRepo(repos: ConnectedRepo[], nextRepo: ConnectedRepo): ConnectedRepo[] {
  const filtered = repos.filter((repo) => repo.slug !== nextRepo.slug);
  return [...filtered, nextRepo];
}

function normalizeRepoSlug(value: string): string {
  if (/^https?:\/\//iu.test(value)) {
    const url = new URL(value);
    const parts = url.pathname.replace(/^\/+|\/+$/gu, "").split("/");
    if (url.hostname === "github.com" && parts.length >= 2) {
      return `${parts[0]}/${parts[1]}`;
    }
  }
  return value.trim();
}

function toGitHubUrl(slug: string): string {
  return `https://github.com/${slug}`;
}

function nextValue(argv: string[], index: number, flag: string): string {
  const value = argv[index];
  if (!value || value.startsWith("--")) {
    throw new Error(`${flag} requires a value.`);
  }
  return value;
}
