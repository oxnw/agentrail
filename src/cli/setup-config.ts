import path from "node:path";

export type SetupMode = "server";
export type ProviderMode = "real" | "disabled";
export type PersistenceKind = "file" | "memory";
export type InteractionMode = "interactive" | "non_interactive" | "print_only";

export interface DetectedRepoContext {
  repoPath: string;
  remoteSlug: string | null;
  defaultBranch: string;
  gitIgnoreHasAgentrail: boolean;
}

export interface SetupConfig {
  version: 1;
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
      engine: "sqlite";
      eventStorePath: string;
      statePath: string;
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
    };
    circleci: {
      mode: "real" | "disabled";
      tokenEnv: string;
      webhookSecretEnv: string;
    };
  };
  targetRepo: {
    path: string;
    allowlist: string[];
    defaultBranch: string;
  };
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
    version: 1,
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
        engine: "sqlite",
        eventStorePath: ".agentrail/events.ndjson",
        statePath: ".agentrail/state.sqlite",
      },
    exports: {
      markdown: {
        enabled: markdownExport,
        path: ".agentrail/notes",
      },
    },
    providers: {
      github: {
        mode: resolvedProviderMode,
        tokenEnv: "GITHUB_TOKEN",
      },
      circleci: {
        mode: resolvedProviderMode === "real" ? "real" : "disabled",
        tokenEnv: "CIRCLECI_TOKEN",
        webhookSecretEnv: "CIRCLECI_WEBHOOK_SECRET",
      },
    },
    targetRepo: {
      path: repoRoot,
      allowlist,
      defaultBranch: branch,
    },
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

  if (config.providers.github.mode === "real" || config.providers.circleci.mode === "real") {
    reasons.push("`--yes` cannot be used when live GitHub or CircleCI providers would be enabled.");
  }

  if (!detectedRepo.gitIgnoreHasAgentrail) {
    reasons.push("`--yes` requires `.agentrail/` to be ignored by git in the target repo `.gitignore`.");
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
    `--repo ${quoteShell(config.targetRepo.path, { force: true })}`,
    `--repo-allowlist ${config.targetRepo.allowlist.map(value => quoteShell(value)).join(",")}`,
    `--default-branch ${quoteShell(config.targetRepo.defaultBranch)}`,
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
    "Write .agentrail/config.json",
    "Write .agentrail/agent.env.example",
    "Write .agentrail/README.md",
    "Seed GitHub and CircleCI provider placeholders without storing secrets",
  ];

  if (config.exports.markdown.enabled) {
    steps.push("Create .agentrail/notes for read-only Markdown snapshots");
  }

  steps.push(`Prepare local API config for ${config.server.baseUrl}`);
  steps.push("Leave .agentrail/agent.env for the later registration step only");

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
