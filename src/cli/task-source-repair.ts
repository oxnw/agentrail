import crypto from "node:crypto";
import { readFile } from "node:fs/promises";
import path from "node:path";

import { operatorEnvPathForHome, readSetupConfigFromHome, resolveAgentRailHome } from "./agentrail-home.ts";

interface Writer {
  write(chunk: string | Uint8Array): boolean;
}

export interface TaskSourceRepairFlags {
  help?: boolean;
  taskId?: string;
  file?: string;
  baseUrl?: string;
  setupApiKey?: string;
  configPath?: string;
}

export interface RunTaskSourceRepairOptions {
  cwd: string;
  stdout: Writer;
  stderr: Writer;
}

interface SetupConfigLike {
  server?: {
    baseUrl?: string;
  };
}

export function parseTaskSourceRepairArgs(argv: string[]): TaskSourceRepairFlags {
  const flags: TaskSourceRepairFlags = {};

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    switch (arg) {
      case "--help":
        flags.help = true;
        break;
      case "--task-id":
        flags.taskId = nextValue(argv, ++index, arg);
        break;
      case "--file":
        flags.file = nextValue(argv, ++index, arg);
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
      default:
        throw new Error(`Unknown flag "${arg}".`);
    }
  }

  return flags;
}

export async function runTaskSourceRepair(
  argv: string[],
  { cwd, stdout, stderr }: RunTaskSourceRepairOptions,
): Promise<number> {
  const flags = parseTaskSourceRepairArgs(argv);
  if (flags.help) {
    stdout.write(
      [
        "Usage:",
        "  agentrail task source repair --task-id <tsk_...> --file <json> [--base-url <url>] [--setup-api-key <key>]",
        "",
      ].join("\n"),
    );
    return 0;
  }

  if (!flags.taskId || !flags.file) {
    stderr.write("agentrail task source repair requires --task-id and --file.\n");
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
    stderr.write("agentrail task source repair requires AGENTRAIL_BASE_URL or --base-url.\n");
    return 1;
  }
  if (!setupApiKey) {
    stderr.write("agentrail task source repair requires AGENTRAIL_SETUP_API_KEY or --setup-api-key.\n");
    return 1;
  }

  let payloadText: string;
  try {
    payloadText = await readFile(path.resolve(cwd, flags.file), "utf8");
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    stderr.write(`Failed to read task source repair file: ${message}\n`);
    return 1;
  }

  let payload: unknown;
  try {
    payload = JSON.parse(payloadText);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    stderr.write(`Task source repair file must contain valid JSON: ${message}\n`);
    return 1;
  }

  const hash = crypto.createHash("sha256").update(payloadText).digest("hex").slice(0, 20);
  const idempotencyKey = `task-source-repair:${flags.taskId}:${hash}`;

  const response = await fetch(
    new URL(`/operator/tasks/${flags.taskId}/source`, `${baseUrl.replace(/\/+$/, "")}/`),
    {
      method: "PATCH",
      headers: {
        authorization: `Bearer ${setupApiKey}`,
        "content-type": "application/json",
        "idempotency-key": idempotencyKey,
      },
      body: JSON.stringify(payload),
    },
  );

  const text = await response.text();
  let json: any = null;
  try {
    json = text ? JSON.parse(text) : null;
  } catch {
    // handled below
  }

  if (!response.ok) {
    const message = json?.error?.message ?? text ?? `HTTP ${response.status}`;
    stderr.write(`${message}\n`);
    return 1;
  }

  stdout.write(
    [
      `Updated task source for ${flags.taskId}.`,
      `Provider: ${json?.data?.source?.provider ?? "unknown"}`,
      `Version: ${json?.data?.version ?? "unknown"}`,
      "",
    ].join("\n"),
  );
  return 0;
}

async function readOperatorKey(homePath: string): Promise<string | null> {
  try {
    const content = await readFile(operatorEnvPathForHome(homePath), "utf8");
    const match = content.match(/^AGENTRAIL_OPERATOR_KEY=(.+)$/m);
    return match?.[1]?.trim() ?? null;
  } catch {
    return null;
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

function nextValue(argv: string[], index: number, flag: string): string {
  const value = argv[index];
  if (!value || value.startsWith("--")) {
    throw new Error(`${flag} requires a value.`);
  }
  return value;
}
