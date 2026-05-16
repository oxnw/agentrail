#!/usr/bin/env node

import path from "node:path";
import { realpathSync } from "node:fs";
import { pathToFileURL } from "node:url";

import { runDoctor } from "./doctor.ts";
import { parseAgentCreateArgs, runAgentCreate, runAgentUpdate } from "./agent-management.ts";
import { runAgentReport, runAgentRun, runAgentStatus, type AgentRunnerHooks } from "./agent-runner.ts";
import { primaryRepoFromConfig, readSetupConfigFromHome, resolveAgentRailHome } from "./agentrail-home.ts";
import { runConfigCommand, runRepoCommand, runServerStart } from "./global-management.ts";
import { runLinearCommand } from "./linear-management.ts";
import { ensureLocalOperatorBootstrap, hasExistingLocalAgents, withTemporaryLocalServer } from "./local-bootstrap.ts";
import { runEventCommand } from "./event-subscriptions.ts";
import { runRunContextCommand } from "./run-context.ts";
import { createPromptSession, PromptCancelledError, type PromptSession } from "./prompt.ts";
import { runProviderCommand } from "./provider-management.ts";
import { detectRepoContext } from "./repo-detection.ts";
import { buildInitCommand, createSetupConfig, normalizeRoutingFallbackBehavior, validateSafeDefaults, type DetectedRepoContext, type SetupConfig } from "./setup-config.ts";
import { writeSetupFiles, type WriteSetupFilesResult } from "./setup-files.ts";
import { runTaskResolveBlocker } from "./task-blocker.ts";
import { runTaskSourceRepair } from "./task-source-repair.ts";
import {
  acceptedDefaultsFromFlags,
  createSetupConfigFromFlags,
  runSetupWizard,
  type InitFlags,
} from "./setup-wizard.ts";

interface Writer {
  write(chunk: string | Uint8Array): boolean;
}

export interface RunCliOptions {
  cwd?: string;
  stdinIsTTY?: boolean;
  stdoutIsTTY?: boolean;
  stdout?: Writer;
  stderr?: Writer;
  detectRepoContext?: (cwd: string) => DetectedRepoContext | Promise<DetectedRepoContext>;
  createPrompt?: () => PromptSession;
  providerFetch?: typeof globalThis.fetch;
  eventFetch?: typeof globalThis.fetch;
  runContextFetch?: typeof globalThis.fetch;
  agentRunner?: AgentRunnerHooks;
  writeSetupFiles?: (options: {
    homePath?: string;
    repoRoot?: string;
    config: ReturnType<typeof createSetupConfig>;
  }) => Promise<WriteSetupFilesResult>;
}

class CliUsageError extends Error {}

