import { createHash, randomBytes } from "node:crypto";
import { readFile } from "node:fs/promises";
import path from "node:path";

import { AGENTRAIL_EVENT_TYPES, type AgentRailEventType } from "../event-subscription-store.ts";
import { operatorEnvPathForHome, readSetupConfigFromHome, resolveAgentRailHome } from "./agentrail-home.ts";

interface Writer {
  write(chunk: string | Uint8Array): boolean;
}

export interface RunEventCommandOptions {
  cwd: string;
  stdout: Writer;
  stderr: Writer;
  fetch?: typeof globalThis.fetch;
}

interface EventCommandFlags {
  help?: boolean;
  url?: string;
  eventTypes?: string[];
  secret?: string;
  description?: string;
  taskIds: string[];
  subscriptionId?: string;
  baseUrl?: string;
  setupApiKey?: string;
  configPath?: string;
  json?: boolean;
}

interface SetupConfigLike {
  server?: {
    baseUrl?: string;
  };
}

export async function runEventCommand(
  argv: string[],
  { cwd, stdout, stderr, fetch: fetchImpl = globalThis.fetch }: RunEventCommandOptions,
): Promise<number> {
  const [subcommand, ...args] = argv;

  if (!subcommand || subcommand === "--help" || subcommand === "help") {
    writeEventUsage(stdout);
    return subcommand ? 0 : 1;
  }

  let flags: EventCommandFlags;
  try {
    flags = parseEventCommandArgs(args);
  } catch (error) {
    stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    writeEventUsage(stdout);
    return 1;
  }
  if (flags.help) {
    writeEventUsage(stdout);
    return 0;
  }

  switch (subcommand) {
    case "subscribe":
      return await runEventSubscribe(flags, { cwd, stdout, stderr, fetch: fetchImpl });
    case "subscriptions":
      return await runEventSubscriptions(flags, { cwd, stdout, stderr, fetch: fetchImpl });
    case "unsubscribe":
      return await runEventUnsubscribe(flags, { cwd, stdout, stderr, fetch: fetchImpl });
    default:
      stderr.write(`Unknown event command "${subcommand}".\n`);
      return 1;
  }
}

