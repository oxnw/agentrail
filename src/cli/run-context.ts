import { readFile } from "node:fs/promises";

import { isManagedRunContextEnvelope, type ManagedRunContextEnvelope } from "../managed-run-context.ts";

interface Writer {
  write(chunk: string | Uint8Array): boolean;
}

interface RunContextEnv {
  AGENTRAIL_BASE_URL?: string;
  AGENTRAIL_RUN_ID?: string;
  AGENTRAIL_RUN_CONTEXT_PATH?: string;
  AGENTRAIL_RUN_CONTEXT_TOKEN?: string;
}

interface RunContextFlags {
  help?: boolean;
  json?: boolean;
}

export interface RunContextOptions {
  cwd: string;
  stdout: Writer;
  stderr: Writer;
  fetch?: typeof globalThis.fetch;
  env?: RunContextEnv;
}

class RunContextHttpError extends Error {
  readonly status: number;

  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

export async function runRunContextCommand(argv: string[], options: RunContextOptions): Promise<number> {
  const [subcommand, ...args] = argv;
  if (subcommand === "current") {
    return await runCurrent(args, options);
  }
  if (subcommand === "actions") {
    return await runActions(args, options);
  }
  options.stderr.write(renderRunContextUsage());
  return subcommand === "--help" || subcommand === "help" ? 0 : 1;
}

async function runCurrent(argv: string[], options: RunContextOptions): Promise<number> {
  const flags = parseRunContextFlags(argv);
  if (flags.help) {
    options.stdout.write(renderRunContextUsage());
    return 0;
  }

  const context = await loadManagedRunContext(options, "agentrail run current");
  if (context.ok === false) {
    options.stderr.write(`${context.error}\n`);
    return 1;
  }

  if (flags.json) {
    options.stdout.write(`${JSON.stringify(context.value)}\n`);
    return 0;
  }

  const { run, task, nextActions } = context.value.data;
  options.stdout.write(`Run: ${run.runId}\n`);
  options.stdout.write(`Task: ${task.identifier} ${task.title}\n`);
  options.stdout.write(`Status: ${task.status}\n`);
  options.stdout.write(`Available actions: ${context.value.availableActions.join(", ") || "none"}\n`);
  for (const action of nextActions) {
    options.stdout.write(`Next: ${action.label}\n`);
  }
  return 0;
}

async function runActions(argv: string[], options: RunContextOptions): Promise<number> {
  const flags = parseRunContextFlags(argv);
  if (flags.help) {
    options.stdout.write(renderRunContextUsage());
    return 0;
  }

  const context = await loadManagedRunContext(options, "agentrail run actions");
  if (context.ok === false) {
    options.stderr.write(`${context.error}\n`);
    return 1;
  }

  if (flags.json) {
    options.stdout.write(`${JSON.stringify(context.value)}\n`);
    return 0;
  }

  if (context.value.data.nextActions.length === 0) {
    options.stdout.write("No available actions.\n");
    return 0;
  }
  for (const action of context.value.data.nextActions) {
    options.stdout.write(`${action.id}: ${action.label}\n`);
  }
  return 0;
}

function parseRunContextFlags(argv: string[]): RunContextFlags {
  const flags: RunContextFlags = {};
  for (const arg of argv) {
    if (arg === "--help") {
      flags.help = true;
    } else if (arg === "--json") {
      flags.json = true;
    } else {
      throw new Error(`Unknown flag "${arg}".`);
    }
  }
  return flags;
}

async function loadManagedRunContext(
  options: RunContextOptions,
  commandName: string,
): Promise<{ ok: true; value: ManagedRunContextEnvelope } | { ok: false; error: string }> {
  const env = options.env ?? process.env;
  const runId = env.AGENTRAIL_RUN_ID;
  if (!runId) {
    return { ok: false, error: `${commandName} requires AGENTRAIL_RUN_ID in the managed runner environment.` };
  }

  const hasLiveContext = Boolean(env.AGENTRAIL_BASE_URL && env.AGENTRAIL_RUN_CONTEXT_TOKEN);
  if (hasLiveContext) {
    try {
      const liveContext = await fetchRunContext({
        baseUrl: env.AGENTRAIL_BASE_URL as string,
        runId,
        token: env.AGENTRAIL_RUN_CONTEXT_TOKEN as string,
        fetchImpl: options.fetch ?? globalThis.fetch,
      });
      return { ok: true, value: liveContext };
    } catch (error) {
      if (error instanceof RunContextHttpError || !env.AGENTRAIL_RUN_CONTEXT_PATH) {
        return { ok: false, error: error instanceof Error ? error.message : String(error) };
      }
    }
  }

  if (!env.AGENTRAIL_RUN_CONTEXT_PATH) {
    return {
      ok: false,
      error: `${commandName} requires managed run context in AGENTRAIL_RUN_CONTEXT_PATH or AGENTRAIL_RUN_CONTEXT_TOKEN.`,
    };
  }

  try {
    const parsed = JSON.parse(await readFile(env.AGENTRAIL_RUN_CONTEXT_PATH, "utf8")) as unknown;
    if (!isManagedRunContextEnvelope(parsed)) {
      return { ok: false, error: `Run context file is not a valid AgentRail run context: ${env.AGENTRAIL_RUN_CONTEXT_PATH}` };
    }
    if (parsed.data.run.runId !== runId) {
      return { ok: false, error: "Run context file does not match AGENTRAIL_RUN_ID." };
    }
    return { ok: true, value: parsed };
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) };
  }
}

async function fetchRunContext({
  baseUrl,
  runId,
  token,
  fetchImpl,
}: {
  baseUrl: string;
  runId: string;
  token: string;
  fetchImpl: typeof globalThis.fetch;
}): Promise<ManagedRunContextEnvelope> {
  const response = await fetchImpl(new URL(`/agent-runs/${encodeURIComponent(runId)}/context`, `${normalizeBaseUrl(baseUrl)}/`), {
    headers: {
      accept: "application/json",
      authorization: `Bearer ${token}`,
    },
  });
  const text = await response.text();
  const parsed = text.length > 0 ? JSON.parse(text) as unknown : null;
  if (!response.ok) {
    const message = isRecord(parsed) && isRecord(parsed.error) && typeof parsed.error.message === "string"
      ? parsed.error.message
      : `Run context request failed with HTTP ${response.status}.`;
    throw new RunContextHttpError(response.status, message);
  }
  if (!isManagedRunContextEnvelope(parsed)) {
    throw new Error("Run context response was not a valid AgentRail run context.");
  }
  if (parsed.data.run.runId !== runId) {
    throw new Error("Run context response did not match AGENTRAIL_RUN_ID.");
  }
  return parsed;
}

function normalizeBaseUrl(value: string): string {
  const trimmed = value.trim();
  const hasScheme = /^https?:\/\//iu.test(trimmed);
  return (hasScheme ? trimmed : `http://${trimmed}`).replace(/\/+$/u, "");
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function renderRunContextUsage(): string {
  return [
    "Usage:",
    "  agentrail run current [--json]",
    "  agentrail run actions [--json]",
    "",
  ].join("\n");
}
