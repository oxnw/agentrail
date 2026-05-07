import { readFile } from "node:fs/promises";
import path from "node:path";

import {
  configPathForHome,
  currentAgentEnvPathForHome,
  operatorEnvPathForHome,
  primaryRepoFromConfig,
  readSetupConfigFromHome,
  resolveAgentRailHome,
} from "./agentrail-home.ts";

interface Writer {
  write(chunk: string | Uint8Array): boolean;
}

export interface DoctorFlags {
  help?: boolean;
  baseUrl?: string;
  apiKey?: string;
  agentId?: string;
  repo?: string;
  setupApiKey?: string;
  configPath?: string;
  envFile?: string;
  skipRoutingCheck?: boolean;
}

export interface RunDoctorOptions {
  cwd: string;
  stdout: Writer;
  stderr: Writer;
  silent?: boolean;
}

interface SetupConfigLike {
  server?: {
    baseUrl?: string;
  };
  repos?: Array<{
    path: string;
    slug: string;
    defaultBranch: string;
  }>;
}

interface DoctorCheck {
  id: "health" | "auth" | "profile" | "routing" | "assigned_task_visibility";
  ok: boolean;
  summary: string;
}

interface DoctorInputs {
  baseUrl: string;
  apiKey: string;
  agentId: string;
  expectedRepo: string | null;
  setupApiKey: string | null;
}

interface JsonResponse<T = unknown> {
  status: number;
  json: T | null;
}

interface AgentProfileResponse {
  data?: {
    status?: string;
    repoAllowlist?: string[];
  };
}

interface RuleSetResponse {
  data?: {
    rules?: Array<{
      enabled?: boolean;
      target?: {
        type?: string;
        id?: string;
      };
      conditions?: {
        repositories?: string[];
      };
    }>;
  };
}

interface TaskListResponse {
  data?: Array<{
    id?: string;
    identifier?: string;
  }>;
  page?: {
    nextCursor?: string | null;
  };
}

interface TaskDetailResponse {
  data?: {
    identifier?: string;
    assigneeAgentId?: string | null;
    assignee?: {
      id?: string;
    };
  };
}

interface SetupTaskVisibilityResult {
  ok: boolean;
  visibleTaskIdentifier: string | null;
  scannedCount: number;
  listStatus: number;
}

export function parseDoctorArgs(argv: string[]): DoctorFlags {
  const flags: DoctorFlags = {};

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];

    switch (arg) {
      case "--help":
        flags.help = true;
        break;
      case "--base-url":
        flags.baseUrl = nextValue(argv, ++index, arg);
        break;
      case "--api-key":
        flags.apiKey = nextValue(argv, ++index, arg);
        break;
      case "--agent-id":
        flags.agentId = nextValue(argv, ++index, arg);
        break;
      case "--repo":
        flags.repo = nextValue(argv, ++index, arg);
        break;
      case "--setup-api-key":
        flags.setupApiKey = nextValue(argv, ++index, arg);
        break;
      case "--config":
        flags.configPath = nextValue(argv, ++index, arg);
        break;
      case "--env-file":
        flags.envFile = nextValue(argv, ++index, arg);
        break;
      case "--skip-routing-check":
        flags.skipRoutingCheck = true;
        break;
      default:
        throw new Error(`Unknown flag "${arg}".`);
    }
  }

  return flags;
}

export async function runDoctor(
  argv: string[],
  { cwd, stdout, stderr, silent = false }: RunDoctorOptions,
): Promise<number> {
  const flags = parseDoctorArgs(argv);

  if (flags.help) {
    stdout.write(
      [
        "Usage:",
        "  agentrail doctor [--base-url <url>] [--api-key <key>] [--agent-id <id>] [--repo <owner/repo>] [--setup-api-key <key>] [--env-file <path>] [--skip-routing-check]",
        "",
      ].join("\n"),
    );
    return 0;
  }

  const inputs = await resolveDoctorInputs({ cwd, flags });
  if ("error" in inputs) {
    stderr.write(`${inputs.error}\n`);
    return 1;
  }

  const report = await runDoctorChecks(inputs, flags);
  if (!silent) {
    const writer = report.ok ? stdout : stderr;
    writer.write(renderDoctorReport(report));
  }
  return report.ok ? 0 : 1;
}

