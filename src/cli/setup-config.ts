import path from "node:path";

import type { ConnectedRepo } from "./agentrail-home.ts";

export type SetupMode = "server";
export type ProviderMode = "real" | "disabled";
export type ProviderDeliveryMode = "polling" | "webhook";
export type ProviderImportMode = "from_now" | "backfill";
export type PersistenceKind = "file" | "memory";
export type InteractionMode = "interactive" | "non_interactive" | "print_only";

export interface GitHubProviderWebhookRegistration {
  repoSlug: string;
  hookId: number;
  url: string;
  events: string[];
  active: boolean;
}

export interface DetectedRepoContext {
  repoPath: string;
  remoteSlug: string | null;
  defaultBranch: string;
  gitIgnoreHasAgentrail: boolean;
}

export interface SetupConfig {
  version: 2;
  setup: {
    interactionMode: InteractionMode;
    acceptedDefaults: boolean;
  };
  mode: SetupMode;
  server: {
    host: string;
    port: number;
    baseUrl: string;
  };
  persistence:
    | {
      kind: "file";
      engine: "file";
      eventStorePath: string;
      taskStorePath: string;
      authStorePath: string;
      agentRunStorePath: string;
      providerCursorStorePath: string;
      eventSubscriptionStorePath: string;
      eventDeliveryStorePath: string;
      agentProfileStorePath: string;
      routingRuleStorePath: string;
      routingAuditStorePath: string;
    }
    | {
      kind: "memory";
      engine: "memory";
    };
  exports: {
    markdown: {
      enabled: boolean;
      path: string;
    };
  };
  providers: {
    github: {
      mode: ProviderMode;
      tokenEnv: string;
      deliveryMode: ProviderDeliveryMode;
      importMode: ProviderImportMode;
      pollIntervalMs?: number;
      webhookSecretEnv?: string;
      registeredWebhooks?: GitHubProviderWebhookRegistration[];
    };
    circleci: {
      mode: ProviderMode;
      tokenEnv: string;
      deliveryMode: ProviderDeliveryMode;
      pollIntervalMs?: number;
      webhookSecretEnv?: string;
    };
    linear: {
      mode: ProviderMode;
      tokenEnv: string;
      deliveryMode: ProviderDeliveryMode;
      pollIntervalMs?: number;
      webhookSecretEnv?: string;
    };
  };
  repos: ConnectedRepo[];
}

export interface CreateSetupConfigOptions {
  cwd: string;
  detectedRepo: DetectedRepoContext;
  interactionMode: InteractionMode;
  acceptedDefaults: boolean;
  mode?: SetupMode;
  host?: string;
  port?: number;
  baseUrl?: string;
  persistence?: PersistenceKind;
  providerMode?: ProviderMode;
  repoPath?: string;
  repoAllowlist?: string[];
  defaultBranch?: string;
  markdownExport?: boolean;
}

export interface SafetyValidation {
  ok: boolean;
  reasons: string[];
}

const DEFAULT_HOST = "127.0.0.1";
const DEFAULT_PORT = 3000;

export function createSetupConfig({
  cwd,
  detectedRepo,
  interactionMode,
  acceptedDefaults,
  mode = "server",
  host,
  port,
  baseUrl,
  persistence,
  providerMode,
  repoPath,
  repoAllowlist,
  defaultBranch,
  markdownExport = false,
}: CreateSetupConfigOptions): SetupConfig {
  const repoRoot = path.resolve(cwd, repoPath ?? detectedRepo.repoPath ?? cwd);
  const resolvedServer = resolveServer({
    host,
    port,
    baseUrl,
  });
  const resolvedProviderMode = providerMode ?? "real";
  const allowlist = repoAllowlist?.length
    ? repoAllowlist
    : [detectedRepo.remoteSlug ?? repoRoot];
  const branch = defaultBranch ?? detectedRepo.defaultBranch ?? "main";
  const resolvedPersistence = persistence ?? "file";

  return {
    version: 2,
    setup: {
      interactionMode,
      acceptedDefaults,
    },
    mode,
    server: resolvedServer,
    persistence: resolvedPersistence === "memory"
      ? {
        kind: "memory",
        engine: "memory",
      }
      : {
        kind: "file",
        engine: "file",
        eventStorePath: "stores/events.ndjson",
        taskStorePath: "stores/tasks.json",
        authStorePath: "stores/agent-auth.json",
        agentRunStorePath: "stores/agent-runs.json",
        providerCursorStorePath: "stores/provider-cursors.json",
        eventSubscriptionStorePath: "stores/event-subscriptions.json",
        eventDeliveryStorePath: "stores/event-deliveries.json",
        agentProfileStorePath: "stores/agent-profiles.json",
        routingRuleStorePath: "stores/routing-rules.json",
        routingAuditStorePath: "stores/routing-audit.json",
      },
    exports: {
      markdown: {
        enabled: markdownExport,
        path: "notes",
      },
    },
    providers: {
      github: {
        mode: resolvedProviderMode,
        tokenEnv: "GITHUB_TOKEN",
        deliveryMode: "polling",
        importMode: "from_now",
      },
      circleci: {
        mode: resolvedProviderMode === "real" ? "real" : "disabled",
        tokenEnv: "CIRCLECI_TOKEN",
        deliveryMode: "polling",
      },
      linear: {
        mode: resolvedProviderMode === "real" ? "real" : "disabled",
        tokenEnv: "LINEAR_API_KEY",
        deliveryMode: "polling",
      },
    },
    repos: [{
      path: repoRoot,
      slug: allowlist[0] ?? detectedRepo.remoteSlug ?? repoRoot,
      defaultBranch: branch,
    }],
  };
}