export async function runCli(argv: string[], options: RunCliOptions = {}): Promise<number> {
  const cwd = options.cwd ?? process.cwd();
  const stdinIsTTY = options.stdinIsTTY ?? Boolean(process.stdin.isTTY);
  const stdoutIsTTY = options.stdoutIsTTY ?? Boolean(process.stdout.isTTY);
  const stdout = options.stdout ?? process.stdout;
  const stderr = options.stderr ?? process.stderr;
  const detectRepo = options.detectRepoContext ?? detectRepoContext;
  const writeFiles = options.writeSetupFiles ?? writeSetupFiles;

  try {
    const [command, ...args] = argv;

    if (!command || command === "help" || command === "--help") {
      writeUsage(stdout);
      return command ? 0 : 1;
    }

    if (command === "doctor") {
      return await runDoctor(args, {
        cwd,
        stdout,
        stderr,
      });
    }

    if (command === "server" && args[0] === "start") {
      return await runServerStart({ stdout });
    }

    if (command === "repo") {
      return await runRepoCommand(args, { cwd, stdout, stderr });
    }

    if (command === "config") {
      return await runConfigCommand(args, { cwd, stdout, stderr });
    }

    if (command === "provider") {
      return await runProviderCommand(args, {
        cwd,
        stdinIsTTY,
        stdoutIsTTY,
        stdout,
        stderr,
        createPrompt: options.createPrompt,
        fetch: options.providerFetch,
      });
    }

    if (command === "linear") {
      return await runLinearCommand(args, {
        cwd,
        stdout,
        stderr,
      });
    }

    if (command === "event") {
      return await runEventCommand(args, {
        cwd,
        stdout,
        stderr,
        fetch: options.eventFetch,
      });
    }

    if (command === "run") {
      return await runRunContextCommand(args, {
        cwd,
        stdout,
        stderr,
        fetch: options.runContextFetch,
      });
    }

    if (command === "agent" && args[0] === "create") {
      return await runStandaloneAgentCreate(args.slice(1), {
        cwd,
        stdinIsTTY,
        stdoutIsTTY,
        stdout,
        stderr,
        detectRepo,
        createPrompt: options.createPrompt,
      });
    }

    if (command === "agent" && args[0] === "update") {
      return await runAgentUpdate(args.slice(1), {
        cwd,
        stdinIsTTY,
        stdoutIsTTY,
        stdout,
        stderr,
        detectRepoContext: detectRepo,
        createPrompt: options.createPrompt,
      });
    }

    if (command === "agent" && args[0] === "run") {
      return await runAgentRun(args.slice(1), {
        cwd,
        stdout,
        stderr,
        ...(options.agentRunner ?? {}),
      });
    }

    if (command === "agent" && args[0] === "report") {
      return await runAgentReport(args.slice(1), {
        cwd,
        stdout,
        stderr,
      });
    }

    if (command === "agent" && args[0] === "status") {
      return await runAgentStatus(args.slice(1), {
        cwd,
        stdout,
        stderr,
      });
    }

    if (command === "task" && args[0] === "source" && args[1] === "repair") {
      return await runTaskSourceRepair(args.slice(2), {
        cwd,
        stdout,
        stderr,
      });
    }

    if (command === "task" && args[0] === "resolve-blocker") {
      return await runTaskResolveBlocker(args.slice(1), {
        cwd,
        stdout,
        stderr,
      });
    }

    if (command !== "init") {
      throw new CliUsageError(`Unknown command "${command}".`);
    }

    const flags = parseInitArgs(args);
    if (flags.help) {
      writeUsage(stdout);
      return 0;
    }

    const repo = await Promise.resolve(detectRepo(cwd));
    const interactiveDefault = stdinIsTTY && stdoutIsTTY && !flags.yes && !hasExplicitNonInteractiveFlags(flags);

    if (interactiveDefault || flags.interactive) {
      const prompt = (options.createPrompt ?? (() => createPromptSession()))();
      try {
        const result = await runSetupWizard({
          cwd,
          flags,
          detectedRepo: repo,
          prompt,
          writeLine(line) {
            stdout.write(`${line}\n`);
          },
        });

        if (result.action === "cancelled") {
          stderr.write("Setup cancelled.\n");
          return 1;
        }

        return await finalizeInit({
          action: result.action,
          config: result.config,
          cwd,
          stdinIsTTY,
          stdoutIsTTY,
          stdout,
          stderr,
          prompt,
          createPrompt: options.createPrompt,
          providerFetch: options.providerFetch,
          detectRepo,
          writeFiles,
        });
      } finally {
        await prompt.close();
      }
    }

    if (!flags.yes && !hasExplicitNonInteractiveFlags(flags)) {
      const suggestions = [
        `--mode ${flags.mode ?? "server"}`,
        `--repo ${repo.repoPath}`,
      ];

      stderr.write("Non-TTY setup requires explicit flags or --yes.\n");
      stderr.write(`Suggested defaults: ${suggestions.join(" ")}\n`);
      return 1;
    }

    const config = createSetupConfigFromFlags({
      cwd,
      flags,
      detectedRepo: repo,
      interactionMode: flags.printOnly ? "print_only" : "non_interactive",
      acceptedDefaults: flags.yes ? true : acceptedDefaultsFromFlags(flags),
    });

    if (flags.yes) {
      const targetRepo = await Promise.resolve(detectRepo(config.repos[0]?.path ?? repo.repoPath));
      const validation = validateSafeDefaults(config, targetRepo);
      if (!validation.ok) {
        stderr.write("--yes is only allowed for safe local defaults.\n");
        validation.reasons.forEach((reason) => {
          stderr.write(`- ${reason}\n`);
        });
        return 1;
      }
    }

    return await finalizeInit({
      action: flags.printOnly ? "print_only" : "write",
      config,
      cwd,
      stdinIsTTY,
      stdoutIsTTY,
      stdout,
      stderr,
      prompt: null,
      createPrompt: options.createPrompt,
      providerFetch: options.providerFetch,
      detectRepo,
      writeFiles,
    });
  } catch (error) {
    if (error instanceof PromptCancelledError) {
      return 1;
    }

    const message = error instanceof Error ? error.message : String(error);
    stderr.write(`${message}\n`);
    return 1;
  }
}