function parseEventCommandArgs(argv: string[]): EventCommandFlags {
  const flags: EventCommandFlags = { taskIds: [] };

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    switch (arg) {
      case "--help":
        flags.help = true;
        break;
      case "--url":
        flags.url = nextValue(argv, ++index, arg);
        break;
      case "--event-types":
        flags.eventTypes = nextValue(argv, ++index, arg)
          .split(",")
          .map((value) => value.trim())
          .filter(Boolean);
        break;
      case "--secret":
        flags.secret = nextValue(argv, ++index, arg);
        break;
      case "--description":
        flags.description = nextValue(argv, ++index, arg);
        break;
      case "--task-id":
        flags.taskIds.push(nextValue(argv, ++index, arg));
        break;
      case "--subscription-id":
        flags.subscriptionId = nextValue(argv, ++index, arg);
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

async function runEventSubscribe(
  flags: EventCommandFlags,
  options: RunEventCommandOptions,
): Promise<number> {
  if (!flags.url || !flags.eventTypes?.length) {
    options.stderr.write("agentrail event subscribe requires --url and --event-types.\n");
    return 1;
  }

  const unsupportedEventType = flags.eventTypes.find((eventType) => !isAgentRailEventType(eventType));
  if (unsupportedEventType) {
    options.stderr.write(`Unsupported event type "${unsupportedEventType}". Supported: ${AGENTRAIL_EVENT_TYPES.join(", ")}.\n`);
    return 1;
  }

  const connection = await resolveEventApiConnection(flags, options.cwd);
  if (connection.ok === false) {
    options.stderr.write(`${connection.message}\n`);
    return 1;
  }

  const generatedSecret = flags.secret ? null : generateSigningSecret();
  const secret = flags.secret ?? generatedSecret;
  const body = {
    url: flags.url,
    eventTypes: flags.eventTypes as AgentRailEventType[],
    secret,
    ...(flags.description ? { description: flags.description } : {}),
    ...(flags.taskIds.length > 0 ? { filters: { taskIds: flags.taskIds } } : {}),
  };

  const idempotencyKey = createIdempotencyKey("event-subscribe", body);
  const response = await requestJson({
    method: "POST",
    route: "event-subscriptions",
    body,
    idempotencyKey,
    ...connection,
    fetch: options.fetch ?? globalThis.fetch,
  });

  if (response.ok === false) {
    options.stderr.write(`${response.errorMessage}\n`);
    return 1;
  }

  if (flags.json) {
    const outputBody = isRecord(response.body)
      ? { ...response.body, ...(generatedSecret ? { generatedSecret } : {}) }
      : { data: response.body, ...(generatedSecret ? { generatedSecret } : {}) };
    options.stdout.write(`${JSON.stringify(outputBody, null, 2)}\n`);
    return 0;
  }

  options.stdout.write([
    `Created event subscription ${readDataId(response.body) ?? "unknown"}.`,
    `Events: ${(flags.eventTypes as string[]).join(", ")}`,
    generatedSecret
      ? `Signing secret: ${generatedSecret}`
      : "Signing secret: provided",
    "",
  ].join("\n"));
  return 0;
}

async function runEventSubscriptions(
  flags: EventCommandFlags,
  options: RunEventCommandOptions,
): Promise<number> {
  const connection = await resolveEventApiConnection(flags, options.cwd);
  if (connection.ok === false) {
    options.stderr.write(`${connection.message}\n`);
    return 1;
  }

  const response = await requestJson({
    method: "GET",
    route: "event-subscriptions",
    ...connection,
    fetch: options.fetch ?? globalThis.fetch,
  });

  if (response.ok === false) {
    options.stderr.write(`${response.errorMessage}\n`);
    return 1;
  }

  if (flags.json) {
    options.stdout.write(`${JSON.stringify(response.body, null, 2)}\n`);
    return 0;
  }

  const subscriptions = readDataArray(response.body);
  if (subscriptions.length === 0) {
    options.stdout.write("No event subscriptions configured.\n");
    return 0;
  }

  for (const subscription of subscriptions) {
    options.stdout.write(`${subscription.id}\t${subscription.status}\t${subscription.eventTypes.join(",")}\t${subscription.url}\n`);
  }
  return 0;
}

async function runEventUnsubscribe(
  flags: EventCommandFlags,
  options: RunEventCommandOptions,
): Promise<number> {
  if (!flags.subscriptionId) {
    options.stderr.write("agentrail event unsubscribe requires --subscription-id.\n");
    return 1;
  }

  const connection = await resolveEventApiConnection(flags, options.cwd);
  if (connection.ok === false) {
    options.stderr.write(`${connection.message}\n`);
    return 1;
  }

  const response = await requestJson({
    method: "DELETE",
    route: `event-subscriptions/${encodeURIComponent(flags.subscriptionId)}`,
    ...connection,
    fetch: options.fetch ?? globalThis.fetch,
  });

  if (response.ok === false) {
    options.stderr.write(`${response.errorMessage}\n`);
    return 1;
  }

  if (flags.json) {
    options.stdout.write(`${JSON.stringify(response.body, null, 2)}\n`);
    return 0;
  }

  options.stdout.write(`Deactivated event subscription ${flags.subscriptionId}.\n`);
  return 0;
}

async function resolveEventApiConnection(
  flags: EventCommandFlags,
  cwd: string,
): Promise<
  | { ok: true; baseUrl: string; setupApiKey: string }
  | { ok: false; message: string }
> {
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
    return { ok: false, message: "agentrail event requires AGENTRAIL_BASE_URL or --base-url." };
  }
  if (!setupApiKey) {
    return { ok: false, message: "agentrail event requires AGENTRAIL_SETUP_API_KEY or --setup-api-key." };
  }
  return { ok: true, baseUrl, setupApiKey };
}

async function requestJson({
  method,
  route,
  baseUrl,
  setupApiKey,
  fetch: fetchImpl,
  body,
  idempotencyKey,
}: {
  method: "GET" | "POST" | "DELETE";
  route: string;
  baseUrl: string;
  setupApiKey: string;
  fetch: typeof globalThis.fetch;
  body?: unknown;
  idempotencyKey?: string;
}): Promise<
  | { ok: true; body: unknown }
  | { ok: false; errorMessage: string; body: unknown }
> {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), 30_000);
  let response: Response;
  try {
    response = await fetchImpl(new URL(route, `${baseUrl.replace(/\/+$/u, "")}/`), {
      method,
      headers: {
        authorization: `Bearer ${setupApiKey}`,
        accept: "application/json",
        ...(body !== undefined ? { "content-type": "application/json" } : {}),
        ...(idempotencyKey ? { "idempotency-key": idempotencyKey } : {}),
      },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
      signal: controller.signal,
    });
  } catch (error) {
    const isAbortError = error instanceof Error && error.name === "AbortError";
    return {
      ok: false,
      errorMessage: isAbortError ? "Request timed out." : error instanceof Error ? error.message : String(error),
      body: null,
    };
  } finally {
    clearTimeout(timeoutId);
  }

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
    return { ok: false, errorMessage: message, body: json };
  }

  return { ok: true, body: json };
}

