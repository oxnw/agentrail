import path from "node:path";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";

import {
  configPathForHome,
  providerEnvPathForHome,
  readSetupConfigFromHome,
  resolveAgentRailHome,
  type SetupConfigLike,
} from "./agentrail-home.ts";
import { createPromptSession, type PromptSession } from "./prompt.ts";
import {
  buildGitHubWebhookUrl,
  registerGitHubWebhook,
  verifyGitHubWebhookMetadata,
  type GitHubWebhookMetadata,
} from "../github-webhook-registration.ts";

interface Writer {
  write(chunk: string | Uint8Array): boolean;
}

interface ProviderConfig {
  github?: {
    mode?: string;
    tokenEnv?: string;
    deliveryMode?: string;
    importMode?: string;
    pollIntervalMs?: number;
    webhookSecretEnv?: string;
    registeredWebhooks?: unknown;
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
}

type ProviderName = "github" | "circleci" | "linear";
type ProviderDeliveryMode = "polling" | "webhook";

const POLL_INTERVAL_CHOICES = {
  "60000": "Every 1 minute",
  "300000": "Every 5 minutes",
  "900000": "Every 15 minutes",
} as const;

export async function runProviderCommand(argv: string[], {
  cwd,
  stdinIsTTY,
  stdoutIsTTY,
  stdout,
  stderr,
  createPrompt,
  fetch: fetchImpl,
}: {
  cwd: string;
  stdinIsTTY: boolean;
  stdoutIsTTY: boolean;
  stdout: Writer;
  stderr: Writer;
  createPrompt?: () => PromptSession;
  fetch?: typeof globalThis.fetch;
}): Promise<number> {
  const [subcommand, maybeProvider, ...rest] = argv;
  const homePath = resolveAgentRailHome({ cwd, explicitHome: null });
  const config = await readSetupConfigFromHome(homePath);
  if (!config) {
    stderr.write(`No AgentRail config found in ${homePath}. Run \`agentrail init\` first.\n`);
    return 1;
  }

  if (subcommand === "list") {
    const env = await readSimpleEnv(providerEnvPathForHome(homePath));
    const providers = config.providers ?? {};
    stdout.write(`AgentRail home: ${homePath}\n`);
    stdout.write(renderProviderStatus("github", providers, env, config.repos ?? []));
    stdout.write(renderProviderStatus("circleci", providers, env, config.repos ?? []));
    stdout.write(renderProviderStatus("linear", providers, env, config.repos ?? []));
    return 0;
  }

  if (subcommand === "test") {
    const provider = parseProviderName(maybeProvider);
    const env = await readSimpleEnv(providerEnvPathForHome(homePath));
    const result = await testProvider(provider, config.providers ?? {}, env, {
      fetch: fetchImpl ?? globalThis.fetch,
      repos: config.repos ?? [],
    });
    if (!result.ok) {
      stderr.write(`${result.message}\n`);
      return 1;
    }
    stdout.write(`${result.message}\n`);
    return 0;
  }

  if (subcommand === "connect") {
    const provider = parseProviderName(maybeProvider);
    const { flags, warnings } = parseProviderConnectFlags(rest);
    const interactive = stdinIsTTY && stdoutIsTTY;
    const prompt = interactive ? (createPrompt ?? (() => createPromptSession()))() : null;
    try {
      for (const warning of warnings) {
        stderr.write(`${warning}\n`);
      }
      if (provider === "github") {
        return await connectGitHub({ homePath, config, flags, prompt, stdout, stderr, fetch: fetchImpl ?? globalThis.fetch });
      }
      if (provider === "linear") {
        return await connectLinear({ homePath, config, flags, prompt, stdout, stderr, fetch: fetchImpl ?? globalThis.fetch });
      }
      return await connectCircleCI({ homePath, config, flags, prompt, stdout, stderr, fetch: fetchImpl ?? globalThis.fetch });
    } finally {
      await prompt?.close();
    }
  }

  stderr.write("Usage: agentrail provider connect <github|circleci|linear> | list | test <provider>\n");
  return 1;
}

async function connectGitHub({
  homePath,
  config,
  flags,
  prompt,
  stdout,
  stderr,
  fetch,
}: {
  homePath: string;
  config: SetupConfigLike;
  flags: ProviderConnectFlags;
  prompt: PromptSession | null;
  stdout: Writer;
  stderr: Writer;
  fetch: typeof globalThis.fetch;
}): Promise<number> {
  const currentEnv = config.providers?.github?.tokenEnv ?? "GITHUB_TOKEN";
  const currentWebhookEnv = config.providers?.github?.webhookSecretEnv ?? "GITHUB_WEBHOOK_SECRET";
  const tokenEnvName = flags.tokenEnv ?? currentEnv;
  const webhookSecretEnvName = flags.webhookSecretEnv ?? currentWebhookEnv;
  const deliveryMode = await resolveDeliveryMode({
    provider: "GitHub",
    config,
    prompt,
    stderr,
    requested: flags.deliveryMode ?? normalizeDeliveryMode(config.providers?.github?.deliveryMode, "polling"),
    pollingLabel: "Polling",
    pollingHint: "Discover issues and refresh CI on an interval.",
    webhookLabel: "Webhook",
    webhookHint: "Receive GitHub issue and workflow events in real time.",
  });
  if (!deliveryMode) {
    return 1;
  }

  if (prompt) {
    await prompt.note({
      title: "GitHub connection",
      body: [
        "Connect GitHub so AgentRail can use GitHub issue, review, submit, and CI integrations.",
        deliveryMode === "webhook"
          ? `Paste your GitHub Personal Access Token and webhook secret when prompted. AgentRail will hide them as you type, then save them as \`${tokenEnvName}\` and \`${webhookSecretEnvName}\` in \`~/.agentrail/provider.env\`.`
          : `Paste your GitHub Personal Access Token when prompted. AgentRail will hide it as you type, then save it as \`${tokenEnvName}\` in \`~/.agentrail/provider.env\`.`,
      ].join("\n"),
    });
  }

  const tokenValue = prompt
    ? await prompt.secret({ message: `Paste your GitHub Personal Access Token (${tokenEnvName})` })
    : process.env[tokenEnvName];
  if (!tokenValue) {
    stderr.write(prompt
      ? "GitHub Personal Access Token is required to connect GitHub.\n"
      : `Missing ${tokenEnvName} in this shell. Export it first, then run \`agentrail provider connect github\` again.\n`);
    return 1;
  }
  const webhookSecretValue = deliveryMode === "webhook"
    ? (prompt
      ? await prompt.secret({ message: `Paste your GitHub webhook secret (${webhookSecretEnvName})` })
      : process.env[webhookSecretEnvName])
    : null;
  if (deliveryMode === "webhook" && !webhookSecretValue) {
    stderr.write(prompt
      ? "GitHub webhook secret is required in webhook mode.\n"
      : `Missing ${webhookSecretEnvName} in this shell. Export it first, then run \`agentrail provider connect github --delivery-mode webhook\` again.\n`);
    return 1;
  }
  const pollIntervalMs = await resolvePollIntervalMs({
    prompt,
    deliveryMode,
    requestedSeconds: flags.pollIntervalSeconds,
    currentMs: config.providers?.github?.pollIntervalMs,
    message: "How often should AgentRail poll GitHub for issue and CI updates?",
  });

  const spinner = prompt?.spinner() ?? null;
  try {
    spinner?.start("Testing GitHub connection");
    await verifyGitHubConnection({
      token: tokenValue,
      fetch,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (spinner) {
      spinner.error(message);
    } else {
      stderr.write(`${message}\n`);
    }
    return 1;
  }

  let registeredWebhooks: GitHubWebhookMetadata[] | undefined;
  if (deliveryMode === "webhook") {
    const webhookUrl = buildGitHubWebhookUrl(config.server?.baseUrl ?? "");
    const repos = configuredGitHubRepoSlugs(config.repos ?? []);
    if (repos.length === 0) {
      const message = "GitHub webhook registration requires at least one configured GitHub repository.";
      if (spinner) {
        spinner.error(message);
      } else {
        stderr.write(`${message}\n`);
      }
      return 1;
    }
    try {
      registeredWebhooks = [];
      for (const repoSlug of repos) {
        const result = await registerGitHubWebhook({
          token: tokenValue,
          repoSlug,
          webhookUrl,
          secret: webhookSecretValue!,
          fetch,
        });
        registeredWebhooks.push(result.hook);
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (spinner) {
        spinner.error(message);
      } else {
        stderr.write(`${message}\n`);
      }
      return 1;
    }
  }

  await writeProviderEnv(homePath, deliveryMode === "webhook"
    ? {
        [tokenEnvName]: tokenValue,
        [webhookSecretEnvName]: webhookSecretValue!,
      }
    : {
        [tokenEnvName]: tokenValue,
      });
  const nextConfig = structuredClone(config);
  nextConfig.providers = nextConfig.providers ?? {};
  nextConfig.providers.github = {
    mode: "real",
    tokenEnv: tokenEnvName,
    deliveryMode,
    importMode: config.providers?.github?.importMode ?? "from_now",
    pollIntervalMs: deliveryMode === "polling" ? pollIntervalMs ?? 60_000 : undefined,
    webhookSecretEnv: deliveryMode === "webhook" ? webhookSecretEnvName : undefined,
    registeredWebhooks,
  };
  await writeConfig(homePath, nextConfig);
  const message = deliveryMode === "webhook"
    ? `\u2713 Connected GitHub using ${tokenEnvName} in webhook mode.`
    : `\u2713 Connected GitHub using ${tokenEnvName} in polling mode.`;
  if (spinner) {
    spinner.stop(message);
  } else {
    stdout.write(`${message}\n`);
  }
  return 0;
}

async function connectCircleCI({
  homePath,
  config,
  flags,
  prompt,
  stdout,
  stderr,
  fetch,
}: {
  homePath: string;
  config: SetupConfigLike;
  flags: ProviderConnectFlags;
  prompt: PromptSession | null;
  stdout: Writer;
  stderr: Writer;
  fetch: typeof globalThis.fetch;
}): Promise<number> {
  const currentTokenEnv = config.providers?.circleci?.tokenEnv ?? "CIRCLECI_TOKEN";
  const currentWebhookEnv = config.providers?.circleci?.webhookSecretEnv ?? "CIRCLECI_WEBHOOK_SECRET";
  const tokenEnvName = flags.tokenEnv ?? currentTokenEnv;
  const webhookSecretEnvName = flags.webhookSecretEnv ?? currentWebhookEnv;
  const deliveryMode = await resolveDeliveryMode({
    provider: "CircleCI",
    config,
    prompt,
    stderr,
    requested: flags.deliveryMode ?? normalizeDeliveryMode(config.providers?.circleci?.deliveryMode, "polling"),
    pollingLabel: "Polling",
    pollingHint: "Poll CI state for known CircleCI-backed tasks.",
    webhookLabel: "Webhook",
    webhookHint: "Receive CircleCI job and workflow events in real time.",
  });
  if (!deliveryMode) {
    return 1;
  }
  if (prompt) {
    await prompt.note({
      title: "CircleCI connection",
      body: [
        "Connect CircleCI so AgentRail can monitor CI for existing tasks.",
        "Paste the full CircleCI project slug from Project Settings > Overview, for example `circleci/<org-id>/<project-id>`.",
        deliveryMode === "webhook"
          ? `Paste your CircleCI token, project slug, and webhook secret when prompted. AgentRail will hide secrets as you type, save the secrets in \`~/.agentrail/provider.env\`, and persist the project slug in repo config.`
          : `Paste your CircleCI token and project slug when prompted. AgentRail will hide the token as you type, save it in \`~/.agentrail/provider.env\`, and persist the project slug in repo config.`,
      ].join("\n"),
    });
  }
  const tokenValue = prompt
    ? await prompt.secret({
      message: `Paste your CircleCI token (${tokenEnvName})`,
    })
    : process.env[tokenEnvName];
  const webhookSecretValue = deliveryMode === "webhook"
    ? (prompt
      ? await prompt.secret({
        message: `Paste your CircleCI webhook secret (${webhookSecretEnvName})`,
      })
      : process.env[webhookSecretEnvName])
    : null;
  if (!tokenValue) {
    stderr.write(prompt
      ? "CircleCI token is required to connect CircleCI.\n"
      : `Missing ${tokenEnvName} in this shell. Export it first, then run \`agentrail provider connect circleci\` again.\n`);
    return 1;
  }
  if (deliveryMode === "webhook" && !webhookSecretValue) {
    stderr.write(prompt
      ? "CircleCI webhook secret is required in webhook mode.\n"
      : `Missing ${webhookSecretEnvName} in this shell. Export it first, then run \`agentrail provider connect circleci --delivery-mode webhook\` again.\n`);
    return 1;
  }
  let circleCiProjectSlugs: Map<string, string>;
  try {
    const resolved = await resolveCircleCiProjectSlugs({
      repos: config.repos ?? [],
      projectSlugFlag: flags.projectSlug,
      prompt,
      stderr,
    });
    if (!resolved) {
      return 1;
    }
    circleCiProjectSlugs = resolved;
  } catch (error) {
    stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    return 1;
  }
  const pollIntervalMs = await resolvePollIntervalMs({
    prompt,
    deliveryMode,
    requestedSeconds: flags.pollIntervalSeconds,
    currentMs: config.providers?.circleci?.pollIntervalMs,
    message: "How often should AgentRail poll CircleCI for CI updates?",
  });

  const spinner = prompt?.spinner() ?? null;
  try {
    spinner?.start("Testing CircleCI connection");
    await verifyCircleCiConnection({
      token: tokenValue,
      fetch,
      projectSlugs: [...circleCiProjectSlugs.values()],
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (spinner) {
      spinner.error(message);
    } else {
      stderr.write(`${message}\n`);
    }
    return 1;
  }

  await writeProviderEnv(homePath, deliveryMode === "webhook"
    ? {
        [tokenEnvName]: tokenValue,
        [webhookSecretEnvName]: webhookSecretValue!,
      }
    : {
        [tokenEnvName]: tokenValue,
      });
  const nextConfig = structuredClone(config);
  nextConfig.providers = nextConfig.providers ?? {};
  nextConfig.providers.circleci = {
    mode: "real",
    tokenEnv: tokenEnvName,
    deliveryMode,
    pollIntervalMs: deliveryMode === "polling" ? pollIntervalMs ?? 60_000 : undefined,
    webhookSecretEnv: deliveryMode === "webhook" ? webhookSecretEnvName : undefined,
  };
  nextConfig.repos = (nextConfig.repos ?? []).map((repo) => ({
    ...repo,
    ...(circleCiProjectSlugs.has(repo.slug)
      ? { circleciProjectSlug: circleCiProjectSlugs.get(repo.slug)! }
      : {}),
  }));
  await writeConfig(homePath, nextConfig);
  const env = await readSimpleEnv(providerEnvPathForHome(homePath));
  const result = await testProvider("circleci", nextConfig.providers ?? {}, env, {
    fetch,
    repos: nextConfig.repos ?? [],
  });
  if (!result.ok) {
    stderr.write(`${result.message}\n`);
    return 1;
  }
  const successMessage = deliveryMode === "webhook"
    ? `\u2713 Connected CircleCI using ${tokenEnvName}, ${webhookSecretEnvName}, and ${circleCiProjectSlugs.size === 1 ? "project slug" : `${circleCiProjectSlugs.size} project slugs`} in webhook mode.`
    : `\u2713 Connected CircleCI using ${tokenEnvName} and ${circleCiProjectSlugs.size === 1 ? "project slug" : `${circleCiProjectSlugs.size} project slugs`} in polling mode.`;
  if (spinner) {
    spinner.stop(successMessage);
  } else {
    stdout.write(`${successMessage}\n`);
  }
  return 0;
}

async function connectLinear({
  homePath,
  config,
  flags,
  prompt,
  stdout,
  stderr,
  fetch,
}: {
  homePath: string;
  config: SetupConfigLike;
  flags: ProviderConnectFlags;
  prompt: PromptSession | null;
  stdout: Writer;
  stderr: Writer;
  fetch: typeof globalThis.fetch;
}): Promise<number> {
  const currentTokenEnv = config.providers?.linear?.tokenEnv ?? "LINEAR_API_KEY";
  const currentWebhookEnv = config.providers?.linear?.webhookSecretEnv ?? "LINEAR_WEBHOOK_SECRET";
  const tokenEnvName = flags.tokenEnv ?? currentTokenEnv;
  const webhookSecretEnvName = flags.webhookSecretEnv ?? currentWebhookEnv;
  const deliveryMode = await resolveDeliveryMode({
    provider: "Linear",
    config,
    prompt,
    stderr,
    requested: flags.deliveryMode ?? normalizeDeliveryMode(
      config.providers?.linear?.deliveryMode ?? (config.providers?.linear?.syncMode === "polling" ? "polling" : undefined),
      "polling",
    ),
    pollingLabel: "Polling",
    pollingHint: "Discover and refresh Linear issues on an interval.",
    webhookLabel: "Webhook",
    webhookHint: "Receive Linear issue and comment events in real time.",
  });
  if (!deliveryMode) {
    return 1;
  }

  if (prompt) {
    await prompt.note({
      title: "Linear connection",
      body: [
        "Connect Linear so AgentRail can import issues and keep them in sync.",
        deliveryMode === "webhook"
          ? `Paste your Linear API key and webhook secret when prompted. AgentRail will hide them as you type, then save them as \`${tokenEnvName}\` and \`${webhookSecretEnvName}\` in \`~/.agentrail/provider.env\`.`
          : `Paste your Linear API key when prompted. AgentRail will hide it as you type, then save it as \`${tokenEnvName}\` in \`~/.agentrail/provider.env\`.`,
      ].join("\n"),
    });
  }

  const tokenValue = prompt
    ? await prompt.secret({
      message: `Paste your Linear API key (${tokenEnvName})`,
    })
    : process.env[tokenEnvName];

  if (!tokenValue) {
    stderr.write(prompt
      ? "Linear API key is required to connect Linear.\n"
      : `Missing ${tokenEnvName} in this shell. Export it first, then run \`agentrail provider connect linear\` again.\n`);
    return 1;
  }
  const webhookSecretValue = deliveryMode === "webhook"
    ? (prompt
      ? await prompt.secret({
        message: `Paste your Linear webhook secret (${webhookSecretEnvName})`,
      })
      : process.env[webhookSecretEnvName])
    : null;
  if (deliveryMode === "webhook" && !webhookSecretValue) {
    stderr.write(prompt
      ? "Linear webhook secret is required in webhook mode.\n"
      : `Missing ${webhookSecretEnvName} in this shell. Export it first, then run \`agentrail provider connect linear --delivery-mode webhook\` again.\n`);
    return 1;
  }
  const resolvedPollIntervalMs = await resolvePollIntervalMs({
    prompt,
    deliveryMode,
    requestedSeconds: flags.pollIntervalSeconds,
    currentMs: config.providers?.linear?.pollIntervalMs,
    message: "How often should AgentRail poll Linear for issue updates?",
  });

  const spinner = prompt?.spinner() ?? null;
  try {
    spinner?.start("Testing Linear connection");
    await verifyLinearConnection({
      token: tokenValue,
      fetch,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (spinner) {
      spinner.error(message);
    } else {
      stderr.write(`${message}\n`);
    }
    return 1;
  }

  await writeProviderEnv(homePath, deliveryMode === "webhook"
    ? {
        [tokenEnvName]: tokenValue,
        [webhookSecretEnvName]: webhookSecretValue!,
      }
    : {
        [tokenEnvName]: tokenValue,
      });
  const nextConfig = structuredClone(config);
  nextConfig.providers = nextConfig.providers ?? {};
  nextConfig.providers.linear = {
    mode: "real",
    tokenEnv: tokenEnvName,
    deliveryMode,
    pollIntervalMs: deliveryMode === "polling" ? resolvedPollIntervalMs ?? 60_000 : undefined,
    webhookSecretEnv: deliveryMode === "webhook" ? webhookSecretEnvName : undefined,
  };
  await writeConfig(homePath, nextConfig);

  const message = deliveryMode === "polling"
    ? `\u2713 Connected Linear using ${tokenEnvName} in polling mode. Start AgentRail to discover and refresh issues automatically, or run \`agentrail linear import ENG-123\` to import one now.`
    : `\u2713 Connected Linear using ${tokenEnvName} and ${webhookSecretEnvName} in webhook mode.`;
  if (spinner) {
    spinner.stop(message);
  } else {
    stdout.write(`${message}\n`);
  }
  return 0;
}

interface ProviderConnectFlags {
  tokenEnv?: string;
  webhookSecretEnv?: string;
  deliveryMode?: ProviderDeliveryMode;
  pollIntervalSeconds?: number;
  projectSlug?: string;
}

interface ParsedProviderConnectFlags {
  flags: ProviderConnectFlags;
  warnings: string[];
}

function parseProviderConnectFlags(argv: string[]): ParsedProviderConnectFlags {
  const flags: ProviderConnectFlags = {};
  const warnings: string[] = [];
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    switch (arg) {
      case "--token-env":
        flags.tokenEnv = nextValue(argv, ++index, arg);
        break;
      case "--webhook-secret-env":
        flags.webhookSecretEnv = nextValue(argv, ++index, arg);
        break;
      case "--delivery-mode":
        {
          const value = nextValue(argv, ++index, arg);
          if (value !== "polling" && value !== "webhook") {
            throw new Error(`Invalid --delivery-mode value "${value}". Must be "polling" or "webhook".`);
          }
          flags.deliveryMode = value;
        }
        break;
      case "--sync-mode":
        {
          const value = nextValue(argv, ++index, arg);
          if (value !== "polling") {
            throw new Error(`Invalid --sync-mode value "${value}". Use --delivery-mode polling instead.`);
          }
          warnings.push("Warning: --sync-mode is deprecated. Use --delivery-mode instead.");
          flags.deliveryMode = "polling";
        }
        break;
      case "--poll-interval-seconds":
        {
          const value = Number.parseInt(nextValue(argv, ++index, arg), 10);
          if (!Number.isFinite(value) || value <= 0) {
            throw new Error("--poll-interval-seconds must be a positive integer.");
          }
          flags.pollIntervalSeconds = value;
        }
        break;
      case "--project-slug":
        flags.projectSlug = nextValue(argv, ++index, arg).trim();
        break;
      default:
        throw new Error(`Unknown flag "${arg}".`);
    }
  }
  return { flags, warnings };
}

interface LinearGraphQLConnectionResponse {
  data?: {
    viewer?: {
      id?: string;
      name?: string;
    };
  };
  errors?: Array<{
    message?: string;
  }>;
}

function linearGraphQLErrorMessage(errors: LinearGraphQLConnectionResponse["errors"]): string | null {
  if (!Array.isArray(errors) || errors.length === 0) {
    return null;
  }
  const messages = errors
    .map((error) => typeof error?.message === "string" ? error.message.trim() : "")
    .filter(Boolean);
  return messages.length > 0 ? messages.join("; ") : null;
}

function parseProviderName(value: string | undefined): ProviderName {
  if (value === "github" || value === "circleci" || value === "linear") return value;
  throw new Error("Provider must be one of: github, circleci, linear.");
}

async function writeConfig(homePath: string, config: SetupConfigLike): Promise<void> {
  // Older local installs may still have this removed store on disk; drop it whenever
  // provider config is rewritten so the home stays aligned with the current model.
  await rm(path.join(homePath, "stores", "provider-identity-mappings.json"), { force: true });
  await writeFile(configPathForHome(homePath), `${JSON.stringify(config, null, 2)}\n`, "utf8");
}

async function writeProviderEnv(homePath: string, nextValues: Record<string, string>): Promise<void> {
  await mkdir(homePath, { recursive: true });
  const filePath = providerEnvPathForHome(homePath);
  const current = await readSimpleEnv(filePath);
  const merged = {
    ...current,
    ...nextValues,
  };
  const lines = [
    "# Generated by `agentrail provider connect`.",
    ...Object.entries(merged).sort(([left], [right]) => left.localeCompare(right)).map(([key, value]) => `${key}=${quoteEnv(value)}`),
    "",
  ];
  await writeFile(filePath, lines.join("\n"), { encoding: "utf8", mode: 0o600 });
}

async function readSimpleEnv(filePath: string): Promise<Record<string, string>> {
  try {
    const content = await readFile(filePath, "utf8");
    const parsed: Record<string, string> = {};
    for (const rawLine of content.split(/\r?\n/u)) {
      const line = rawLine.trim();
      if (!line || line.startsWith("#")) continue;
      const index = line.indexOf("=");
      if (index === -1) continue;
      parsed[line.slice(0, index).trim()] = stripQuotes(line.slice(index + 1).trim());
    }
    return parsed;
  } catch {
    return {};
  }
}

function stripQuotes(value: string): string {
  if (
    (value.startsWith("\"") && value.endsWith("\"")) ||
    (value.startsWith("'") && value.endsWith("'"))
  ) {
    return value.slice(1, -1);
  }
  return value;
}

function quoteEnv(value: string): string {
  return JSON.stringify(value);
}

async function resolveCircleCiProjectSlugs({
  repos,
  projectSlugFlag,
  prompt,
  stderr,
}: {
  repos: NonNullable<SetupConfigLike["repos"]>;
  projectSlugFlag?: string;
  prompt: PromptSession | null;
  stderr: Writer;
}): Promise<Map<string, string> | null> {
  if (!Array.isArray(repos) || repos.length === 0) {
    stderr.write("CircleCI connection requires at least one connected repo in AgentRail config.\n");
    return null;
  }
  if (projectSlugFlag && repos.length > 1) {
    stderr.write("`--project-slug` only works when exactly one repo is connected. Re-run interactively to enter a slug per repo.\n");
    return null;
  }

  const resolved = new Map<string, string>();
  for (const repo of repos) {
    const raw = projectSlugFlag ?? (prompt
      ? await prompt.input({
        message: `Paste the CircleCI project slug for ${repo.slug}`,
        defaultValue: repo.circleciProjectSlug ?? "",
      })
      : "");
    const projectSlug = normalizeCircleCiProjectSlug(raw);
    if (!projectSlug) {
      stderr.write(prompt
        ? `A CircleCI project slug is required for ${repo.slug}.\n`
        : "Missing `--project-slug`. Provide the full CircleCI project slug and run `agentrail provider connect circleci` again.\n");
      return null;
    }
    resolved.set(repo.slug, projectSlug);
  }
  return resolved;
}

function normalizeCircleCiProjectSlug(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim().replace(/^\/+|\/+$/gu, "");
  if (!trimmed) return null;
  const parts = trimmed.split("/");
  if (parts.length !== 3) {
    throw new Error(`Invalid CircleCI project slug "${trimmed}". Expected a full slug like \`circleci/<org-id>/<project-id>\` or \`gh/<owner>/<repo>\`.`);
  }
  if (parts.some((part) => part.trim().length === 0)) {
    throw new Error(`Invalid CircleCI project slug "${trimmed}". Each path segment must be non-empty.`);
  }
  return parts.join("/");
}

function encodeCircleCiProjectSlug(projectSlug: string): string {
  return projectSlug
    .split("/")
    .map((segment) => encodeURIComponent(segment))
    .join("/");
}

async function verifyCircleCiConnection({
  token,
  fetch,
  projectSlugs,
}: {
  token: string;
  fetch: typeof globalThis.fetch;
  projectSlugs: string[];
}): Promise<void> {
  if (typeof fetch !== "function") {
    throw new Error("CircleCI connection testing requires a fetch implementation.");
  }
  for (const projectSlug of projectSlugs) {
    const response = await fetch(`https://circleci.com/api/v2/project/${encodeCircleCiProjectSlug(projectSlug)}/pipeline?branch=main`, {
      headers: {
        "Circle-Token": token,
      },
    });
    if (!response.ok) {
      const text = await response.text().catch(() => "");
      throw new Error(
        response.status === 401 || response.status === 403
          ? `CircleCI connection test failed: CircleCI rejected the token for project slug ${projectSlug}.`
          : response.status === 404
            ? `CircleCI connection test failed: project slug ${projectSlug} was not found or is not accessible to this token.`
            : `CircleCI connection test failed for project slug ${projectSlug}: ${response.status} ${text.slice(0, 200)}`.trim(),
      );
    }
    await response.json().catch(() => null);
  }
}

function collectCircleCiProjectSlugs(repos: SetupConfigLike["repos"]): string[] {
  return [...new Set((repos ?? [])
    .map((repo) => normalizeCircleCiProjectSlug(repo.circleciProjectSlug))
    .filter((value): value is string => Boolean(value)))];
}

function renderCircleCiProjectSlugs(repos: SetupConfigLike["repos"]): string[] {
  const configured = (repos ?? [])
    .filter((repo) => typeof repo.circleciProjectSlug === "string" && repo.circleciProjectSlug.trim().length > 0)
    .map((repo) => `  ${repo.slug} -> ${repo.circleciProjectSlug!.trim()}`);
  if (configured.length === 0) {
    return ["  project slugs: none configured"];
  }
  return [
    `  project slugs: ${configured.length}`,
    ...configured,
  ];
}

function renderProviderStatus(provider: ProviderName, providers: ProviderConfig, env: Record<string, string>, repos: SetupConfigLike["repos"] = []): string {
  if (provider === "github") {
    const tokenEnv = providers.github?.tokenEnv ?? "GITHUB_TOKEN";
    const mode = providers.github?.mode ?? "disabled";
    const deliveryMode = normalizeDeliveryMode(providers.github?.deliveryMode, "polling");
    const available = resolveConfiguredValue(tokenEnv, env) ? "available" : "missing";
    const pollIntervalMs = Number.isFinite(providers.github?.pollIntervalMs) ? Number(providers.github?.pollIntervalMs) : null;
    const webhookSecretEnv = providers.github?.webhookSecretEnv;
    const registeredWebhooks = normalizeGitHubWebhookMetadata(providers.github?.registeredWebhooks);
    return [
      "GitHub",
      `  mode: ${mode}`,
      `  delivery mode: ${deliveryMode}`,
      `  token env: ${tokenEnv} (${available})`,
      ...(deliveryMode === "polling" && pollIntervalMs ? [`  poll interval: ${Math.round(pollIntervalMs / 1000)}s`] : []),
      ...(deliveryMode === "webhook"
        ? [
            `  webhook secret env: ${webhookSecretEnv ?? "GITHUB_WEBHOOK_SECRET"} (${resolveConfiguredValue(webhookSecretEnv ?? "GITHUB_WEBHOOK_SECRET", env) ? "available" : "missing"})`,
            ...renderGitHubWebhookMetadata(registeredWebhooks),
          ]
        : []),
      "",
    ].join("\n");
  }
  if (provider === "circleci") {
    const tokenEnv = providers.circleci?.tokenEnv ?? "CIRCLECI_TOKEN";
    const webhookSecretEnv = providers.circleci?.webhookSecretEnv ?? "CIRCLECI_WEBHOOK_SECRET";
    const mode = providers.circleci?.mode ?? "disabled";
    const deliveryMode = normalizeDeliveryMode(providers.circleci?.deliveryMode, "polling");
    const tokenAvailable = resolveConfiguredValue(tokenEnv, env) ? "available" : "missing";
    const webhookAvailable = resolveConfiguredValue(webhookSecretEnv, env) ? "available" : "missing";
    const pollIntervalMs = Number.isFinite(providers.circleci?.pollIntervalMs) ? Number(providers.circleci?.pollIntervalMs) : null;
    return [
      "CircleCI",
      `  mode: ${mode}`,
      `  delivery mode: ${deliveryMode}`,
      `  token env: ${tokenEnv} (${tokenAvailable})`,
      ...renderCircleCiProjectSlugs(repos),
      ...(deliveryMode === "polling" && pollIntervalMs ? [`  poll interval: ${Math.round(pollIntervalMs / 1000)}s`] : []),
      ...(deliveryMode === "webhook" ? [`  webhook secret env: ${webhookSecretEnv} (${webhookAvailable})`] : []),
      "",
    ].join("\n");
  }

  const tokenEnv = providers.linear?.tokenEnv ?? "LINEAR_API_KEY";
  const mode = providers.linear?.mode ?? "disabled";
  const deliveryMode = normalizeDeliveryMode(providers.linear?.deliveryMode ?? providers.linear?.syncMode, "polling");
  const tokenAvailable = resolveConfiguredValue(tokenEnv, env) ? "available" : "missing";
  const pollIntervalMs = Number.isFinite(providers.linear?.pollIntervalMs) ? Number(providers.linear?.pollIntervalMs) : null;
  const webhookSecretEnv = providers.linear?.webhookSecretEnv;
  const webhookSummary = webhookSecretEnv
    ? `  webhook secret env: ${webhookSecretEnv} (${resolveConfiguredValue(webhookSecretEnv, env) ? "available" : "missing"})`
    : "  webhook secret env: not configured";
  return [
    "Linear",
    `  mode: ${mode}`,
    `  delivery mode: ${deliveryMode}`,
    `  token env: ${tokenEnv} (${tokenAvailable})`,
    ...(deliveryMode === "polling" && pollIntervalMs ? [`  poll interval: ${Math.round(pollIntervalMs / 1000)}s`] : []),
    ...(deliveryMode === "webhook" ? [webhookSummary] : []),
    "",
  ].join("\n");
}

async function testProvider(
  provider: ProviderName,
  providers: ProviderConfig,
  env: Record<string, string>,
  {
    fetch,
    repos = [],
  }: {
    fetch: typeof globalThis.fetch;
    repos?: SetupConfigLike["repos"];
  },
): Promise<{ ok: boolean; message: string }> {
  if (provider === "github") {
    const tokenEnv = providers.github?.tokenEnv ?? "GITHUB_TOKEN";
    if (providers.github?.mode !== "real") {
      return { ok: false, message: "GitHub is not connected yet. Run `agentrail provider connect github`." };
    }
    const token = resolveConfiguredValue(tokenEnv, env);
    if (!token) {
      return { ok: false, message: `GitHub is configured, but ${tokenEnv} is not available in ~/.agentrail/provider.env or the current shell.` };
    }
    const deliveryMode = normalizeDeliveryMode(providers.github?.deliveryMode, "polling");
    const webhookSecretEnv = providers.github?.webhookSecretEnv ?? "GITHUB_WEBHOOK_SECRET";
    if (deliveryMode === "webhook" && !resolveConfiguredValue(webhookSecretEnv, env)) {
      return { ok: false, message: `GitHub webhook mode is configured, but ${webhookSecretEnv} is not available in ~/.agentrail/provider.env or the current shell.` };
    }
    const registeredWebhooks = normalizeGitHubWebhookMetadata(providers.github?.registeredWebhooks);
    if (deliveryMode === "webhook" && registeredWebhooks.length === 0) {
      return {
        ok: false,
        message: "GitHub webhook mode is configured, but no registered GitHub webhook metadata exists. Re-run `agentrail provider connect github --delivery-mode webhook`.",
      };
    }
    if (deliveryMode === "webhook") {
      const configuredRepoSlugs = configuredGitHubRepoSlugs(repos);
      const registeredRepoSlugs = new Set(registeredWebhooks.map((hook) => hook.repoSlug));
      const missingRepoSlugs = configuredRepoSlugs.filter((repoSlug) => !registeredRepoSlugs.has(repoSlug));
      if (missingRepoSlugs.length > 0) {
        return {
          ok: false,
          message: `GitHub webhook mode is configured, but missing registered GitHub webhook metadata for configured repositories: ${missingRepoSlugs.join(", ")}. Re-run \`agentrail provider connect github --delivery-mode webhook\`.`,
        };
      }
    }
    try {
      await verifyGitHubConnection({ token, fetch });
      await verifyGitHubRepoAccess({ token, fetch, repos });
      if (deliveryMode === "webhook") {
        await verifyGitHubWebhookMetadata({ token, fetch, metadata: registeredWebhooks });
      }
    } catch (error) {
      return { ok: false, message: error instanceof Error ? error.message : String(error) };
    }
    return {
      ok: true,
      message: `GitHub connection test passed. AgentRail can authenticate ${tokenEnv}, access configured repositories, and use ${deliveryMode} delivery. Restart AgentRail server if it was already running before this token changed.`,
    };
  }

  if (provider === "circleci") {
    const tokenEnv = providers.circleci?.tokenEnv ?? "CIRCLECI_TOKEN";
    const webhookSecretEnv = providers.circleci?.webhookSecretEnv ?? "CIRCLECI_WEBHOOK_SECRET";
    if (providers.circleci?.mode !== "real") {
      return { ok: false, message: "CircleCI is not connected yet. Run `agentrail provider connect circleci`." };
    }
    const token = resolveConfiguredValue(tokenEnv, env);
    if (!token) {
      return { ok: false, message: `CircleCI is configured, but ${tokenEnv} is not available in ~/.agentrail/provider.env or the current shell.` };
    }
    const projectSlugs = collectCircleCiProjectSlugs(repos);
    if (projectSlugs.length === 0) {
      return {
        ok: false,
        message: "CircleCI is configured, but no CircleCI project slug is stored for any connected repo. Re-run `agentrail provider connect circleci`.",
      };
    }
    const deliveryMode = normalizeDeliveryMode(providers.circleci?.deliveryMode, "polling");
    if (deliveryMode === "webhook" && !resolveConfiguredValue(webhookSecretEnv, env)) {
      return { ok: false, message: `CircleCI is configured, but ${webhookSecretEnv} is not available in ~/.agentrail/provider.env or the current shell.` };
    }
    try {
      await verifyCircleCiConnection({
        token,
        fetch,
        projectSlugs,
      });
    } catch (error) {
      return { ok: false, message: error instanceof Error ? error.message : String(error) };
    }
    return {
      ok: true,
      message: `CircleCI connection test passed. AgentRail can authenticate ${tokenEnv}, access ${projectSlugs.length} configured CircleCI project slug${projectSlugs.length === 1 ? "" : "s"}, and use ${deliveryMode} delivery.`,
    };
  }

  const tokenEnv = providers.linear?.tokenEnv ?? "LINEAR_API_KEY";
  if (providers.linear?.mode !== "real") {
    return { ok: false, message: "Linear is not connected yet. Run `agentrail provider connect linear`." };
  }
  if (!resolveConfiguredValue(tokenEnv, env)) {
    return { ok: false, message: `Linear is configured, but ${tokenEnv} is not available in ~/.agentrail/provider.env or the current shell.` };
  }
  const deliveryMode = normalizeDeliveryMode(providers.linear?.deliveryMode ?? providers.linear?.syncMode, "polling");
  const webhookSecretEnv = providers.linear?.webhookSecretEnv ?? "LINEAR_WEBHOOK_SECRET";
  if (deliveryMode === "webhook" && !resolveConfiguredValue(webhookSecretEnv, env)) {
    return { ok: false, message: `Linear webhook mode is configured, but ${webhookSecretEnv} is not available in ~/.agentrail/provider.env or the current shell.` };
  }
  return { ok: true, message: `Linear looks configured. AgentRail can read ${tokenEnv} and use ${deliveryMode} delivery.` };
}

async function verifyGitHubConnection({
  token,
  fetch,
}: {
  token: string;
  fetch: typeof globalThis.fetch;
}): Promise<void> {
  if (typeof fetch !== "function") {
    throw new Error("GitHub connection testing requires a fetch implementation.");
  }

  const response = await fetch("https://api.github.com/user", {
    headers: githubHeaders(token),
  });

  if (!response.ok) {
    const text = await response.text().catch(() => "");
    throw new Error(
      response.status === 401 || response.status === 403
        ? "GitHub connection test failed: GitHub rejected the token."
        : `GitHub connection test failed: ${response.status} ${text.slice(0, 200)}`.trim(),
    );
  }

  await response.json().catch(() => null);
}

async function verifyGitHubRepoAccess({
  token,
  fetch,
  repos = [],
}: {
  token: string;
  fetch: typeof globalThis.fetch;
  repos?: SetupConfigLike["repos"];
}): Promise<void> {
  const slugs = [...new Set((repos ?? [])
    .map((repo) => typeof repo?.slug === "string" ? repo.slug.trim() : "")
    .filter((slug) => /^[^/\s]+\/[^/\s]+$/u.test(slug)))];
  for (const slug of slugs) {
    const response = await fetch(`https://api.github.com/repos/${slug}`, {
      headers: githubHeaders(token),
    });
    if (!response.ok) {
      const text = await response.text().catch(() => "");
      throw new Error(
        response.status === 401 || response.status === 403
          ? `GitHub connection test failed: GitHub rejected the token for ${slug}.`
          : response.status === 404
            ? `GitHub connection test failed: token cannot access ${slug}.`
            : `GitHub connection test failed for ${slug}: ${response.status} ${text.slice(0, 200)}`.trim(),
      );
    }
    await response.json().catch(() => null);
  }
}

function configuredGitHubRepoSlugs(repos: SetupConfigLike["repos"]): string[] {
  return [...new Set((repos ?? [])
    .map((repo) => typeof repo?.slug === "string" ? repo.slug.trim() : "")
    .filter((slug) => /^[^/\s]+\/[^/\s]+$/u.test(slug)))];
}

function normalizeGitHubWebhookMetadata(value: unknown): GitHubWebhookMetadata[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((item): GitHubWebhookMetadata[] => {
    if (!item || typeof item !== "object") return [];
    const candidate = item as Partial<GitHubWebhookMetadata>;
    if (
      typeof candidate.repoSlug !== "string" ||
      !/^[^/\s]+\/[^/\s]+$/u.test(candidate.repoSlug) ||
      !Number.isInteger(candidate.hookId) ||
      typeof candidate.url !== "string"
    ) {
      return [];
    }
    return [{
      repoSlug: candidate.repoSlug,
      hookId: candidate.hookId,
      url: candidate.url,
      events: Array.isArray(candidate.events) ? candidate.events.filter((event): event is string => typeof event === "string") : [],
      active: candidate.active !== false,
    }];
  });
}

function renderGitHubWebhookMetadata(metadata: GitHubWebhookMetadata[]): string[] {
  if (metadata.length === 0) {
    return ["  registered webhooks: none"];
  }
  return [
    `  registered webhooks: ${metadata.length}`,
    ...metadata.map((hook) => `    ${hook.repoSlug}: hook ${hook.hookId} ${hook.active ? "active" : "inactive"} events=${hook.events.join(",") || "none"} -> ${hook.url}`),
  ];
}

function githubHeaders(token: string): Record<string, string> {
  return {
    accept: "application/vnd.github+json",
    "x-github-api-version": "2022-11-28",
    authorization: `Bearer ${token}`,
  };
}

async function verifyLinearConnection({
  token,
  fetch,
}: {
  token: string;
  fetch: typeof globalThis.fetch;
}): Promise<void> {
  if (typeof fetch !== "function") {
    throw new Error("Linear connection testing requires a fetch implementation.");
  }

  const response = await fetch("https://api.linear.app/graphql", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: token,
    },
    body: JSON.stringify({
      query: "query AgentRailViewer { viewer { id name } }",
    }),
  });

  const text = await response.text().catch(() => "");
  let body: LinearGraphQLConnectionResponse = {};
  try {
    body = text ? JSON.parse(text) as LinearGraphQLConnectionResponse : {};
  } catch {
    body = {};
  }

  if (!response.ok || Array.isArray(body.errors)) {
    const graphqlMessage = linearGraphQLErrorMessage(body.errors);
    throw new Error(
      response.status === 401 || response.status === 403
        ? "Linear connection test failed: Linear rejected the API key."
        : graphqlMessage
          ? `Linear connection test failed: ${graphqlMessage}`
        : `Linear connection test failed: ${response.status} ${text.slice(0, 200)}`.trim(),
    );
  }
}

function resolveConfiguredValue(envName: string, env: Record<string, string>): string | null {
  return env[envName] ?? process.env[envName] ?? null;
}

function nextValue(argv: string[], index: number, flag: string): string {
  const value = argv[index];
  if (!value || value.startsWith("--")) {
    throw new Error(`${flag} requires a value.`);
  }
  return value;
}

function normalizeDeliveryMode(value: string | undefined, fallback: ProviderDeliveryMode): ProviderDeliveryMode {
  return value === "webhook" ? "webhook" : fallback;
}

async function resolveDeliveryMode({
  provider,
  config,
  prompt,
  stderr,
  requested,
  pollingLabel,
  pollingHint,
  webhookLabel,
  webhookHint,
}: {
  provider: string;
  config: SetupConfigLike;
  prompt: PromptSession | null;
  stderr: Writer;
  requested: ProviderDeliveryMode;
  pollingLabel: string;
  pollingHint: string;
  webhookLabel: string;
  webhookHint: string;
}): Promise<ProviderDeliveryMode | null> {
  let attempt = requested;
  // In interactive mode, keep prompting until the user picks a supported delivery mode.
  while (true) {
    const selected = prompt
      ? await prompt.select({
        message: `How do you want to receive ${provider} events?`,
        defaultValue: attempt,
        choices: [
          { label: pollingLabel, value: "polling", hint: pollingHint },
          { label: webhookLabel, value: "webhook", hint: webhookHint },
        ],
      }) as ProviderDeliveryMode
      : attempt;
    if (selected !== "webhook") {
      return selected;
    }
    if (supportsWebhookDelivery(config.server?.baseUrl ?? null)) {
      return "webhook";
    }
    const message = `Webhook delivery for ${provider} requires a public HTTPS base URL. Update \`server.baseUrl\` and try again, or choose polling.\n`;
    if (!prompt) {
      stderr.write(message);
      return null;
    }
    await prompt.note({
      title: "Webhook unavailable",
      body: message.trim(),
    });
    attempt = "polling";
  }
}

function supportsWebhookDelivery(baseUrl: string | null | undefined): boolean {
  if (!baseUrl) return false;
  try {
    const parsed = new URL(baseUrl);
    if (parsed.protocol !== "https:") return false;
    const host = parsed.hostname.toLowerCase();
    if (["127.0.0.1", "localhost", "::1", "0.0.0.0"].includes(host)) {
      return false;
    }
    if (host.endsWith(".local") || host.endsWith(".internal") || host.endsWith(".lan")) {
      return false;
    }
    if (/^10\./u.test(host) || /^192\.168\./u.test(host)) {
      return false;
    }
    const private172 = host.match(/^172\.(\d+)\./u);
    if (private172) {
      const octet = Number(private172[1]);
      if (octet >= 16 && octet <= 31) {
        return false;
      }
    }
    return true;
  } catch {
    return false;
  }
}

async function resolvePollIntervalMs({
  prompt,
  deliveryMode,
  requestedSeconds,
  currentMs,
  message,
}: {
  prompt: PromptSession | null;
  deliveryMode: ProviderDeliveryMode;
  requestedSeconds: number | undefined;
  currentMs: number | undefined;
  message: string;
}): Promise<number | null> {
  if (deliveryMode !== "polling") {
    return null;
  }
  if (prompt) {
    return Number.parseInt(await prompt.select({
      message,
      defaultValue: intervalChoiceForMs(Number.isFinite(currentMs) ? Number(currentMs) : 60_000),
      choices: Object.entries(POLL_INTERVAL_CHOICES).map(([value, label]) => ({ label, value })),
    }), 10);
  }
  if (typeof requestedSeconds === "number") {
    return requestedSeconds * 1000;
  }
  if (Number.isFinite(currentMs)) {
    return Number(currentMs);
  }
  return 60_000;
}

function intervalChoiceForMs(value: number): string {
  if (value >= 900_000) return "900000";
  if (value >= 300_000) return "300000";
  return "60000";
}