async function runStandaloneAgentCreate(argv: string[], {
  cwd,
  stdinIsTTY,
  stdoutIsTTY,
  stdout,
  stderr,
  detectRepo,
  createPrompt,
}: {
  cwd: string;
  stdinIsTTY: boolean;
  stdoutIsTTY: boolean;
  stdout: Writer;
  stderr: Writer;
  detectRepo: (cwd: string) => DetectedRepoContext | Promise<DetectedRepoContext>;
  createPrompt?: () => PromptSession;
}): Promise<number> {
  const flags = parseAgentCreateArgs(argv);
  const runDirect = () => runAgentCreate(argv, {
      cwd,
      stdinIsTTY,
      stdoutIsTTY,
      stdout,
      stderr,
      detectRepoContext: detectRepo,
      createPrompt,
    });

  if (flags.help || flags.configPath) {
    return await runDirect();
  }

  if (flags.baseUrl && flags.setupApiKey) {
    return await runDirect();
  }

  const homePath = resolveAgentRailHome({ cwd, explicitHome: null });
  const setupConfig = await readSetupConfigFromHome(homePath);
  if (!isTemporaryLocalAgentCreateConfig(setupConfig)) {
    return await runDirect();
  }

  if (flags.baseUrl && !sameServerBaseUrl(flags.baseUrl, setupConfig.server.baseUrl)) {
    return await runDirect();
  }

  const operatorBootstrap = await ensureLocalOperatorBootstrap({
    homePath,
    config: setupConfig,
  });
  if (!operatorBootstrap && !flags.setupApiKey) {
    return await runDirect();
  }

  const setupApiKey = flags.setupApiKey ?? operatorBootstrap?.operatorKey;
  if (!setupApiKey) {
    return await runDirect();
  }

  return await withTemporaryLocalServer({
    homePath,
    config: setupConfig,
    validateExistingBaseUrl: (baseUrl) => validateProvisioningServer(baseUrl, setupApiKey),
    handler: async ({ baseUrl }) => runAgentCreate([
      ...argv,
      "--setup-api-key",
      setupApiKey,
      "--base-url",
      baseUrl,
    ], {
      cwd,
      stdinIsTTY,
      stdoutIsTTY,
      stdout,
      stderr,
      detectRepoContext: detectRepo,
      createPrompt,
      agentEnvBaseUrl: setupConfig.server.baseUrl,
    }),
  });
}

function isTemporaryLocalAgentCreateConfig(config: unknown): config is SetupConfig {
  if (!config || typeof config !== "object") {
    return false;
  }
  const candidate = config as Partial<SetupConfig>;
  return candidate.persistence?.kind === "file"
    && typeof candidate.server?.baseUrl === "string"
    && candidate.server.baseUrl.length > 0;
}

function sameServerBaseUrl(left: string, right: string): boolean {
  const normalizedLeft = normalizeComparableBaseUrl(left);
  const normalizedRight = normalizeComparableBaseUrl(right);
  return normalizedLeft !== null && normalizedLeft === normalizedRight;
}

function normalizeComparableBaseUrl(value: string): string | null {
  const trimmed = value.trim();
  const candidate = /^https?:\/\//iu.test(trimmed) ? trimmed : `http://${trimmed}`;
  try {
    return new URL(candidate).toString().replace(/\/+$/u, "");
  } catch {
    return null;
  }
}