function createIdempotencyKey(prefix: string, body: unknown): string {
  const digest = createHash("sha256")
    .update(stableStringify(body))
    .digest("hex")
    .slice(0, 32);
  return `${prefix}:${digest}`;
}

function stableStringify(value: unknown): string {
  if (value === undefined) return "null";
  if (Array.isArray(value)) return `[${value.map((item) => stableStringify(item)).join(",")}]`;
  if (value && typeof value === "object") {
    const record = value as Record<string, unknown>;
    const entries = Object.keys(record)
      .sort()
      .filter((key) => record[key] !== undefined)
      .map((key) => `${JSON.stringify(key)}:${stableStringify(record[key])}`);
    return `{${entries.join(",")}}`;
  }
  return JSON.stringify(value) ?? "null";
}

function generateSigningSecret(): string {
  return `evsec_${randomBytes(32).toString("base64url")}`;
}

function isAgentRailEventType(value: string): value is AgentRailEventType {
  return (AGENTRAIL_EVENT_TYPES as readonly string[]).includes(value);
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

function readDataId(value: unknown): string | null {
  if (!isRecord(value) || !isRecord(value.data) || typeof value.data.id !== "string") {
    return null;
  }
  return value.data.id;
}

function readDataArray(value: unknown): Array<{ id: string; url: string; status: string; eventTypes: string[] }> {
  if (!isRecord(value) || !Array.isArray(value.data)) {
    return [];
  }
  return value.data.filter((entry): entry is { id: string; url: string; status: string; eventTypes: string[] } => (
    isRecord(entry)
    && typeof entry.id === "string"
    && typeof entry.url === "string"
    && typeof entry.status === "string"
    && Array.isArray(entry.eventTypes)
    && entry.eventTypes.every((eventType) => typeof eventType === "string")
  ));
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function nextValue(argv: string[], index: number, flag: string): string {
  const value = argv[index];
  if (!value || value.startsWith("--")) {
    throw new Error(`${flag} requires a value.`);
  }
  return value;
}

function writeEventUsage(output: Writer): void {
  output.write([
    "Usage:",
    "  agentrail event subscribe --url <url> --event-types <csv> [--secret <secret>] [--description <text>] [--task-id <tsk_...>] [--base-url <url>] [--setup-api-key <key>] [--json]",
    "  agentrail event subscriptions [--base-url <url>] [--setup-api-key <key>] [--json]",
    "  agentrail event unsubscribe --subscription-id <evsub_...> [--base-url <url>] [--setup-api-key <key>] [--json]",
    "",
    `Supported event types: ${AGENTRAIL_EVENT_TYPES.join(", ")}`,
    "",
  ].join("\n"));
}
