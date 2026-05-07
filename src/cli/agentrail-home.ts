import os from "node:os";
import path from "node:path";
import { readFile } from "node:fs/promises";

export interface ConnectedRepo {
  path: string;
  slug: string;
  defaultBranch: string;
}

export interface SetupConfigLike {
  version?: number;
  server?: {
    baseUrl?: string;
  };
  persistence?: {
    kind?: string;
  };
  providers?: {
    github?: {
      mode?: string;
      tokenEnv?: string;
    };
    circleci?: {
      mode?: string;
      tokenEnv?: string;
      webhookSecretEnv?: string;
    };
  };
  exports?: {
    markdown?: {
      enabled?: boolean;
    };
  };
  repos?: ConnectedRepo[];
  targetRepo?: {
    path?: string;
    allowlist?: string[];
    defaultBranch?: string;
  };
}

export function defaultAgentRailHome(): string {
  return path.join(os.homedir(), ".agentrail");
}

export function resolveAgentRailHome({
  cwd,
  explicitHome,
}: {
  cwd: string;
  explicitHome?: string | null;
}): string {
  const fromEnv = explicitHome ?? process.env.AGENTRAIL_HOME ?? null;
  return path.resolve(cwd, fromEnv ?? defaultAgentRailHome());
}

export function configPathForHome(homePath: string): string {
  return path.join(homePath, "config.json");
}

export function serverEnvPathForHome(homePath: string): string {
  return path.join(homePath, "server.env");
}

export function operatorEnvPathForHome(homePath: string): string {
  return path.join(homePath, "operator.env");
}

export function providerEnvPathForHome(homePath: string): string {
  return path.join(homePath, "provider.env");
}

export function agentEnvExamplePathForHome(homePath: string): string {
  return path.join(homePath, "agent.env.example");
}

export function currentAgentEnvPathForHome(homePath: string): string {
  return path.join(homePath, "agent.env");
}

export function managedAgentEnvPathForHome(homePath: string, agentId: string): string {
  if (!/^[A-Za-z0-9_-]+$/u.test(agentId)) {
    throw new Error("Invalid agentId for managed agent env path.");
  }
  return path.join(homePath, "agents", `${agentId}.env`);
}

export function recipePathForHome(homePath: string): string {
  return path.join(homePath, "agent-recipes.md");
}

export async function readSetupConfigFromHome(homePath: string): Promise<SetupConfigLike | null> {
  try {
    const content = await readFile(configPathForHome(homePath), "utf8");
    const parsed = JSON.parse(content) as SetupConfigLike;
    return normalizeSetupConfigLike(parsed);
  } catch {
    return null;
  }
}

export function normalizeSetupConfigLike(config: SetupConfigLike | null): SetupConfigLike | null {
  if (!config || typeof config !== "object") {
    return null;
  }

  if (Array.isArray(config.repos)) {
    return {
      ...config,
      repos: config.repos
        .filter((repo): repo is ConnectedRepo => Boolean(repo?.path && repo?.slug && repo?.defaultBranch))
        .map((repo) => ({
          path: repo.path,
          slug: repo.slug,
          defaultBranch: repo.defaultBranch,
        })),
    };
  }

  const legacyPath = config.targetRepo?.path;
  const legacySlug = config.targetRepo?.allowlist?.[0];
  const legacyBranch = config.targetRepo?.defaultBranch;
  if (legacyPath && legacySlug && legacyBranch) {
    return {
      ...config,
      repos: [{
        path: legacyPath,
        slug: legacySlug,
        defaultBranch: legacyBranch,
      }],
    };
  }

  return {
    ...config,
    repos: [],
  };
}

export function primaryRepoFromConfig(config: SetupConfigLike | null): ConnectedRepo | null {
  const repos = config?.repos;
  if (Array.isArray(repos) && repos.length > 0) {
    return repos[0];
  }
  return null;
}