async function resolveDoctorInputs({
  cwd,
  flags,
}: {
  cwd: string;
  flags: DoctorFlags;
}): Promise<DoctorInputs | { error: string }> {
  const homePath = resolveAgentRailHome({ cwd, explicitHome: null });
  const config = flags.configPath
    ? await readSetupConfig(path.resolve(cwd, flags.configPath))
    : await readSetupConfigFromHome(homePath);
  const envFileValues = await readAgentEnvFiles({
    cwd,
    homePath,
    explicitEnvFile: flags.envFile,
  });

  const baseUrl = flags.baseUrl
    ?? process.env.AGENTRAIL_BASE_URL
    ?? envFileValues.AGENTRAIL_BASE_URL
    ?? config?.server?.baseUrl;
  const apiKey = flags.apiKey
    ?? process.env.AGENTRAIL_API_KEY
    ?? envFileValues.AGENTRAIL_API_KEY;
  const agentId = flags.agentId
    ?? process.env.AGENTRAIL_AGENT_ID
    ?? envFileValues.AGENTRAIL_AGENT_ID;
  const repoAllowlist = parseCsv(
    flags.repo
      ?? process.env.AGENTRAIL_REPO_ALLOWLIST
      ?? envFileValues.AGENTRAIL_REPO_ALLOWLIST,
  );
  const expectedRepo = repoAllowlist[0] ?? primaryRepoFromConfig(config)?.slug ?? null;
  const setupApiKey = flags.setupApiKey
    ?? process.env.AGENTRAIL_OPERATOR_KEY
    ?? process.env.AGENTRAIL_SETUP_API_KEY
    ?? process.env.AGENTRAIL_OPERATOR_API_KEY
    ?? process.env.AGENTRAIL_ADMIN_API_KEY
    ?? envFileValues.AGENTRAIL_OPERATOR_KEY
    ?? envFileValues.AGENTRAIL_SETUP_API_KEY
    ?? null;

  const missing: string[] = [];
  if (!baseUrl) missing.push("AGENTRAIL_BASE_URL");
  if (!apiKey) missing.push("AGENTRAIL_API_KEY");
  if (!agentId) missing.push("AGENTRAIL_AGENT_ID");
  if (missing.length > 0) {
    return {
      error: `agentrail doctor requires ${missing.join(", ")} in flags, process env, or ~/.agentrail/agent.env.`,
    };
  }

  return {
    baseUrl: baseUrl!.replace(/\/+$/, ""),
    apiKey: apiKey!,
    agentId: agentId!,
    expectedRepo,
    setupApiKey,
  };
}