async function finalizeInit({
  action,
  config,
  cwd,
  stdinIsTTY,
  stdoutIsTTY,
  stdout,
  stderr,
  prompt,
  createPrompt,
  providerFetch,
  detectRepo,
  writeFiles,
}: {
  action: "write" | "print_only";
  config: ReturnType<typeof createSetupConfig>;
  cwd: string;
  stdinIsTTY: boolean;
  stdoutIsTTY: boolean;
  stdout: Writer;
  stderr: Writer;
  prompt: PromptSession | null;
  createPrompt?: () => PromptSession;
  providerFetch?: typeof globalThis.fetch;
  detectRepo: (cwd: string) => DetectedRepoContext | Promise<DetectedRepoContext>;
  writeFiles: (options: {
    homePath?: string;
    repoRoot?: string;
    config: ReturnType<typeof createSetupConfig>;
  }) => Promise<WriteSetupFilesResult>;
}): Promise<number> {
  if (action === "print_only") {
    stdout.write(`Equivalent command:\n${buildInitCommand(config)}\n`);
    stdout.write("No files were written.\n");
    return 0;
  }

  await writeFiles({
    homePath: resolveAgentRailHome({ cwd, explicitHome: null }),
    config,
  });

  const homePath = resolveAgentRailHome({ cwd, explicitHome: null });

  const operatorBootstrap = await ensureLocalOperatorBootstrap({
    homePath,
    config,
  });

  if (operatorBootstrap) {
    const operatorEnvLabel = operatorBootstrap.operatorEnvPath;
    if (prompt) {
      await prompt.message(`Wrote ${operatorEnvLabel}`);
    } else {
      stdout.write(`Wrote ${operatorEnvLabel}\n`);
    }
  }

  if (prompt && operatorBootstrap && !await hasExistingLocalAgents({ homePath, config })) {
    const shouldCreateFirstAgent = await prompt.confirm({
      message: "No local agents found. Create your first agent now?",
      defaultValue: true,
    });
    if (shouldCreateFirstAgent) {
      const primaryRepo = primaryRepoFromConfig(config);
      const firstAgentExitCode = await withTemporaryLocalServer({
        homePath,
        config,
        validateExistingBaseUrl: (baseUrl) => validateProvisioningServer(baseUrl, operatorBootstrap.operatorKey),
        handler: async ({ baseUrl }) => runAgentCreate([
          "--setup-api-key",
          operatorBootstrap.operatorKey,
          "--base-url",
          baseUrl,
          "--set-default-env",
        ], {
          cwd: primaryRepo?.path ?? cwd,
          stdinIsTTY,
          stdoutIsTTY,
          stdout,
          stderr,
          detectRepoContext: detectRepo,
          createPrompt: prompt ? () => prompt : createPrompt,
          bootstrapSummaryMode: true,
          agentEnvBaseUrl: config.server.baseUrl,
        }),
      });
      if (firstAgentExitCode !== 0) {
        return firstAgentExitCode;
      }
    }
  }

  if (prompt) {
    const shouldConnectGitHub = await prompt.confirm({
      message: "Connect GitHub now?",
      defaultValue: false,
    });
    if (shouldConnectGitHub) {
      const providerExitCode = await runProviderCommand(["connect", "github"], {
        cwd,
        stdinIsTTY,
        stdoutIsTTY,
        stdout,
        stderr,
        createPrompt: prompt ? () => prompt : createPrompt,
        fetch: providerFetch,
      });
      if (providerExitCode !== 0) {
        return providerExitCode;
      }
    }

    await prompt.note({
      title: "More provider commands",
      body: [
        "Use `agentrail provider list` to review configured provider status.",
        "Use `agentrail provider connect github` to reconnect GitHub and choose polling or webhook delivery later.",
        "Use `agentrail provider connect circleci` to connect CircleCI and choose polling or webhook delivery later.",
        "Use `agentrail provider connect linear` to connect Linear and choose polling or webhook delivery later.",
        "Use `agentrail linear import ENG-123` to import a Linear issue locally after connecting.",
      ].join("\n"),
    });
  }

  return 0;
}

async function validateProvisioningServer(baseUrl: string, operatorKey: string): Promise<boolean> {
  try {
    const response = await fetch(new URL("operator/routing/agent-profiles/agt_operator", `${baseUrl.replace(/\/+$/, "")}/`), {
      headers: {
        accept: "application/json",
        authorization: `Bearer ${operatorKey}`,
      },
    });
    return response.status === 200 || response.status === 404;
  } catch {
    return false;
  }
}

function hasExplicitNonInteractiveFlags(flags: InitFlags): boolean {
  return Boolean(flags.mode && flags.repo);
}

