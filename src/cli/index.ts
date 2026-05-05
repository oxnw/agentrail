#!/usr/bin/env node

import path from "node:path";
import { pathToFileURL } from "node:url";

import { createPromptSession, PromptCancelledError, type PromptSession } from "./prompt.ts";
import { detectRepoContext } from "./repo-detection.ts";
import { buildInitCommand, createSetupConfig, validateSafeDefaults, type DetectedRepoContext } from "./setup-config.ts";
import { writeSetupFiles, type WriteSetupFilesResult } from "./setup-files.ts";
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
  writeSetupFiles?: (options: {
    repoRoot: string;
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
          stdout,
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
      const validation = validateSafeDefaults(config, repo);
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
      stdout,
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

async function finalizeInit({
  action,
  config,
  stdout,
  writeFiles,
}: {
  action: "write" | "print_only";
  config: ReturnType<typeof createSetupConfig>;
  stdout: Writer;
  writeFiles: (options: {
    repoRoot: string;
    config: ReturnType<typeof createSetupConfig>;
  }) => Promise<WriteSetupFilesResult>;
}): Promise<number> {
  if (action === "print_only") {
    stdout.write(`Equivalent command:\n${buildInitCommand(config)}\n`);
    stdout.write("No files were written.\n");
    return 0;
  }

  const result = await writeFiles({
    repoRoot: config.targetRepo.path,
    config,
  });
  const envPath = path.join(config.targetRepo.path, ".agentrail", "agent.env");
  const envExamplePath = path.join(config.targetRepo.path, ".agentrail", "agent.env.example");

  stdout.write(`Wrote setup files:\n${result.writtenPaths.map((filePath) => `- ${filePath}`).join("\n")}\n`);
  stdout.write([
    "Next steps:",
    `- Add your provider tokens to ${envPath} when you wire live providers.`,
    `- Use ${envExamplePath} as the template.`,
    "- Happy hacking!",
    "",
  ].join("\n"));
  return 0;
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
    "",
    "Flags:",
    "  --mode server",
    "  --repo <path>",
    "  --print-only",
    "  --yes",
    "  --markdown-export",
  ].join("\n"));
  output.write("\n");
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const exitCode = await runCli(process.argv.slice(2));
  process.exitCode = exitCode;
}
