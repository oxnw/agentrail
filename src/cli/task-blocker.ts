import crypto from "node:crypto";
import { readFile } from "node:fs/promises";
import path from "node:path";

import { operatorEnvPathForHome, readSetupConfigFromHome, resolveAgentRailHome } from "./agentrail-home.ts";

interface Writer {
  write(chunk: string | Uint8Array): boolean;
}

export interface TaskResolveBlockerFlags {
  help?: boolean;
  taskId?: string;
  resolutionSummary?: string;
  baseUrl?: string;
  setupApiKey?: string;
  configPath?: string;
  json?: boolean;
}

export interface RunTaskResolveBlockerOptions {
  cwd: string;
  stdout: Writer;
  stderr: Writer;
}

interface SetupConfigLike {
  server?: {
    baseUrl?: string;
  };
}

export function parseTaskResolveBlockerArgs(argv: string[]): TaskResolveBlockerFlags {
  const flags: TaskResolveBlockerFlags = {};

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    switch (arg) {
      case "--help":
        flags.help = true;
        break;
      case "--task-id":
        flags.taskId = nextValue(argv, ++index, arg);
        break;
      case "--resolution-summary":
        flags.resolutionSummary = nextValue(argv, ++index, arg);
        break;
      case "--base-url":
        flags.baseUrl = nextValue(argv, ++index, arg);
        break;
      case "--setup-api-key":
        flags.setupApiKey = nextValue(argv, ++index, arg);
        break;
      case "--config":
        flags.configPath = nextValue(argv, ++index, arg);
        break;
      case "--json":
        flags.json = true;
        break;
      default:
        throw new Error(`Unknown flag "${arg}".`);
    }
  }

  return flags;
}

export async function runTaskResolveBlocker(
  argv: string[],
  { cwd, stdout, stderr }: RunTaskResolveBlockerOptions,
): Promise<number> {
  const flags = parseTaskResolveBlockerArgs(argv);
  if (flags.help) {
    stdout.write(
      [
        "Usage:",
        "  agentrail task resolve-blocker --task-id <tsk_...> --resolution-summary <text> [--base-url <url>] [--setup-api-key <key>] [--config <path>] [--json]",
        "",
      ].join("\n"),
    );
    return 0;
  }

  if (!flags.taskId || !flags.resolutionSummary?.trim()) {
    stderr.write("agentrail task resolve-blocker requires --task-id and --resolution-summary.\n");
    return 1;
  }

  const homePath = resolveAgentRailHome({ cwd, explicitHome: null });
  const config = flags.configPath
    ? await readSetupConfig(path.resolve(cwd, flags.configPath))
    : await readSetupConfigFromHome(homePath);
  const baseUrl = flags.baseUrl ?? process.env.AGENTRAIL_BASE_URL ?? config?.server?.baseUrl;
  const setupApiKey =
    flags.setupApiKey
    ?? await readOperatorKey(homePath)
    ?? process.env.AGENTRAIL_SETUP_API_KEY
    ?? process.env.AGENTRAIL_OPERATOR_API_KEY
    ?? process.env.AGENTRAIL_ADMIN_API_KEY
    ?? null;

  if (!baseUrl) {
    stderr.write("agentrail task resolve-blocker requires AGENTRAIL_BASE_URL or --base-url.\n");
    return 1;
  }
  if (!setupApiKey) {
    stderr.write("agentrail task resolve-blocker requires AGENTRAIL_SETUP_API_KEY or --setup-api-key.\n");
    return 1;
  }

  const resolutionSummary = flags.resolutionSummary.trim();
  const hash = crypto
    .createHash("sha256")
    .update(`${flags.taskId}\n${resolutionSummary}`)
    .digest("hex")
    .slice(0, 20);
  const idempotencyKey = `task-resolve-blocker:${flags.taskId}:${hash}`;

  const response = await fetch(
    new URL(`tasks/${encodeURIComponent(flags.taskId)}/resolve-blocker`, `${baseUrl.replace(/\/+$/u, "")}/`),
    {
      method: "POST",
      headers: {
        authorization: `Bearer ${setupApiKey}`,
        "content-type": "application/json",
        "idempotency-key": idempotencyKey,
      },
      body: JSON.stringify({ resolutionSummary }),
    },
  );

  const text = await response.text();
  let json: unknown = null;
  try {
    json = text ? JSON.parse(text) : null;
  } catch {
    // Non-JSON error bodies are reported verbatim below.
  }

  if (!response.ok) {
    const message = isRecord(json) && isRecord(json.error) && typeof json.error.message === "string"
      ? json.error.message
      : text || `HTTP ${response.status}`;
    stderr.write(`${message}\n`);
    return 1;
  }

  if (flags.json) {
    stdout.write(`${JSON.stringify(json, null, 2)}\n`);
    return 0;
  }

  stdout.write(
    [
      `Resolved blocker for ${flags.taskId}.`,
      `Status: ${readResolvedTaskStatus(json) ?? "unknown"}`,
      "",
    ].join("\n"),
  );
  return 0;
}

async function readOperatorKey(homePath: string): Promise<string | null> {
  try {
    const content = await readFile(operatorEnvPathForHome(homePath), "utf8");
    const match = content.match(/^AGENTRAIL_OPERATOR_KEY=(.+)$/m);
    const rawValue = match?.[1]?.replace(/\s+#.*$/u, "").trim() ?? null;
    if (!rawValue) {
      return null;
    }
    const quoted = rawValue.match(/^(['"])([\s\S]*)\1$/u);
    if (quoted) {
      return quoted[2].length > 0 ? quoted[2] : null;
    }
    return rawValue;
  } catch (error) {
    if (typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT") {
      return null;
    }
    throw error;
  }
}

async function readSetupConfig(configPath: string): Promise<SetupConfigLike | null> {
  try {
    const content = await readFile(configPath, "utf8");
    const parsed = JSON.parse(content) as unknown;
    return parsed && typeof parsed === "object" ? (parsed as SetupConfigLike) : null;
  } catch {
    return null;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function readResolvedTaskStatus(value: unknown): string | null {
  if (!isRecord(value) || !isRecord(value.data) || typeof value.data.status !== "string") {
    return null;
  }
  return value.data.status;
}

function nextValue(argv: string[], index: number, flag: string): string {
  const value = argv[index];
  if (!value || value.startsWith("--")) {
    throw new Error(`${flag} requires a value.`);
  }
  return value;
}