function parseInitArgs(argv: string[]): InitFlags {
  const flags: InitFlags = {
    printOnly: false,
    yes: false,
    interactive: false,
  };

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];

    switch (arg) {
      case "--help":
        flags.help = true;
        break;
      case "--interactive":
        flags.interactive = true;
        break;
      case "--yes":
        flags.yes = true;
        break;
      case "--print-only":
        flags.printOnly = true;
        break;
      case "--markdown-export":
        flags.markdownExport = true;
        break;
      case "--no-markdown-export":
        flags.markdownExport = false;
        break;
      case "--mode":
        flags.mode = readEnum(nextValue(argv, ++index, arg), ["server"], arg);
        break;
      case "--host":
        flags.host = nextValue(argv, ++index, arg);
        break;
      case "--port":
        flags.port = Number.parseInt(nextValue(argv, ++index, arg), 10);
        if (!Number.isInteger(flags.port) || flags.port <= 0) {
          throw new CliUsageError("`--port` must be a positive integer.");
        }
        break;
      case "--base-url":
        flags.baseUrl = nextValue(argv, ++index, arg);
        break;
      case "--persistence":
        flags.persistence = readEnum(nextValue(argv, ++index, arg), ["file", "memory"], arg);
        break;
      case "--provider-mode":
        flags.providerMode = readEnum(nextValue(argv, ++index, arg), ["real", "disabled"], arg);
        break;
      case "--routing-mode":
        {
          const rawValue = nextValue(argv, ++index, arg).replace(/-/gu, "_");
          flags.routingMode = readEnum(rawValue, ["rules_only", "ai_assist"], arg);
        }
        break;
      case "--routing-classifier-runner":
        flags.routingClassifierRunner = nextValue(argv, ++index, arg);
        break;
      case "--routing-classifier-model":
        flags.routingClassifierModel = nextValue(argv, ++index, arg);
        break;
      case "--routing-confidence-threshold":
        {
          const rawValue = nextValue(argv, ++index, arg);
          const parsedValue = Number.parseFloat(rawValue);
          if (!Number.isFinite(parsedValue) || parsedValue < 0 || parsedValue > 1) {
            throw new CliUsageError("`--routing-confidence-threshold` must be a number between 0 and 1.");
          }
          flags.routingConfidenceThreshold = parsedValue;
        }
        break;
      case "--routing-no-suitable-agent":
      case "--routing-fallback":
        {
          const rawValue = nextValue(argv, ++index, arg).replace(/-/gu, "_");
          const allowed = ["require_suitable_agent", "assign_closest_match", "triage", "clarification"];
          if (!allowed.includes(rawValue)) {
            throw new CliUsageError(`${arg} must be one of: require-suitable-agent, assign-closest-match.`);
          }
          flags.routingFallbackBehavior = normalizeRoutingFallbackBehavior(rawValue);
        }
        break;
      case "--repo":
        flags.repo = nextValue(argv, ++index, arg);
        break;
      case "--repo-allowlist":
        flags.repoAllowlist = nextValue(argv, ++index, arg)
          .split(",")
          .map((value) => value.trim())
          .filter(Boolean);
        break;
      case "--default-branch":
        flags.defaultBranch = nextValue(argv, ++index, arg);
        break;
      default:
        throw new CliUsageError(`Unknown flag "${arg}".`);
    }
  }

  return flags;
}

function nextValue(argv: string[], index: number, flag: string): string {
  const value = argv[index];
  if (!value || value.startsWith("--")) {
    throw new CliUsageError(`${flag} requires a value.`);
  }
  return value;
}

function readEnum<T extends string>(value: string, allowed: readonly T[], flag: string): T {
  if ((allowed as readonly string[]).includes(value)) {
    return value as T;
  }

  throw new CliUsageError(`${flag} must be one of: ${allowed.join(", ")}.`);
}

function writeUsage(output: Writer) {
  output.write([
    "Usage:",
    "  agentrail init [flags]",
    "  agentrail doctor [flags]",
    "  agentrail server start",
    "  agentrail repo add [flags]",
    "  agentrail repo list",
    "  agentrail repo remove --repo <owner/repo>",
    "  agentrail config show",
    "  agentrail config set --base-url <url> [--provider-mode <mode>] [--markdown-export|--no-markdown-export]",
    "  agentrail provider connect <github|circleci|linear>",
    "  agentrail provider list",
    "  agentrail provider test <github|circleci|linear>",
    "  agentrail linear import <issue-id|issue-url|issue-uuid>",
    "  agentrail event subscribe --url <url> --event-types <csv> [flags]",
    "  agentrail event subscriptions [flags]",
    "  agentrail event unsubscribe --subscription-id <evsub_...> [flags]",
    "  agentrail run current [--json]",
    "  agentrail run actions [--json]",
    "  agentrail agent create [flags]",
    "  agentrail agent update [flags]",
    "  agentrail agent run [--once] [--agent-id <id>] [--max-runs <n>]",
    "  agentrail agent report --status <progress|blocked|completed> --summary <text>",
    "  agentrail agent status [--agent-id <id>] [--json]",
    "  agentrail task source repair --task-id <tsk_...> --file <json> [flags]",
    "  agentrail task resolve-blocker --task-id <tsk_...> --resolution-summary <text> [flags]",
    "",
    "Flags:",
    "  --mode server",
    "  --repo <path>",
    "  --print-only",
    "  --yes",
    "  --markdown-export",
    "  --event-types <csv>",
    "  --subscription-id <evsub_...>",
    "  --base-url <url>",
    "  --api-key <key>",
    "  --agent-id <id>",
    "  --repo <owner/repo>",
    "  --setup-api-key <key>",
    "  --task-id <tsk_...>",
    "  --file <json>",
    "  --resolution-summary <text>",
    "  --json",
  ].join("\n"));
  output.write("\n");
}

if (process.argv[1] && import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href) {
  const exitCode = await runCli(process.argv.slice(2));
  process.exitCode = exitCode;
}
