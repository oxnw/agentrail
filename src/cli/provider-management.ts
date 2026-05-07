import path from "node:path";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";

import {
  configPathForHome,
  providerEnvPathForHome,
  readSetupConfigFromHome,
  resolveAgentRailHome,
} from "./agentrail-home.ts";
import { createPromptSession, type PromptSession } from "./prompt.ts";

interface Writer {
  write(chunk: string | Uint8Array): boolean;
}

interface ProviderConfig {
  github?: {
    mode?: string;
    tokenEnv?: string;
  };
  circleci?: {
    mode?: string;
    tokenEnv?: string;
    webhookSecretEnv?: string;
  };
}

type ProviderName = "github" | "circleci";

export async function runProviderCommand(argv: string[], {
  cwd,
  stdinIsTTY,
  stdoutIsTTY,
  stdout,
  stderr,
  createPrompt,
}: {
  cwd: string;
  stdinIsTTY: boolean;
  stdoutIsTTY: boolean;
  stdout: Writer;
  stderr: Writer;
  createPrompt?: () => PromptSession;
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
    stdout.write(renderProviderStatus("github", providers, env));
    stdout.write(renderProviderStatus("circleci", providers, env));
    return 0;
  }

  if (subcommand === "test") {
    const provider = parseProviderName(maybeProvider);
    const env = await readSimpleEnv(providerEnvPathForHome(homePath));
    const result = testProvider(provider, config.providers ?? {}, env);
    if (!result.ok) {
      stderr.write(`${result.message}\n`);
      return 1;
    }
    stdout.write(`${result.message}\n`);
    return 0;
  }

  if (subcommand === "connect") {
    const provider = parseProviderName(maybeProvider);
    const flags = parseProviderConnectFlags(rest);
    const interactive = stdinIsTTY && stdoutIsTTY;
    const prompt = interactive ? (createPrompt ?? (() => createPromptSession()))() : null;
    try {
      if (provider === "github") {
        return await connectGitHub({ homePath, config, flags, prompt, stdout, stderr });
      }
      return await connectCircleCI({ homePath, config, flags, prompt, stdout, stderr });
    } finally {
      await prompt?.close();
    }
  }

  stderr.write("Usage: agentrail provider connect <github|circleci> | list | test <provider>\n");
  return 1;
}

async function connectGitHub({
  homePath,
  config,
  flags,
  prompt,
  stdout,
  stderr,
}: {
  homePath: string;
  config: any;
  flags: ProviderConnectFlags;
  prompt: PromptSession | null;
  stdout: Writer;
  stderr: Writer;
}): Promise<number> {
  const currentEnv = config.providers?.github?.tokenEnv ?? "GITHUB_TOKEN";
  if (prompt) {
    await prompt.note({
      title: "GitHub connection",
      body: [
        "Connect GitHub so AgentRail can use GitHub issue, review, and submit integrations.",
        "AgentRail will read the token from an env var that already exists in this shell, then save it into `~/.agentrail/provider.env` for local use.",
      ].join("\n"),
    });
  }
  const tokenEnvName = flags.tokenEnv ?? (prompt
    ? await prompt.input({
      message: "Which env var holds your GitHub token?",
      defaultValue: currentEnv,
    })
    : currentEnv);
  const tokenValue = process.env[tokenEnvName];
  if (!tokenValue) {
    stderr.write(`Missing ${tokenEnvName} in this shell. Export it first, then run \`agentrail provider connect github\` again.\n`);
    return 1;
  }

  await writeProviderEnv(homePath, {
    [tokenEnvName]: tokenValue,
  });
  const nextConfig = structuredClone(config);
  nextConfig.providers = nextConfig.providers ?? {};
  nextConfig.providers.github = {
    mode: "real",
    tokenEnv: tokenEnvName,
  };
  await writeConfig(homePath, nextConfig);
  stdout.write(`Connected GitHub using ${tokenEnvName}.\n`);
  stdout.write("Run `agentrail provider test github` to verify the local connection.\n");
  return 0;
}

