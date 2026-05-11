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
    agentRunStorePath?: string;
    eventSubscriptionStorePath?: string;
    eventDeliveryStorePath?: string;
  };
  providers?: {
    github?: {
      mode?: string;
      tokenEnv?: string;
      deliveryMode?: string;
      pollIntervalMs?: number;
      webhookSecretEnv?: string;
    };
    circleci?: {
      mode?: string;
      tokenEnv?: string;
      deliveryMode?: string;
      pollIntervalMs?: number;
      webhookSecretEnv?: string;
    };
    linear?: {
      mode?: string;
      tokenEnv?: string;
      deliveryMode?: string;
      syncMode?: string;
      pollIntervalMs?: number;
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

export const DEFAULT_AGENT_RUN_STORE_PATH = "stores/agent-runs.json";
export const DEFAULT_EVENT_SUBSCRIPTION_STORE_PATH = "stores/event-subscriptions.json";
export const DEFAULT_EVENT_DELIVERY_STORE_PATH = "stores/event-deliveries.json";

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

  const normalizedProviders = normalizeProviders(config.providers);
  const normalizedPersistence = normalizePersistence(config.persistence);
  if (Array.isArray(config.repos)) {
    return {
      ...config,
      persistence: normalizedPersistence,
      providers: normalizedProviders,
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
      persistence: normalizedPersistence,
      providers: normalizedProviders,
      repos: [{
        path: legacyPath,
        slug: legacySlug,
        defaultBranch: legacyBranch,
      }],
    };
  }

  return {
    ...config,
    persistence: normalizedPersistence,
    providers: normalizedProviders,
    repos: [],
  };
}

function normalizeStorePath(value: unknown, defaultPath: string): string {
  const trimmed = typeof value === "string" ? value.trim() : "";
  return trimmed.length > 0 ? trimmed : defaultPath;
}

function normalizePersistence(persistence: SetupConfigLike["persistence"]): SetupConfigLike["persistence"] {
  if (!persistence || persistence.kind !== "file") {
    return persistence;
  }
  const agentRunStorePath = normalizeStorePath(persistence.agentRunStorePath, DEFAULT_AGENT_RUN_STORE_PATH);
  const eventSubscriptionStorePath = normalizeStorePath(persistence.eventSubscriptionStorePath, DEFAULT_EVENT_SUBSCRIPTION_STORE_PATH);
  const eventDeliveryStorePath = normalizeStorePath(persistence.eventDeliveryStorePath, DEFAULT_EVENT_DELIVERY_STORE_PATH);
  return {
    ...persistence,
    agentRunStorePath,
    eventSubscriptionStorePath,
    eventDeliveryStorePath,
  };
}

function normalizeProviders(providers: SetupConfigLike["providers"]): SetupConfigLike["providers"] {
  if (!providers) {
    return providers;
  }
  return {
    ...(providers.github
      ? {
          github: {
            ...providers.github,
            deliveryMode: normalizeDeliveryMode(providers.github.deliveryMode, "polling"),
          },
        }
      : {}),
    ...(providers.circleci
      ? {
          circleci: {
            ...providers.circleci,
            deliveryMode: normalizeDeliveryMode(providers.circleci.deliveryMode, "polling"),
          },
        }
      : {}),
    ...(providers.linear
      ? {
          linear: {
            ...providers.linear,
            deliveryMode: normalizeDeliveryMode(
              providers.linear.deliveryMode,
              providers.linear.syncMode === "polling" ? "polling" : "webhook",
            ),
          },
        }
      : {}),
  };
}

function normalizeDeliveryMode(value: string | undefined, fallback: "polling" | "webhook"): "polling" | "webhook" {
  if (value === "webhook") return "webhook";
  if (value === "polling") return "polling";
  return fallback;
}

export function primaryRepoFromConfig(config: SetupConfigLike | null): ConnectedRepo | null {
  const repos = config?.repos;
  if (Array.isArray(repos) && repos.length > 0) {
    return repos[0];
  }
  return null;
}