async function runDoctorChecks(inputs: DoctorInputs, flags: DoctorFlags): Promise<{
  ok: boolean;
  checks: DoctorCheck[];
  baseUrl: string;
  agentId: string;
  expectedRepo: string | null;
  visibleTaskIdentifier: string | null;
  expectedSetupTaskIdentifier: string;
  nextRepairCommand: string | null;
  failedCheckId: DoctorCheck["id"] | null;
}> {
  const checks: DoctorCheck[] = [];
  let visibleTaskIdentifier: string | null = null;
  let failedCheckId: DoctorCheck["id"] | null = null;
  const expectedSetupTaskIdentifier = buildExpectedSetupTaskIdentifier(inputs.agentId);

  const health = await getJson<{ status?: string }>({
    baseUrl: inputs.baseUrl,
    route: "/health",
  });
  const healthOk = health.status === 200 && health.json?.status === "ok";
  checks.push({
    id: "health",
    ok: healthOk,
    summary: healthOk
      ? `GET /health returned status=ok from ${inputs.baseUrl}.`
      : `GET /health failed with HTTP ${health.status}.`,
  });
  failedCheckId = failedCheckId ?? (healthOk ? null : "health");

  const mine = await getJson<TaskListResponse>({
    baseUrl: inputs.baseUrl,
    route: "/tasks/mine?status=in_progress&limit=1",
    bearerToken: inputs.apiKey,
  });
  const authOk = mine.status === 200;
  checks.push({
    id: "auth",
    ok: authOk,
    summary: authOk
      ? "AGENTRAIL_API_KEY authenticated against GET /tasks/mine."
      : `GET /tasks/mine rejected AGENTRAIL_API_KEY with HTTP ${mine.status}.`,
  });
  failedCheckId = failedCheckId ?? (authOk ? null : "auth");

  const profile = inputs.setupApiKey
    ? await getJson<AgentProfileResponse>({
      baseUrl: inputs.baseUrl,
      route: `/operator/routing/agent-profiles/${inputs.agentId}`,
      bearerToken: inputs.setupApiKey,
    })
    : null;
  const profileAllowlist = profile?.json?.data?.repoAllowlist ?? [];
  const profileOk = Boolean(
    inputs.setupApiKey
    && profile?.status === 200
    && profile.json?.data?.status === "active"
    && (!inputs.expectedRepo || profileAllowlist.includes(inputs.expectedRepo)),
  );
  checks.push({
    id: "profile",
    ok: profileOk,
    summary: profileOk
      ? `${inputs.agentId} is active and repo-eligible for ${inputs.expectedRepo ?? "the configured setup repo"}.`
      : inputs.setupApiKey
        ? `Agent profile ${inputs.agentId} is missing, inactive, or does not allow ${inputs.expectedRepo ?? "the configured repo"}.`
        : "Set AGENTRAIL_OPERATOR_KEY to verify routing profile state.",
  });
  failedCheckId = failedCheckId ?? (profileOk ? null : "profile");

  const routing = flags.skipRoutingCheck
    ? null
    : inputs.setupApiKey
      ? await getJson<RuleSetResponse>({
        baseUrl: inputs.baseUrl,
        route: "/operator/routing/rule-sets/current",
        bearerToken: inputs.setupApiKey,
      })
      : null;
  const routingOk = flags.skipRoutingCheck
    ? true
    : Boolean(
      inputs.setupApiKey
      && routing?.status === 200
      && routing.json?.data?.rules?.some((rule) => ruleMatchesDoctorExpectation({
        rule,
        agentId: inputs.agentId,
        expectedRepo: inputs.expectedRepo,
      })),
    );
  checks.push({
    id: "routing",
    ok: routingOk,
    summary: flags.skipRoutingCheck
      ? "Routing check skipped by flag."
      : routingOk
      ? `Current routing rule set includes an enabled rule targeting ${inputs.agentId}${inputs.expectedRepo ? ` for ${inputs.expectedRepo}` : ""}.`
      : inputs.setupApiKey
        ? `Current routing rule set does not target ${inputs.agentId}${inputs.expectedRepo ? ` for ${inputs.expectedRepo}` : ""}.`
        : "Set AGENTRAIL_OPERATOR_KEY to verify routing rule state.",
  });
  failedCheckId = failedCheckId ?? (routingOk ? null : "routing");

  const setupTaskVisibility = await findVisibleSetupTask(inputs);
  visibleTaskIdentifier = setupTaskVisibility.visibleTaskIdentifier;
  const assignedTaskVisibilityOk = setupTaskVisibility.ok;
  checks.push({
    id: "assigned_task_visibility",
    ok: assignedTaskVisibilityOk,
    summary: assignedTaskVisibilityOk
      ? `GET /tasks/mine found setup task ${expectedSetupTaskIdentifier} for ${inputs.agentId}${inputs.expectedRepo ? ` in ${inputs.expectedRepo}` : ""}.`
      : setupTaskVisibility.listStatus === 200
        ? `GET /tasks/mine did not expose expected setup task ${expectedSetupTaskIdentifier} for ${inputs.agentId}; scanned ${setupTaskVisibility.scannedCount} in-progress task(s)${visibleTaskIdentifier ? `, first visible task was ${visibleTaskIdentifier}` : ""}.`
        : `GET /tasks/mine failed while looking for setup task ${expectedSetupTaskIdentifier} with HTTP ${setupTaskVisibility.listStatus}.`,
  });
  failedCheckId = failedCheckId ?? (assignedTaskVisibilityOk ? null : "assigned_task_visibility");

  return {
    ok: checks.every((check) => check.ok),
    checks,
    baseUrl: inputs.baseUrl,
    agentId: inputs.agentId,
    expectedRepo: inputs.expectedRepo,
    visibleTaskIdentifier,
    expectedSetupTaskIdentifier,
    nextRepairCommand: assignedTaskVisibilityOk || !inputs.setupApiKey
      ? null
      : renderRepairCommand(inputs),
    failedCheckId,
  };
}