async function connectCircleCI({
  homePath,
  config,
  flags,
  prompt,
  stdout,
  stderr,
}: {
  homePath: string;
  config: any;
  flags: ProviderConnectFlags;
  prompt: PromptSession | null;
  stdout: Writer;
  stderr: Writer;
}): Promise<number> {
  const currentTokenEnv = config.providers?.circleci?.tokenEnv ?? "CIRCLECI_TOKEN";
  const currentWebhookEnv = config.providers?.circleci?.webhookSecretEnv ?? "CIRCLECI_WEBHOOK_SECRET";
  if (prompt) {
    await prompt.note({
      title: "CircleCI connection",
      body: [
        "Connect CircleCI so AgentRail can read CI status and verify CircleCI webhooks.",
        "AgentRail will read the token and webhook secret from env vars that already exist in this shell, then save them into `~/.agentrail/provider.env` for local use.",
      ].join("\n"),
    });
  }
  const tokenEnvName = flags.tokenEnv ?? (prompt
    ? await prompt.input({
      message: "Which env var holds your CircleCI token?",
      defaultValue: currentTokenEnv,
    })
    : currentTokenEnv);
  const webhookSecretEnvName = flags.webhookSecretEnv ?? (prompt
    ? await prompt.input({
      message: "Which env var holds your CircleCI webhook secret?",
      defaultValue: currentWebhookEnv,
    })
    : currentWebhookEnv);
  const tokenValue = process.env[tokenEnvName];
  const webhookSecretValue = process.env[webhookSecretEnvName];
  if (!tokenValue) {
    stderr.write(`Missing ${tokenEnvName} in this shell. Export it first, then run \`agentrail provider connect circleci\` again.\n`);
    return 1;
  }
  if (!webhookSecretValue) {
    stderr.write(`Missing ${webhookSecretEnvName} in this shell. Export it first, then run \`agentrail provider connect circleci\` again.\n`);
    return 1;
  }

  await writeProviderEnv(homePath, {
    [tokenEnvName]: tokenValue,
    [webhookSecretEnvName]: webhookSecretValue,
  });
  const nextConfig = structuredClone(config);
  nextConfig.providers = nextConfig.providers ?? {};
  nextConfig.providers.circleci = {
    mode: "real",
    tokenEnv: tokenEnvName,
    webhookSecretEnv: webhookSecretEnvName,
  };
  await writeConfig(homePath, nextConfig);
  stdout.write(`Connected CircleCI using ${tokenEnvName} and ${webhookSecretEnvName}.\n`);
  stdout.write("Run `agentrail provider test circleci` to verify the local connection.\n");
  return 0;
}

interface ProviderConnectFlags {
  tokenEnv?: string;
  webhookSecretEnv?: string;
}

function parseProviderConnectFlags(argv: string[]): ProviderConnectFlags {
  const flags: ProviderConnectFlags = {};
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    switch (arg) {
      case "--token-env":
        flags.tokenEnv = nextValue(argv, ++index, arg);
        break;
      case "--webhook-secret-env":
        flags.webhookSecretEnv = nextValue(argv, ++index, arg);
        break;
      default:
        throw new Error(`Unknown flag "${arg}".`);
    }
  }
  return flags;
}

function parseProviderName(value: string | undefined): ProviderName {
  if (value === "github" || value === "circleci") return value;
  throw new Error("Provider must be one of: github, circleci.");
}

async function writeConfig(homePath: string, config: any): Promise<void> {
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

function renderProviderStatus(provider: ProviderName, providers: ProviderConfig, env: Record<string, string>): string {
  if (provider === "github") {
    const tokenEnv = providers.github?.tokenEnv ?? "GITHUB_TOKEN";
    const mode = providers.github?.mode ?? "disabled";
    const available = resolveConfiguredValue(tokenEnv, env) ? "available" : "missing";
    return [
      "GitHub",
      `  mode: ${mode}`,
      `  token env: ${tokenEnv}`,
      `  local credential: ${available}`,
      "",
    ].join("\n");
  }
  const tokenEnv = providers.circleci?.tokenEnv ?? "CIRCLECI_TOKEN";
  const webhookSecretEnv = providers.circleci?.webhookSecretEnv ?? "CIRCLECI_WEBHOOK_SECRET";
  const mode = providers.circleci?.mode ?? "disabled";
  const tokenAvailable = resolveConfiguredValue(tokenEnv, env) ? "available" : "missing";
  const webhookAvailable = resolveConfiguredValue(webhookSecretEnv, env) ? "available" : "missing";
  return [
    "CircleCI",
    `  mode: ${mode}`,
    `  token env: ${tokenEnv} (${tokenAvailable})`,
    `  webhook secret env: ${webhookSecretEnv} (${webhookAvailable})`,
    "",
  ].join("\n");
}

function testProvider(provider: ProviderName, providers: ProviderConfig, env: Record<string, string>): { ok: boolean; message: string } {
  if (provider === "github") {
    const tokenEnv = providers.github?.tokenEnv ?? "GITHUB_TOKEN";
    if (providers.github?.mode !== "real") {
      return { ok: false, message: "GitHub is not connected yet. Run `agentrail provider connect github`." };
    }
    if (!resolveConfiguredValue(tokenEnv, env)) {
      return { ok: false, message: `GitHub is configured, but ${tokenEnv} is not available in ~/.agentrail/provider.env or the current shell.` };
    }
    return { ok: true, message: `GitHub looks configured. AgentRail can read ${tokenEnv}.` };
  }

  const tokenEnv = providers.circleci?.tokenEnv ?? "CIRCLECI_TOKEN";
  const webhookSecretEnv = providers.circleci?.webhookSecretEnv ?? "CIRCLECI_WEBHOOK_SECRET";
  if (providers.circleci?.mode !== "real") {
    return { ok: false, message: "CircleCI is not connected yet. Run `agentrail provider connect circleci`." };
  }
  if (!resolveConfiguredValue(tokenEnv, env)) {
    return { ok: false, message: `CircleCI is configured, but ${tokenEnv} is not available in ~/.agentrail/provider.env or the current shell.` };
  }
  if (!resolveConfiguredValue(webhookSecretEnv, env)) {
    return { ok: false, message: `CircleCI is configured, but ${webhookSecretEnv} is not available in ~/.agentrail/provider.env or the current shell.` };
  }
  return { ok: true, message: `CircleCI looks configured. AgentRail can read ${tokenEnv} and ${webhookSecretEnv}.` };
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