export function validateSafeDefaults(
  config: SetupConfig,
  detectedRepo: DetectedRepoContext,
): SafetyValidation {
  const reasons: string[] = [];
  const hostname = readHostname(config.server.baseUrl);

  if (!hostname || !["127.0.0.1", "localhost", "::1"].includes(hostname)) {
    reasons.push("`--yes` requires a local bind on 127.0.0.1, localhost, or ::1.");
  }

  if (
    config.providers.github.mode === "real"
    || config.providers.circleci.mode === "real"
    || config.providers.linear.mode === "real"
  ) {
    reasons.push("`--yes` cannot be used when live GitHub, CircleCI, or Linear providers would be enabled.");
  }

  return {
    ok: reasons.length === 0,
    reasons,
  };
}

export function buildInitCommand(config: SetupConfig): string {
  const parts = [
    "agentrail init",
    `--mode ${config.mode}`,
    `--base-url ${config.server.baseUrl}`,
    `--port ${config.server.port}`,
    `--persistence ${config.persistence.kind}`,
    `--repo ${quoteShell(config.repos[0]?.path ?? "", { force: true })}`,
    `--repo-allowlist ${config.repos.map((repo) => quoteShell(repo.slug)).join(",")}`,
    `--default-branch ${quoteShell(config.repos[0]?.defaultBranch ?? "main")}`,
  ];

  if (config.providers.github.mode !== "real") {
    parts.push(`--provider-mode ${config.providers.github.mode}`);
  }

  if (config.exports.markdown.enabled) {
    parts.push("--markdown-export");
  }

  return parts.join(" ");
}

export function buildSetupPlan(config: SetupConfig): string[] {
  const steps = [
    "Write ~/.agentrail/config.json",
    "Write ~/.agentrail/agent.env.example",
    "Write ~/.agentrail/server.env",
    "Write ~/.agentrail/README.md",
    "Write ~/.agentrail/operator.env",
  ];

  if (config.exports.markdown.enabled) {
    steps.push("Create ~/.agentrail/notes for read-only Markdown snapshots");
  }

  steps.push(`Prepare local API config for ${config.server.baseUrl}`);

  return steps;
}

function resolveServer({
  host,
  port,
  baseUrl,
}: {
  host?: string;
  port?: number;
  baseUrl?: string;
}) {
  if (baseUrl) {
    const parsed = new URL(baseUrl);
    return {
      host: parsed.hostname,
      port: Number.parseInt(parsed.port || `${port ?? DEFAULT_PORT}`, 10),
      baseUrl: parsed.toString().replace(/\/$/, ""),
    };
  }

  const resolvedHost = host ?? DEFAULT_HOST;
  const resolvedPort = port ?? DEFAULT_PORT;

  return {
    host: resolvedHost,
    port: resolvedPort,
    baseUrl: `http://${resolvedHost}:${resolvedPort}`,
  };
}

function readHostname(baseUrl: string): string | null {
  try {
    return new URL(baseUrl).hostname;
  } catch {
    return null;
  }
}

function quoteShell(value: string, { force = false }: { force?: boolean } = {}): string {
  if (!force && /^[A-Za-z0-9_./:-]+$/.test(value)) {
    return value;
  }

  return `'${value.replace(/'/g, `'\\''`)}'`;
}