function renderDoctorReport(report: {
  ok: boolean;
  checks: DoctorCheck[];
  baseUrl: string;
  agentId: string;
  expectedRepo: string | null;
  visibleTaskIdentifier: string | null;
  expectedSetupTaskIdentifier: string;
  nextRepairCommand: string | null;
  failedCheckId: DoctorCheck["id"] | null;
}): string {
  const lines = [
    report.ok ? "AgentRail doctor passed." : "AgentRail doctor failed.",
    "",
    ...report.checks.map((check) => `- ${check.ok ? "PASS" : "FAIL"} ${check.id}: ${check.summary}`),
  ];

  if (!report.ok) {
    lines.push(
      "",
      "Failure contract:",
      JSON.stringify({
        baseUrl: report.baseUrl,
        agentId: report.agentId,
        repo: report.expectedRepo,
        failedCheck: report.failedCheckId,
        visibleTaskIdentifier: report.visibleTaskIdentifier,
        expectedSetupTaskIdentifier: report.expectedSetupTaskIdentifier,
      }, null, 2),
    );

    if (report.nextRepairCommand) {
      lines.push(
        "",
        "Suggested repair:",
        report.nextRepairCommand,
      );
    }
  }

  return `${lines.join("\n")}\n`;
}

function ruleMatchesDoctorExpectation({
  rule,
  agentId,
  expectedRepo,
}: {
  rule: NonNullable<RuleSetResponse["data"]>["rules"][number];
  agentId: string;
  expectedRepo: string | null;
}): boolean {
  if (!rule.enabled || rule.target?.type !== "agent" || rule.target.id !== agentId) {
    return false;
  }

  if (!expectedRepo) {
    return true;
  }

  const repositories = rule.conditions?.repositories;
  return !Array.isArray(repositories) || repositories.includes(expectedRepo);
}

async function findVisibleSetupTask(inputs: DoctorInputs): Promise<SetupTaskVisibilityResult> {
  const expectedIdentifier = buildExpectedSetupTaskIdentifier(inputs.agentId);
  let cursor: string | null = null;
  let visibleTaskIdentifier: string | null = null;
  let scannedCount = 0;
  const seenCursors = new Set<string>();

  do {
    const route = `/tasks/mine?status=in_progress&limit=100${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ""}`;
    const list = await getJson<TaskListResponse>({
      baseUrl: inputs.baseUrl,
      route,
      bearerToken: inputs.apiKey,
    });
    if (list.status !== 200) {
      return {
        ok: false,
        visibleTaskIdentifier,
        scannedCount,
        listStatus: list.status,
      };
    }

    const tasks = Array.isArray(list.json?.data) ? list.json.data : [];
    for (const task of tasks) {
      if (!task.id) continue;
      scannedCount += 1;

      if (task.identifier && task.identifier !== expectedIdentifier) {
        visibleTaskIdentifier = visibleTaskIdentifier ?? task.identifier;
        continue;
      }

      const detail = await getJson<TaskDetailResponse>({
        baseUrl: inputs.baseUrl,
        route: `/tasks/${task.id}`,
        bearerToken: inputs.apiKey,
      });
      const detailIdentifier = detail.json?.data?.identifier ?? task.identifier ?? null;
      visibleTaskIdentifier = visibleTaskIdentifier ?? detailIdentifier;
      const assigneeAgentId = detail.json?.data?.assigneeAgentId;
      const assigneeId = typeof assigneeAgentId === "string" && assigneeAgentId.length > 0
        ? assigneeAgentId
        : assigneeAgentId === null
          ? null
          : detail.json?.data?.assignee?.id;
      if (detail.status === 200 && detailIdentifier === expectedIdentifier && assigneeId === inputs.agentId) {
        return {
          ok: true,
          visibleTaskIdentifier: detailIdentifier,
          scannedCount,
          listStatus: list.status,
        };
      }
    }

    cursor = list.json?.page?.nextCursor ?? null;
    if (cursor && seenCursors.has(cursor)) {
      cursor = null;
    } else if (cursor) {
      seenCursors.add(cursor);
    }
  } while (cursor);

  return {
    ok: false,
    visibleTaskIdentifier,
    scannedCount,
    listStatus: 200,
  };
}

function buildExpectedSetupTaskIdentifier(agentId: string): string {
  return `LOCAL-SETUP-${normalizeAgentId(agentId)}`;
}

function normalizeAgentId(agentId: string): string {
  return agentId.replace(/[^A-Za-z0-9]+/g, "-").replace(/^-+|-+$/g, "").toUpperCase();
}

function renderRepairCommand(inputs: DoctorInputs): string {
  const payload = JSON.stringify({
    agentId: inputs.agentId,
    sourceRef: "agentrail-doctor",
  });
  const idempotencyAgentToken = encodeURIComponent(inputs.agentId);
  return [
    `curl -s -X POST ${shellSingleQuote(`${inputs.baseUrl}/operator/setup/verification-task`)} \\`,
    '  -H "authorization: Bearer $AGENTRAIL_OPERATOR_KEY" \\',
    '  -H "content-type: application/json" \\',
    `  -H ${shellSingleQuote(`idempotency-key: setup-verification:${idempotencyAgentToken}:v1`)} \\`,
    `  -d ${shellSingleQuote(payload)}`,
  ].join("\n");
}

function shellSingleQuote(value: string): string {
  return `'${value.replace(/'/g, "'\\''")}'`;
}

async function getJson<T>({
  baseUrl,
  route,
  bearerToken,
  timeoutMs = 30_000,
}: {
  baseUrl: string;
  route: string;
  bearerToken?: string;
  timeoutMs?: number;
}): Promise<JsonResponse<T>> {
  const url = new URL(route.replace(/^\//, ""), `${baseUrl}/`);
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const response = await fetch(url, {
      headers: {
        accept: "application/json",
        ...(bearerToken ? { authorization: `Bearer ${bearerToken}` } : {}),
      },
      signal: controller.signal,
    });
    const text = await response.text();

    try {
      return {
        status: response.status,
        json: JSON.parse(text) as T,
      };
    } catch {
      return {
        status: response.status,
        json: null,
      };
    }
  } catch {
    return {
      status: 0,
      json: null,
    };
  } finally {
    clearTimeout(timeoutId);
  }
}

async function readSetupConfig(configPath: string): Promise<SetupConfigLike | null> {
  try {
    const content = await readFile(configPath, "utf8");
    return JSON.parse(content) as SetupConfigLike;
  } catch {
    return null;
  }
}

async function readAgentEnvFiles({
  cwd,
  homePath,
  explicitEnvFile,
}: {
  cwd: string;
  homePath: string;
  explicitEnvFile?: string;
}): Promise<Record<string, string>> {
  const candidates = [
    explicitEnvFile ? path.resolve(cwd, explicitEnvFile) : null,
    currentAgentEnvPathForHome(homePath),
    operatorEnvPathForHome(homePath),
  ].filter((value): value is string => Boolean(value));

  const merged: Record<string, string> = {};
  for (const filePath of candidates) {
    try {
      const content = await readFile(filePath, "utf8");
      const parsed = parseEnvFile(content);
      if (Object.keys(parsed).length > 0) {
        Object.assign(merged, parsed);
      }
    } catch {
      continue;
    }
  }

  return merged;
}

function parseEnvFile(content: string): Record<string, string> {
  const parsed: Record<string, string> = {};

  for (const rawLine of content.split(/\r?\n/u)) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;

    const separatorIndex = line.indexOf("=");
    if (separatorIndex === -1) continue;

    const key = line.slice(0, separatorIndex).trim();
    const value = line.slice(separatorIndex + 1).trim();
    if (!key) continue;
    parsed[key] = value.replace(/^"(.*)"$/u, "$1").replace(/^'(.*)'$/u, "$1");
  }

  return parsed;
}

function parseCsv(value: string | undefined): string[] {
  if (!value) return [];
  return value.split(",").map((part) => part.trim()).filter(Boolean);
}

function nextValue(argv: string[], index: number, flag: string): string {
  const value = argv[index];
  if (!value || value.startsWith("--")) {
    throw new Error(`${flag} requires a value.`);
  }
  return value;
}
