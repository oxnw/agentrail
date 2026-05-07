import crypto from "node:crypto";
import { spawnSync } from "node:child_process";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";

import { SUPPORTED_SCOPES } from "../agent-auth-store.ts";
import { runDoctor } from "./doctor.ts";
import {
  currentAgentEnvPathForHome,
  managedAgentEnvPathForHome,
  operatorEnvPathForHome,
  primaryRepoFromConfig,
  readSetupConfigFromHome,
  recipePathForHome,
  resolveAgentRailHome,
  type ConnectedRepo,
} from "./agentrail-home.ts";
import { createPromptSession, type PromptChoice, type PromptSession } from "./prompt.ts";
import { detectRepoContext } from "./repo-detection.ts";
import type { DetectedRepoContext } from "./setup-config.ts";

interface Writer {
  write(chunk: string | Uint8Array): boolean;
}

export interface AgentCreateFlags {
  help?: boolean;
  baseUrl?: string;
  setupApiKey?: string;
  configPath?: string;
  envFile?: string;
  agentId?: string;
  name?: string;
  role?: string;
  runner?: string;
  repoAllowlist?: string[];
  capabilityTags?: string[];
  ownershipTags?: string[];
  maxConcurrentTasks?: number;
  instructionsPath?: string;
  scopes?: string[];
  permissionPreset?: string;
  enableShip?: boolean;
  setDefaultEnv?: boolean;
  configureRouting?: boolean;
  routingLabels?: string[];
  routingProjects?: string[];
  routingIssueTypes?: string[];
  routingPriorities?: string[];
  routingOwnershipTags?: string[];
  routingCapabilityTags?: string[];
}

export interface AgentUpdateFlags extends AgentCreateFlags {
  apiKeyId?: string;
}

export interface RunAgentCommandOptions {
  cwd: string;
  stdout: Writer;
  stderr: Writer;
  stdinIsTTY?: boolean;
  stdoutIsTTY?: boolean;
  detectRepoContext?: (cwd: string) => DetectedRepoContext | Promise<DetectedRepoContext>;
  createPrompt?: () => PromptSession;
  bootstrapSummaryMode?: boolean;
}

interface SetupConfigLike {
  server?: {
    baseUrl?: string;
  };
  repos?: ConnectedRepo[];
}

interface AgentEnvValues {
  AGENTRAIL_BASE_URL?: string;
  AGENTRAIL_API_KEY?: string;
  AGENTRAIL_API_KEY_ID?: string;
  AGENTRAIL_AGENT_ID?: string;
  AGENTRAIL_AGENT_RUNNER?: string;
  AGENTRAIL_REPO_ALLOWLIST?: string;
  AGENTRAIL_AGENT_RECIPE_PATH?: string;
  AGENTRAIL_OPERATOR_KEY?: string;
  AGENTRAIL_OPERATOR_KEY_ID?: string;
}

interface AgentCommandInputs {
  baseUrl: string;
  setupApiKey: string;
  runner: string;
  agentId: string;
  name: string;
  role: string;
  repoPath: string;
  repoAllowlist: string[];
  primaryRepoUrl: string;
  capabilityTags: string[];
  ownershipTags: string[];
  maxConcurrentTasks: number;
  instructionsPath: string;
  scopes: string[];
  setDefaultEnv: boolean;
  configureRouting: boolean;
  routingLabels: string[];
  routingProjects: string[];
  routingIssueTypes: string[];
  routingPriorities: string[];
  routingOwnershipTags: string[];
  routingCapabilityTags: string[];
}

interface ProfileBody {
  agentId: string;
  displayName: string;
  role: string;
  status: "active" | "paused" | "disabled";
  capabilityTags: string[];
  ownershipTags: string[];
  repoAllowlist: string[];
  maxConcurrentTasks: number;
}

interface RuleSetBody {
  data?: {
    rules?: RoutingRule[];
    classifier?: {
      enabled: boolean;
      provider: string;
      confidenceThreshold: number;
      maxCandidates: number;
      fallbackTriageQueueId: string;
    };
  };
}

interface RoutingRule {
  id: string;
  name: string;
  enabled: boolean;
  priority: number;
  conditions: Record<string, string[]>;
  target: {
    type: "agent" | "triage_queue";
    id: string;
  };
  confidence: number;
  explanation: string;
}

interface UsageBody {
  data?: {
    keyId?: string;
    scopes?: string[];
    agent?: {
      displayName?: string;
      role?: string;
      externalIdentities?: Array<{ provider: string; subject: string }>;
    };
    rateLimit?: {
      windowSeconds?: number;
      maxRequests?: number;
    };
  };
}

interface ApiKeyMutationResponse {
  data?: {
    id?: string;
    apiKey?: string;
  };
}

const DEFAULT_SCOPE_PRESET = ["tasks:read", "tasks:write", "ci:read", "reviews:read", "events:read"];
const READ_ONLY_SCOPE_PRESET = ["tasks:read", "ci:read", "reviews:read", "events:read"];
const READ_WRITE_SCOPE_PRESET = [...DEFAULT_SCOPE_PRESET];
const READ_WRITE_SHIP_SCOPE_PRESET = [...DEFAULT_SCOPE_PRESET, "ship:write"];
const COMMON_ADVANCED_SCOPES = ["tasks:read", "tasks:write", "ci:read", "reviews:read", "events:read", "ship:write"];
const EXPANDED_ADVANCED_SCOPES = ["routing:read", "routing:evaluate", "routing:admin", "usage:read", "webhooks:read", "webhooks:write", "auth:admin"];
const PRIVILEGED_SCOPES = new Set(["auth:admin", "routing:admin", "routing:evaluate", "routing:read", "usage:read", "webhooks:write"]);
const MANAGED_RULE_PRIORITY = 100;
const PERMISSION_PRESET_VALUES = ["read_only", "read_write", "read_write_ship", "advanced"] as const;
const SKILL_TAG_OPTIONS = ["frontend", "backend", "api", "tests", "docs", "infra", "devops", "security", "data", "mobile", "review", "release"];
const OWNERSHIP_TAG_OPTIONS = ["web", "api", "infra", "docs", "auth", "billing", "deployments", "ci", "integrations", "data"];
const CAPACITY_OPTIONS = [1, 2, 3, 5] as const;
const ROLE_OPTIONS = [
  {
    value: "coding_agent",
    label: "General coding",
    hint: "Best for building and editing code. Skills decide the specific work types.",
  },
  {
    value: "review_agent",
    label: "Code review",
    hint: "Best for review, regressions, findings, and quality checks.",
  },
  {
    value: "docs_agent",
    label: "Docs",
    hint: "Best for guides, docs, and written knowledge.",
  },
  {
    value: "infra_devops_agent",
    label: "Infrastructure / DevOps",
    hint: "Best for CI, deployments, environments, and platform work.",
  },
  {
    value: "release_agent",
    label: "Release / shipping",
    hint: "Best for release prep, shipping, and handoff work.",
  },
] as const;

type PermissionPreset = typeof PERMISSION_PRESET_VALUES[number];
type RoleValue = typeof ROLE_OPTIONS[number]["value"];

interface RunnerDefinition {
  value: string;
  label: string;
  description: string;
  signInHint: string;
  executable?: string;
}

const RUNNER_DEFINITIONS: RunnerDefinition[] = [
  {
    value: "codex",
    label: "Codex",
    description: "Runs work through the Codex CLI on this machine.",
    signInHint: "Make sure you are already signed in to Codex on this machine.",
    executable: "codex",
  },
  {
    value: "claude-code",
    label: "Claude Code",
    description: "Runs work through the Claude Code CLI.",
    signInHint: "Make sure you are already signed in to Claude Code on this machine.",
    executable: "claude",
  },
  {
    value: "cursor",
    label: "Cursor",
    description: "Opens this repo in Cursor for agent-assisted work.",
    signInHint: "Make sure you are already signed in to Cursor on this machine.",
    executable: "cursor",
  },
  {
    value: "devin",
    label: "Devin",
    description: "Uses the Devin CLI or local launcher for this agent.",
    signInHint: "Make sure you are already signed in to Devin on this machine.",
    executable: "devin",
  },
  {
    value: "custom",
    label: "Custom",
    description: "Use your own local runner command and workflow.",
    signInHint: "Make sure your custom runner is installed and already signed in.",
  },
];

export function parseAgentCreateArgs(argv: string[]): AgentCreateFlags {
  return parseAgentCommandArgs(argv);
}

export function parseAgentUpdateArgs(argv: string[]): AgentUpdateFlags {
  const flags = parseAgentCommandArgs(argv) as AgentUpdateFlags;
  for (let index = 0; index < argv.length; index += 1) {
    if (argv[index] === "--api-key-id") {
      flags.apiKeyId = nextValue(argv, ++index, "--api-key-id");
    }
  }
  return flags;
}

function parseAgentCommandArgs(argv: string[]): AgentCreateFlags {
  const flags: AgentCreateFlags = {};
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    switch (arg) {
      case "--help":
        flags.help = true;
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
      case "--env-file":
        flags.envFile = nextValue(argv, ++index, arg);
        break;
      case "--agent-id":
        flags.agentId = nextValue(argv, ++index, arg);
        break;
      case "--name":
        flags.name = nextValue(argv, ++index, arg);
        break;
      case "--role":
        flags.role = nextValue(argv, ++index, arg);
        break;
      case "--runner":
        flags.runner = nextValue(argv, ++index, arg);
        break;
      case "--repo-allowlist":
        flags.repoAllowlist = parseCsv(nextValue(argv, ++index, arg));
        break;
      case "--capability-tags":
        flags.capabilityTags = parseCsv(nextValue(argv, ++index, arg));
        break;
      case "--ownership-tags":
        flags.ownershipTags = parseCsv(nextValue(argv, ++index, arg));
        break;
      case "--max-concurrent-tasks":
        flags.maxConcurrentTasks = Number.parseInt(nextValue(argv, ++index, arg), 10);
        break;
      case "--instructions-path":
        flags.instructionsPath = nextValue(argv, ++index, arg);
        break;
      case "--scopes":
        flags.scopes = parseCsv(nextValue(argv, ++index, arg));
        break;
      case "--permission-preset":
        flags.permissionPreset = nextValue(argv, ++index, arg);
        break;
      case "--enable-ship":
        flags.enableShip = true;
        break;
      case "--set-default-env":
        flags.setDefaultEnv = true;
        break;
      case "--configure-routing":
        flags.configureRouting = true;
        break;
      case "--routing-labels":
        flags.routingLabels = parseCsv(nextValue(argv, ++index, arg));
        break;
      case "--routing-projects":
        flags.routingProjects = parseCsv(nextValue(argv, ++index, arg));
        break;
      case "--routing-issue-types":
        flags.routingIssueTypes = parseCsv(nextValue(argv, ++index, arg));
        break;
      case "--routing-priorities":
        flags.routingPriorities = parseCsv(nextValue(argv, ++index, arg));
        break;
      case "--routing-ownership-tags":
        flags.routingOwnershipTags = parseCsv(nextValue(argv, ++index, arg));
        break;
      case "--routing-capability-tags":
        flags.routingCapabilityTags = parseCsv(nextValue(argv, ++index, arg));
        break;
      case "--api-key-id":
        ++index;
        break;
      default:
        throw new Error(`Unknown flag "${arg}".`);
    }
  }
  return flags;
}

export async function runAgentCreate(argv: string[], options: RunAgentCommandOptions): Promise<number> {
  const flags = parseAgentCreateArgs(argv);
  const { cwd, stdout, stderr } = options;
  if (flags.help) {
    stdout.write(renderAgentCreateUsage());
    return 0;
  }

  const detectRepo = options.detectRepoContext ?? detectRepoContext;
  const repo = await Promise.resolve(detectRepo(cwd));
  const homePath = resolveAgentRailHome({ cwd, explicitHome: null });
  const setupConfig = flags.configPath
    ? await readSetupConfig(path.resolve(cwd, flags.configPath))
    : await readSetupConfigFromHome(homePath);
  const prompt = shouldPrompt(options, flags)
    ? (options.createPrompt ?? (() => createPromptSession()))()
    : null;
  let createAgentId: string | null = null;
  let createdKeyId: string | null = null;
  let completedSteps: string[] = [];

  try {
    const inputs = await collectCreateInputs({ cwd, flags, repo, setupConfig, prompt });
    createAgentId = inputs.agentId;
    const runnerCheck = verifyRunnerReadiness(inputs.runner);
    if (prompt) {
      await showCreateReview({ prompt, inputs, runnerCheck });
      const shouldCreate = await prompt.confirm({
        message: "Create this agent now?",
        defaultValue: true,
      });
      if (!shouldCreate) {
        throw new Error("Agent creation cancelled.");
      }
    } else if (!runnerCheck.ok && runnerCheck.message) {
      stdout.write(`${runnerCheck.message}\n`);
    }
    const existingProfile = await getJson({
      baseUrl: inputs.baseUrl,
      route: `/operator/routing/agent-profiles/${inputs.agentId}`,
      bearerToken: inputs.setupApiKey,
    });
    if (existingProfile.status === 200) {
      stderr.write(`Agent profile ${inputs.agentId} already exists. Use \`agentrail agent update --agent-id ${inputs.agentId}\`.\n`);
      return 1;
    }
    if (!flags.envFile) {
      const existingManagedEnv = await readAgentEnvFile({
        cwd,
        homePath,
        agentId: inputs.agentId,
      });
      if (existingManagedEnv.path && path.basename(existingManagedEnv.path) !== "agent.env") {
        stderr.write(`Managed env file already exists for ${inputs.agentId}. Use \`agentrail agent update --agent-id ${inputs.agentId}\`.\n`);
        return 1;
      }
    }

    warnPrivilegedScopes(inputs.scopes, stdout);

    await requestJson({
      baseUrl: inputs.baseUrl,
      route: `/operator/routing/agent-profiles/${inputs.agentId}`,
      bearerToken: inputs.setupApiKey,
      method: "PUT",
      idempotencyKey: mutationIdempotencyKey("agent-profile", inputs.agentId, {
        displayName: inputs.name,
        role: inputs.role,
        status: "active",
        capabilityTags: inputs.capabilityTags,
        ownershipTags: inputs.ownershipTags,
        repoAllowlist: inputs.repoAllowlist,
        maxConcurrentTasks: inputs.maxConcurrentTasks,
        sourceRef: "agentrail-cli:agent-create",
        changeReason: "Create local agent profile through CLI.",
      }),
      body: {
        displayName: inputs.name,
        role: inputs.role,
        status: "active",
        capabilityTags: inputs.capabilityTags,
        ownershipTags: inputs.ownershipTags,
        repoAllowlist: inputs.repoAllowlist,
        maxConcurrentTasks: inputs.maxConcurrentTasks,
        sourceRef: "agentrail-cli:agent-create",
        changeReason: "Create local agent profile through CLI.",
      },
    });
    completedSteps.push("agent_profile");

    const routingResult = await ensureManagedRouting({
      baseUrl: inputs.baseUrl,
      setupApiKey: inputs.setupApiKey,
      profile: inputs,
      stdout,
      allowMutationWhenExisting: inputs.configureRouting,
      interactive: Boolean(prompt),
    });
    if (routingResult.mutated) {
      completedSteps.push("routing");
    }

    await requestJson({
      baseUrl: inputs.baseUrl,
      route: "/operator/setup/verification-task",
      bearerToken: inputs.setupApiKey,
      method: "POST",
      idempotencyKey: mutationIdempotencyKey("setup-verification", inputs.agentId, {
        agentId: inputs.agentId,
        sourceRef: "agentrail-cli:agent-create",
      }),
      body: {
        agentId: inputs.agentId,
        sourceRef: "agentrail-cli:agent-create",
      },
    });
    completedSteps.push("setup_verification");

    const createKeyBody = {
      agent: {
        id: inputs.agentId,
        displayName: inputs.name,
        role: inputs.role,
      },
      scopes: inputs.scopes,
    };
    const keyResponse = await requestJson<ApiKeyMutationResponse>({
      baseUrl: inputs.baseUrl,
      route: "/agent-api-keys",
      bearerToken: inputs.setupApiKey,
      method: "POST",
      idempotencyKey: mutationIdempotencyKey("agent-key", inputs.agentId, createKeyBody),
      body: createKeyBody,
    });
    createdKeyId = keyResponse.json?.data?.id ?? null;
    completedSteps.push("agent_key");

    const envValues = buildAgentEnvValues({
      baseUrl: inputs.baseUrl,
      apiKey: keyResponse.json?.data?.apiKey ?? "",
      apiKeyId: createdKeyId ?? "",
      agentId: inputs.agentId,
      runner: inputs.runner,
      repoAllowlist: inputs.repoAllowlist,
      instructionsPath: inputs.instructionsPath,
    });
    const envFilePath = resolveManagedEnvPath(cwd, homePath, inputs.agentId, flags.envFile);

    const doctorArgs = [
      "--base-url", inputs.baseUrl,
      "--api-key", envValues.AGENTRAIL_API_KEY,
      "--agent-id", inputs.agentId,
      "--setup-api-key", inputs.setupApiKey,
    ];
    if (inputs.repoAllowlist[0]) {
      doctorArgs.push("--repo", inputs.repoAllowlist[0]);
    }
    if (!routingResult.mutated) {
      doctorArgs.push("--skip-routing-check");
    }
    const doctorExitCode = await runDoctor(doctorArgs, {
      cwd,
      stdout,
      stderr,
      silent: Boolean(options.bootstrapSummaryMode),
    });
    if (doctorExitCode !== 0) {
      if (createdKeyId) {
        stderr.write(renderCreateRecoveryBlock({
          agentId: inputs.agentId,
          keyId: createdKeyId,
          completedSteps,
        }));
      }
      return doctorExitCode;
    }

    await writeAgentEnvFileAtPath(envFilePath, envValues);
    await maybeWriteDefaultEnvAlias({
      homePath,
      envFilePath,
      setDefaultEnv: inputs.setDefaultEnv,
      prompt,
    });

    if (options.bootstrapSummaryMode) {
      const summaryLines = [
        `✓ Health check succeeded.`,
        `✓ Agent ${inputs.name} (${inputs.agentId}) created.`,
        `✓ ${inputs.name} is connected to ${inputs.repoPath} and ${inputs.primaryRepoUrl}.`,
        `✓ ${runnerDefinitionFor(inputs.runner).label} looks available. Make sure you are already signed in on this machine.`,
      ];
      if (prompt) {
        await prompt.note({
          title: "First agent ready",
          body: summaryLines.join("\n"),
        });
      } else {
        stdout.write(`${summaryLines.join("\n")}\n`);
      }
    } else {
      stdout.write(`Created agent ${inputs.name} (${inputs.agentId}).\n`);
      stdout.write(`GitHub repo: ${inputs.primaryRepoUrl}\n`);
      stdout.write(`Env file: ${envFilePath}\n`);
      stdout.write(`${runnerDefinitionFor(inputs.runner).signInHint}\n`);
      stdout.write(`${renderRunnerCommand(inputs.runner, envFilePath, inputs.repoPath)}\n`);
    }
    return 0;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    stderr.write(`${message}\n`);
    if (typeof createdKeyId === "string" && typeof createAgentId === "string") {
      stderr.write(renderCreateRecoveryBlock({
        agentId: createAgentId,
        keyId: createdKeyId,
        completedSteps,
      }));
    }
    return 1;
  } finally {
    await prompt?.close();
  }
}

export async function runAgentUpdate(argv: string[], options: RunAgentCommandOptions): Promise<number> {
  const flags = parseAgentUpdateArgs(argv);
  const { cwd, stdout, stderr } = options;
  if (flags.help) {
    stdout.write(renderAgentUpdateUsage());
    return 0;
  }

  const detectRepo = options.detectRepoContext ?? detectRepoContext;
  const repo = await Promise.resolve(detectRepo(cwd));
  const homePath = resolveAgentRailHome({ cwd, explicitHome: null });
  const setupConfig = flags.configPath
    ? await readSetupConfig(path.resolve(cwd, flags.configPath))
    : await readSetupConfigFromHome(homePath);
  const prompt = shouldPrompt(options, flags)
    ? (options.createPrompt ?? (() => createPromptSession()))()
    : null;

  try {
    const currentEnv = await readAgentEnvFile({
      cwd,
      homePath,
      explicitEnvFile: flags.envFile,
      agentId: flags.agentId,
    });
    const operatorEnv = await readOperatorEnvFile(homePath);
    const baseUrl = flags.baseUrl ?? process.env.AGENTRAIL_BASE_URL ?? currentEnv.values.AGENTRAIL_BASE_URL ?? setupConfig?.server?.baseUrl;
    const setupApiKey = flags.setupApiKey
      ?? process.env.AGENTRAIL_OPERATOR_KEY
      ?? process.env.AGENTRAIL_SETUP_API_KEY
      ?? process.env.AGENTRAIL_OPERATOR_API_KEY
      ?? process.env.AGENTRAIL_ADMIN_API_KEY
      ?? operatorEnv.AGENTRAIL_OPERATOR_KEY
      ?? null;
    const agentId = flags.agentId ?? currentEnv.values.AGENTRAIL_AGENT_ID ?? null;
    if (!baseUrl || !setupApiKey || !agentId) {
      stderr.write("agentrail agent update requires base URL, setup API key, and agent id.\n");
      return 1;
    }

    const profileResponse = await getJson<{ data?: ProfileBody }>({
      baseUrl,
      route: `/operator/routing/agent-profiles/${agentId}`,
      bearerToken: setupApiKey,
    });
    if (profileResponse.status !== 200 || !profileResponse.json?.data) {
      stderr.write(`Routing agent profile ${agentId} was not found.\n`);
      return 1;
    }
    const keyId = flags.apiKeyId ?? currentEnv.values.AGENTRAIL_API_KEY_ID ?? null;
    if (!keyId) {
      stderr.write(`No managed key id found for ${agentId}. Recreate or add AGENTRAIL_API_KEY_ID to the env file before updating scopes.\n`);
      return 1;
    }
    const usageResponse = await getJson<UsageBody>({
      baseUrl,
      route: `/agent-api-keys/${keyId}/usage`,
      bearerToken: setupApiKey,
    });
    if (usageResponse.status !== 200 || !usageResponse.json?.data) {
      stderr.write(`Agent API key ${keyId} was not found.\n`);
      return 1;
    }

    const currentProfile = profileResponse.json.data as ProfileBody;
    const currentUsage = usageResponse.json.data;
    const inputs = await collectUpdateInputs({
      cwd,
      flags,
      repo,
      prompt,
      setupConfig,
      baseUrl,
      setupApiKey,
      currentEnvPath: currentEnv.path,
      currentRunner: currentEnv.values.AGENTRAIL_AGENT_RUNNER ?? "codex",
      currentInstructionsPath: currentEnv.values.AGENTRAIL_AGENT_RECIPE_PATH ?? defaultInstructionsPath(homePath),
      currentProfile,
      currentUsage,
    });

    warnPrivilegedScopes(inputs.scopes, stdout);

    const rotateBody = {
      agent: {
        displayName: inputs.name,
        role: inputs.role,
      },
      scopes: inputs.scopes,
    };

    const rotated = await requestJson<ApiKeyMutationResponse>({
      baseUrl,
      route: `/agent-api-keys/${keyId}/rotate`,
      bearerToken: setupApiKey,
      method: "POST",
      idempotencyKey: mutationIdempotencyKey("update-agent-key", agentId, rotateBody),
      body: rotateBody,
    });

    await requestJson({
      baseUrl,
      route: `/operator/routing/agent-profiles/${agentId}`,
      bearerToken: setupApiKey,
      method: "PUT",
      idempotencyKey: mutationIdempotencyKey("update-agent-profile", agentId, {
        displayName: inputs.name,
        role: inputs.role,
        status: currentProfile.status ?? "active",
        capabilityTags: inputs.capabilityTags,
        ownershipTags: inputs.ownershipTags,
        repoAllowlist: inputs.repoAllowlist,
        maxConcurrentTasks: inputs.maxConcurrentTasks,
        sourceRef: "agentrail-cli:agent-update",
        changeReason: "Update local agent profile through CLI.",
      }),
      body: {
        displayName: inputs.name,
        role: inputs.role,
        status: currentProfile.status ?? "active",
        capabilityTags: inputs.capabilityTags,
        ownershipTags: inputs.ownershipTags,
        repoAllowlist: inputs.repoAllowlist,
        maxConcurrentTasks: inputs.maxConcurrentTasks,
        sourceRef: "agentrail-cli:agent-update",
        changeReason: "Update local agent profile through CLI.",
      },
    });

    const routingResult = await ensureManagedRouting({
      baseUrl,
      setupApiKey,
      profile: inputs,
      stdout,
      allowMutationWhenExisting: inputs.configureRouting,
      interactive: Boolean(prompt),
      updateExistingManagedRule: true,
    });

    const envValues = buildAgentEnvValues({
      baseUrl,
      apiKey: rotated.json?.data?.apiKey ?? "",
      apiKeyId: rotated.json?.data?.id ?? "",
      agentId,
      runner: inputs.runner,
      repoAllowlist: inputs.repoAllowlist,
      instructionsPath: inputs.instructionsPath,
    });
    const envFilePath = resolveManagedEnvPath(cwd, homePath, agentId, flags.envFile);
    await writeAgentEnvFileAtPath(envFilePath, envValues);

    await maybeWriteDefaultEnvAlias({
      homePath,
      envFilePath,
      setDefaultEnv: Boolean(flags.setDefaultEnv || (currentEnv.path && path.basename(currentEnv.path) === "agent.env")),
      prompt: null,
    });

    const doctorArgs = ["--env-file", path.relative(cwd, envFilePath), "--setup-api-key", setupApiKey];
    if (!routingResult.mutated) {
      doctorArgs.push("--skip-routing-check");
    }
    const doctorExitCode = await runDoctor(doctorArgs, { cwd, stdout, stderr });
    if (doctorExitCode !== 0) {
      return doctorExitCode;
    }

    stdout.write(`Updated agent ${agentId}. Restart any running process still using the old key.\n`);
    stdout.write(`${renderRunnerCommand(inputs.runner, envFilePath, inputs.repoPath)}\n`);
    return 0;
  } finally {
    await prompt?.close();
  }
}

function shouldPrompt(options: RunAgentCommandOptions, flags: AgentCreateFlags): boolean {
  return Boolean((options.stdinIsTTY ?? Boolean(process.stdin.isTTY)) && (options.stdoutIsTTY ?? Boolean(process.stdout.isTTY)))
    && !hasRequiredNonInteractiveInputs(flags);
}

function hasRequiredNonInteractiveInputs(flags: AgentCreateFlags): boolean {
  return Boolean(flags.name && flags.runner && flags.setupApiKey && (flags.scopes?.length || flags.permissionPreset || flags.enableShip));
}

async function collectCreateInputs({
  cwd,
  flags,
  repo,
  setupConfig,
  prompt,
}: {
  cwd: string;
  flags: AgentCreateFlags;
  repo: DetectedRepoContext;
  setupConfig: SetupConfigLike | null;
  prompt: PromptSession | null;
}) {
  const baseUrl = flags.baseUrl ?? process.env.AGENTRAIL_BASE_URL ?? setupConfig?.server?.baseUrl;
  const homePath = resolveAgentRailHome({ cwd, explicitHome: null });
  const operatorEnv = await readOperatorEnvFile(homePath);
  const setupApiKey = flags.setupApiKey
    ?? process.env.AGENTRAIL_OPERATOR_KEY
    ?? process.env.AGENTRAIL_SETUP_API_KEY
    ?? process.env.AGENTRAIL_OPERATOR_API_KEY
    ?? process.env.AGENTRAIL_ADMIN_API_KEY
    ?? operatorEnv.AGENTRAIL_OPERATOR_KEY
    ?? null;
  if (!baseUrl || !setupApiKey) {
    throw new Error("agentrail agent create requires a running server base URL and an operator key.");
  }

  const connectedRepos = Array.isArray(setupConfig?.repos) && setupConfig.repos.length > 0
    ? setupConfig.repos
    : [{
      path: repo.repoPath,
      slug: repo.remoteSlug ?? repo.repoPath,
      defaultBranch: repo.defaultBranch,
    }];
  const defaultAllowlist = flags.repoAllowlist?.length
    ? flags.repoAllowlist
    : connectedRepos.map((connectedRepo) => connectedRepo.slug);
  await describeCreateStep(prompt, "Runner", "Choose the tool that will run this agent. Make sure you are already signed in to it on this machine.");
  const runner = flags.runner ?? (prompt ? await prompt.select({
    message: "Runner",
    choices: RUNNER_DEFINITIONS.map((runnerDefinition) => ({
      label: runnerDefinition.label,
      value: runnerDefinition.value,
      hint: runnerDefinition.description,
    })),
    defaultValue: "codex",
  }) : "codex");
  await describeCreateStep(prompt, "Agent name", "This is the name shown in AgentRail when this agent receives or updates work.");
  const name = flags.name ?? (prompt ? await prompt.input({
    message: "Agent name",
    defaultValue: toDisplayName(runner),
  }) : null);
  if (!name) {
    throw new Error("agentrail agent create requires --name when run non-interactively.");
  }
  const agentId = flags.agentId ?? generateAgentId(runner, name);

  const scopes = await resolveAgentScopes({
    flags,
    prompt,
    mode: "create",
    currentScopes: READ_WRITE_SCOPE_PRESET,
  });
  const agentLabel = name;
  const role = await resolveCreateRole({
    flags,
    prompt,
    agentName: agentLabel,
  });
  const repoSelection = await resolvePrimaryRepo({
    flags,
    prompt,
    agentName: agentLabel,
    defaultRepo: defaultAllowlist[0] ?? repo.remoteSlug ?? repo.repoPath,
    connectedRepos,
  });
  const capabilityTags = await resolveStructuredTags({
    prompt,
    values: flags.capabilityTags,
    message: `What should ${agentLabel} be able to help with?`,
    description: `Choose the kinds of work ${agentLabel} should be best at. This helps AgentRail match task types to ${agentLabel}.`,
    options: SKILL_TAG_OPTIONS,
    defaultValues: ["backend", "api", "tests"],
  });
  const ownershipTags = await resolveStructuredTags({
    prompt,
    values: flags.ownershipTags,
    message: `Which areas should ${agentLabel} own?`,
    description: `Use this when ${agentLabel} should be preferred for specific parts of the product or codebase, like billing, auth, or integrations.`,
    options: OWNERSHIP_TAG_OPTIONS,
    required: false,
    defaultValues: [],
  });
  const maxConcurrentTasks = await resolveCreateCapacity({
    flags,
    prompt,
    agentName: agentLabel,
  });

  return {
    baseUrl: stripTrailingSlash(baseUrl),
    setupApiKey,
    runner,
    agentId,
    name,
    role,
    repoPath: repoSelection.path,
    repoAllowlist: [repoSelection.slug],
    primaryRepoUrl: repoSelection.url,
    capabilityTags,
    ownershipTags,
    maxConcurrentTasks,
    instructionsPath: path.resolve(cwd, flags.instructionsPath ?? (prompt ? await (describeCreateStep(prompt, "Instructions file", "This file contains the shared instructions passed to the runner."), prompt.input({
      message: "Instructions file",
      defaultValue: defaultInstructionsPath(homePath),
    })) : defaultInstructionsPath(homePath))),
    scopes,
    setDefaultEnv: flags.setDefaultEnv ?? (prompt ? await prompt.confirm({
      message: "Set this as the default ~/.agentrail/agent.env alias?",
      defaultValue: true,
    }) : false),
    configureRouting: flags.configureRouting ?? false,
    routingLabels: flags.routingLabels ?? [],
    routingProjects: flags.routingProjects ?? [],
    routingIssueTypes: flags.routingIssueTypes ?? [],
    routingPriorities: flags.routingPriorities ?? [],
    routingOwnershipTags: flags.routingOwnershipTags ?? [],
    routingCapabilityTags: flags.routingCapabilityTags ?? [],
  };
}

async function collectUpdateInputs({
  cwd,
  flags,
  repo,
  prompt,
  setupConfig,
  baseUrl,
  setupApiKey,
  currentEnvPath,
  currentRunner,
  currentInstructionsPath,
  currentProfile,
  currentUsage,
}: {
  cwd: string;
  flags: AgentUpdateFlags;
  repo: DetectedRepoContext;
  prompt: PromptSession | null;
  setupConfig: SetupConfigLike | null;
  baseUrl: string;
  setupApiKey: string;
  currentEnvPath: string | null;
  currentRunner: string;
  currentInstructionsPath: string;
  currentProfile: any;
  currentUsage: NonNullable<UsageBody["data"]>;
}) {
  const runner = flags.runner ?? currentRunner;
  const name = flags.name ?? (prompt ? await prompt.input({
    message: "Display name",
    defaultValue: currentProfile.displayName ?? currentUsage.agent?.displayName ?? "Agent",
  }) : currentProfile.displayName ?? currentUsage.agent?.displayName ?? "Agent");
  const role = flags.role ?? (prompt ? await prompt.input({
    message: "Role",
    defaultValue: currentProfile.role ?? currentUsage.agent?.role ?? "coding_agent",
  }) : currentProfile.role ?? currentUsage.agent?.role ?? "coding_agent");
  const scopes = await resolveAgentScopes({
    flags,
    prompt,
    mode: "update",
    currentScopes: normalizeScopeList(currentUsage.scopes ?? DEFAULT_SCOPE_PRESET),
  });
  const configureRouting = flags.configureRouting ?? (prompt ? await prompt.confirm({
    message: "Update managed routing for this agent?",
    defaultValue: false,
  }) : false);

  return {
    baseUrl,
    setupApiKey,
    agentId: currentProfile.agentId,
    name,
    role,
    runner,
    repoPath: currentProfile.repoAllowlist?.[0]
      ? findRepoPath(setupConfig?.repos ?? [], currentProfile.repoAllowlist[0]) ?? repo.repoPath
      : repo.repoPath,
    primaryRepoUrl: toGitHubUrl(currentProfile.repoAllowlist?.[0] ?? repo.remoteSlug ?? repo.repoPath),
    repoAllowlist: flags.repoAllowlist?.length ? flags.repoAllowlist : parseCsv(prompt ? await prompt.input({
      message: "Repo allowlist (comma-separated)",
      defaultValue: (currentProfile.repoAllowlist ?? [repo.remoteSlug ?? repo.repoPath]).join(","),
    }) : (currentProfile.repoAllowlist ?? [repo.remoteSlug ?? repo.repoPath]).join(",")),
    capabilityTags: flags.capabilityTags?.length ? flags.capabilityTags : parseCsv(prompt ? await prompt.input({
      message: "Capability tags (comma-separated)",
      defaultValue: (currentProfile.capabilityTags ?? []).join(","),
    }) : (currentProfile.capabilityTags ?? []).join(",")),
    ownershipTags: flags.ownershipTags?.length ? flags.ownershipTags : parseCsv(prompt ? await prompt.input({
      message: "Ownership tags (comma-separated)",
      defaultValue: (currentProfile.ownershipTags ?? []).join(","),
    }) : (currentProfile.ownershipTags ?? []).join(",")),
    maxConcurrentTasks: flags.maxConcurrentTasks ?? Number.parseInt(prompt ? await prompt.input({
      message: "Max concurrent tasks",
      defaultValue: String(currentProfile.maxConcurrentTasks ?? 1),
    }) : String(currentProfile.maxConcurrentTasks ?? 1), 10),
    instructionsPath: path.resolve(cwd, flags.instructionsPath ?? (prompt ? await prompt.input({
      message: "Instructions path",
      defaultValue: currentInstructionsPath,
    }) : currentInstructionsPath)),
    scopes,
    setDefaultEnv: flags.setDefaultEnv ?? false,
    configureRouting,
    routingLabels: flags.routingLabels ?? [],
    routingProjects: flags.routingProjects ?? [],
    routingIssueTypes: flags.routingIssueTypes ?? [],
    routingPriorities: flags.routingPriorities ?? [],
    routingOwnershipTags: flags.routingOwnershipTags ?? [],
    routingCapabilityTags: flags.routingCapabilityTags ?? [],
    currentEnvPath,
  };
}

async function ensureManagedRouting({
  baseUrl,
  setupApiKey,
  profile,
  stdout,
  allowMutationWhenExisting,
  interactive,
  updateExistingManagedRule = false,
}: {
  baseUrl: string;
  setupApiKey: string;
  profile: {
    agentId: string;
    repoAllowlist: string[];
    routingLabels?: string[];
    routingProjects?: string[];
    routingIssueTypes?: string[];
    routingPriorities?: string[];
    routingOwnershipTags?: string[];
    routingCapabilityTags?: string[];
  };
  stdout: Writer;
  allowMutationWhenExisting: boolean;
  interactive: boolean;
  updateExistingManagedRule?: boolean;
}) {
  const currentRuleSet = await getJson<RuleSetBody>({
    baseUrl,
    route: "/operator/routing/rule-sets/current",
    bearerToken: setupApiKey,
  });
  const existingRules = currentRuleSet.status === 200 ? (currentRuleSet.json?.data?.rules ?? []) : [];
  if (currentRuleSet.status === 404) {
    const managedRule = buildManagedRoutingRule(profile);
    const body = {
      sourceRef: "agentrail-cli:agent-management",
      changeReason: "Create initial managed routing rule for agent.",
      rules: [managedRule],
      classifier: defaultClassifier(),
    };
    await requestJson({
      baseUrl,
      route: "/operator/routing/rule-sets/current",
      bearerToken: setupApiKey,
      method: "PUT",
      idempotencyKey: routingRuleSetIdempotencyKey(profile.agentId, body),
      body,
    });
    return { mutated: true };
  }

  const managedRuleId = managedRuleIdFor(profile.agentId);
  const managedRule = buildManagedRoutingRule(profile);
  const hasNarrowingConditions = [
    profile.routingLabels?.length,
    profile.routingProjects?.length,
    profile.routingIssueTypes?.length,
    profile.routingPriorities?.length,
    profile.routingOwnershipTags?.length,
    profile.routingCapabilityTags?.length,
  ].some(Boolean);
  const existingManagedRuleIndex = existingRules.findIndex((rule) => rule.id === managedRuleId);

  if (existingManagedRuleIndex !== -1 && updateExistingManagedRule && allowMutationWhenExisting) {
    const nextRules = [...existingRules];
    nextRules[existingManagedRuleIndex] = managedRule;
    await replaceRuleSet({
      baseUrl,
      setupApiKey,
      rules: nextRules,
      classifier: currentRuleSet.json?.data?.classifier ?? defaultClassifier(),
      agentId: profile.agentId,
      changeReason: "Update managed routing rule for agent.",
    });
    return { mutated: true };
  }

  if (allowMutationWhenExisting && hasNarrowingConditions && existingManagedRuleIndex === -1) {
    await replaceRuleSet({
      baseUrl,
      setupApiKey,
      rules: [...existingRules, managedRule],
      classifier: currentRuleSet.json?.data?.classifier ?? defaultClassifier(),
      agentId: profile.agentId,
      changeReason: "Add managed routing rule for agent.",
    });
    return { mutated: true };
  }

  const message = interactive
    ? `Skipped routing mutation for ${profile.agentId}. Run \`agentrail agent update --agent-id ${profile.agentId} --configure-routing\` with narrowing conditions to add managed routing later.\n`
    : `Skipped routing mutation for ${profile.agentId} because no safe managed rule change was requested.\n`;
  stdout.write(message);
  return { mutated: false };
}

async function replaceRuleSet({
  baseUrl,
  setupApiKey,
  rules,
  classifier,
  agentId,
  changeReason,
}: {
  baseUrl: string;
  setupApiKey: string;
  rules: RoutingRule[];
  classifier: Record<string, unknown>;
  agentId: string;
  changeReason: string;
}) {
  await requestJson({
    baseUrl,
    route: "/operator/routing/rule-sets/current",
    bearerToken: setupApiKey,
    method: "PUT",
    idempotencyKey: routingRuleSetIdempotencyKey(agentId, {
      sourceRef: "agentrail-cli:agent-management",
      changeReason,
      rules,
      classifier,
    }),
    body: {
      sourceRef: "agentrail-cli:agent-management",
      changeReason,
      rules,
      classifier,
    },
  });
}

function buildManagedRoutingRule(profile: {
  agentId: string;
  repoAllowlist: string[];
  routingLabels?: string[];
  routingProjects?: string[];
  routingIssueTypes?: string[];
  routingPriorities?: string[];
  routingOwnershipTags?: string[];
  routingCapabilityTags?: string[];
}): RoutingRule {
  const conditions: Record<string, string[]> = {
    repositories: profile.repoAllowlist,
  };
  if (profile.routingLabels?.length) conditions.labelsAny = profile.routingLabels;
  if (profile.routingProjects?.length) conditions.projects = profile.routingProjects;
  if (profile.routingIssueTypes?.length) conditions.issueTypes = profile.routingIssueTypes;
  if (profile.routingPriorities?.length) conditions.priorities = profile.routingPriorities;
  if (profile.routingOwnershipTags?.length) conditions.ownershipTagsAny = profile.routingOwnershipTags;
  if (profile.routingCapabilityTags?.length) conditions.capabilityTagsAll = profile.routingCapabilityTags;

  return {
    id: managedRuleIdFor(profile.agentId),
    name: `CLI managed routing for ${profile.agentId}`,
    enabled: true,
    priority: MANAGED_RULE_PRIORITY,
    conditions,
    target: {
      type: "agent",
      id: profile.agentId,
    },
    confidence: 1,
    explanation: `CLI managed routing rule for ${profile.agentId}.`,
  };
}

function managedRuleIdFor(agentId: string): string {
  return `cli_agent_${agentId}`;
}

function defaultClassifier() {
  return {
    enabled: false,
    provider: "internal-router",
    confidenceThreshold: 0.8,
    maxCandidates: 3,
    fallbackTriageQueueId: "triage_default",
  };
}

function routingRuleSetIdempotencyKey(agentId: string, payload: unknown): string {
  const digest = crypto.createHash("sha256").update(stableStringify(payload)).digest("hex").slice(0, 16);
  return `routing-rule-set:${agentId}:${digest}`;
}

function mutationIdempotencyKey(operation: string, entityId: string, payload: unknown): string {
  const digest = crypto.createHash("sha256").update(stableStringify(payload)).digest("hex").slice(0, 16);
  return `${operation}:${entityId}:${digest}`;
}

function stableStringify(value: unknown): string {
  if (Array.isArray(value)) {
    return `[${value.map((entry) => stableStringify(entry)).join(",")}]`;
  }
  if (value && typeof value === "object") {
    return `{${Object.keys(value)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${stableStringify((value as Record<string, unknown>)[key])}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}

async function maybeWriteDefaultEnvAlias({
  homePath,
  envFilePath,
  setDefaultEnv,
  prompt,
}: {
  homePath: string;
  envFilePath: string;
  setDefaultEnv: boolean;
  prompt: PromptSession | null;
}) {
  const aliasPath = currentAgentEnvPathForHome(homePath);
  const content = await readFile(envFilePath, "utf8");
  let shouldWrite = setDefaultEnv;
  if (prompt) {
    try {
      const existing = await readFile(aliasPath, "utf8");
      if (!existing.trim()) {
        shouldWrite = true;
      } else {
        const existingAgentId = parseEnvFile(existing).AGENTRAIL_AGENT_ID;
        const nextAgentId = parseEnvFile(content).AGENTRAIL_AGENT_ID;
        shouldWrite = shouldWrite || (Boolean(existingAgentId) && existingAgentId === nextAgentId);
      }
      if (shouldWrite && existing.trim() && existing !== content) {
        const overwrite = await prompt.confirm({
          message: "Update ~/.agentrail/agent.env to point to this agent?",
          defaultValue: true,
        });
        if (!overwrite) return;
      }
    } catch {
      shouldWrite = true;
    }
  } else {
    try {
      const existing = await readFile(aliasPath, "utf8");
      if (!existing.trim()) {
        shouldWrite = true;
      } else {
        const existingAgentId = parseEnvFile(existing).AGENTRAIL_AGENT_ID;
        const nextAgentId = parseEnvFile(content).AGENTRAIL_AGENT_ID;
        shouldWrite = shouldWrite || (Boolean(existingAgentId) && existingAgentId === nextAgentId);
      }
    } catch {
      shouldWrite = true;
    }
  }
  if (!shouldWrite) return;
  await writeFile(aliasPath, content, { mode: 0o600 });
}

function resolveManagedEnvPath(cwd: string, homePath: string, agentId: string, explicitEnvFile?: string): string {
  return explicitEnvFile
    ? path.resolve(cwd, explicitEnvFile)
    : managedAgentEnvPathForHome(homePath, agentId);
}

function buildAgentEnvValues({
  baseUrl,
  apiKey,
  apiKeyId,
  agentId,
  runner,
  repoAllowlist,
  instructionsPath,
}: {
  baseUrl: string;
  apiKey: string;
  apiKeyId: string;
  agentId: string;
  runner: string;
  repoAllowlist: string[];
  instructionsPath: string;
}): Record<string, string> {
  return {
    AGENTRAIL_BASE_URL: baseUrl,
    AGENTRAIL_API_KEY: apiKey,
    AGENTRAIL_API_KEY_ID: apiKeyId,
    AGENTRAIL_AGENT_ID: agentId,
    AGENTRAIL_AGENT_RUNNER: runner,
    AGENTRAIL_REPO_ALLOWLIST: repoAllowlist.join(","),
    AGENTRAIL_AGENT_RECIPE_PATH: instructionsPath,
  };
}

async function writeAgentEnvFileAtPath(filePath: string, values: Record<string, string>) {
  await mkdir(path.dirname(filePath), { recursive: true });
  const content = [
    ...Object.entries(values).map(([key, value]) => `${key}=${value}`),
    "",
  ].join("\n");
  await writeFile(filePath, content, { mode: 0o600 });
  return filePath;
}

async function readAgentEnvFile({
  cwd,
  homePath,
  explicitEnvFile,
  agentId,
}: {
  cwd: string;
  homePath: string;
  explicitEnvFile?: string;
  agentId?: string;
}): Promise<{ path: string | null; values: AgentEnvValues }> {
  const candidates = [
    explicitEnvFile ? path.resolve(cwd, explicitEnvFile) : null,
    agentId ? managedAgentEnvPathForHome(homePath, agentId) : null,
    currentAgentEnvPathForHome(homePath),
  ].filter((value): value is string => Boolean(value));

  for (const filePath of candidates) {
    try {
      const content = await readFile(filePath, "utf8");
      return {
        path: filePath,
        values: parseEnvFile(content),
      };
    } catch {
      continue;
    }
  }

  return { path: null, values: {} };
}

async function readOperatorEnvFile(homePath: string): Promise<AgentEnvValues> {
  try {
    const content = await readFile(operatorEnvPathForHome(homePath), "utf8");
    return parseEnvFile(content);
  } catch {
    return {};
  }
}

async function getJson<T>({
  baseUrl,
  route,
  bearerToken,
}: {
  baseUrl: string;
  route: string;
  bearerToken?: string;
}) {
  const response = await fetch(new URL(route.replace(/^\//, ""), `${baseUrl}/`), {
    headers: {
      accept: "application/json",
      ...(bearerToken ? { authorization: `Bearer ${bearerToken}` } : {}),
    },
  });
  const text = await response.text();
  try {
    return {
      status: response.status,
      json: text ? JSON.parse(text) as T : null,
    };
  } catch {
    return {
      status: response.status,
      json: null,
    };
  }
}

async function requestJson<T = any>({
  baseUrl,
  route,
  bearerToken,
  method,
  idempotencyKey,
  body,
  timeoutMs = 30_000,
}: {
  baseUrl: string;
  route: string;
  bearerToken?: string;
  method: string;
  idempotencyKey: string;
  body: unknown;
  timeoutMs?: number;
}): Promise<{ status: number; json: T | null }> {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const response = await fetch(new URL(route.replace(/^\//, ""), `${baseUrl}/`), {
      method,
      headers: {
        "content-type": "application/json",
        "idempotency-key": idempotencyKey,
        ...(bearerToken ? { authorization: `Bearer ${bearerToken}` } : {}),
      },
      body: JSON.stringify(body),
      signal: controller.signal,
    });
    const text = await response.text();
    const json = text ? JSON.parse(text) : null;
    if (!response.ok) {
      throw new Error(json?.error?.message ?? `HTTP ${response.status}`);
    }
    return {
      status: response.status,
      json,
    };
  } catch (error) {
    if (isAbortError(error)) {
      throw new Error(`Request timed out after ${Math.round(timeoutMs / 1000)}s.`);
    }
    throw error;
  } finally {
    clearTimeout(timeoutId);
  }
}

function isAbortError(error: unknown): boolean {
  return typeof error === "object" && error !== null && "name" in error && error.name === "AbortError";
}

function renderCreateRecoveryBlock({
  agentId,
  keyId,
  completedSteps,
}: {
  agentId: string;
  keyId: string;
  completedSteps: string[];
}): string {
  const lines = [
    "Create partially succeeded on the server.",
    `- agentId: ${agentId}`,
    `- apiKeyId: ${keyId}`,
    `- completedSteps: ${completedSteps.join(", ") || "none"}`,
    `- recovery: agentrail agent update --agent-id ${agentId} --api-key-id ${keyId}`,
    "",
  ];
  return `${lines.join("\n")}\n`;
}

async function readSetupConfig(configPath: string): Promise<SetupConfigLike | null> {
  try {
    const content = await readFile(configPath, "utf8");
    return JSON.parse(content) as SetupConfigLike;
  } catch {
    return null;
  }
}

function parseEnvFile(content: string): AgentEnvValues {
  const parsed: Record<string, string> = {};
  for (const rawLine of content.split(/\r?\n/u)) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;
    const separatorIndex = line.indexOf("=");
    if (separatorIndex === -1) continue;
    parsed[line.slice(0, separatorIndex).trim()] = line.slice(separatorIndex + 1).trim().replace(/^"(.*)"$/u, "$1").replace(/^'(.*)'$/u, "$1");
  }
  return parsed as AgentEnvValues;
}

function parseCsv(value: string | undefined): string[] {
  if (!value) return [];
  return value.split(",").map((part) => part.trim()).filter(Boolean);
}

async function resolveAgentScopes({
  flags,
  prompt,
  mode,
  currentScopes,
}: {
  flags: AgentCreateFlags;
  prompt: PromptSession | null;
  mode: "create" | "update";
  currentScopes: string[];
}): Promise<string[]> {
  if (flags.scopes?.length) {
    return normalizeScopeList(flags.scopes);
  }

  if (!prompt) {
    const preset = normalizePermissionPreset(flags.permissionPreset, flags.enableShip);
    if (preset === "advanced") {
      throw new Error("`--permission-preset advanced` requires `--scopes` when run non-interactively.");
    }
    return presetScopes(preset);
  }

  const presetChoices: PromptChoice[] = [
    {
      value: "read_only",
      label: "Read only",
      hint: "View tasks, CI, reviews, and events.",
    },
    {
      value: "read_write",
      label: "Read and write",
      hint: "View tasks and submit work updates.",
    },
    {
      value: "read_write_ship",
      label: "Read, write, and ship",
      hint: "Includes ship/release actions.",
    },
    {
      value: "advanced",
      label: "Advanced",
      hint: "Pick exact scopes directly.",
    },
  ];
  const defaultPreset = flags.permissionPreset
    ? normalizePermissionPreset(flags.permissionPreset, flags.enableShip)
    : mode === "create"
      ? "read_write"
      : inferPermissionPreset(currentScopes);
  await describeCreateStep(prompt, "Permissions", "Choose what this agent is allowed to do in AgentRail.");
  const selectedPreset = await prompt.select({
    message: "Permissions",
    choices: presetChoices,
    defaultValue: defaultPreset,
  }) as PermissionPreset;

  let scopes: string[];
  if (selectedPreset !== "advanced") {
    scopes = presetScopes(selectedPreset);
  } else {
    const defaultCommonScopes = currentScopes.filter((scope) => COMMON_ADVANCED_SCOPES.includes(scope));
    const commonScopes = await prompt.multiselect({
      message: "Choose common agent permissions",
      defaultValues: defaultCommonScopes,
      required: true,
      choices: COMMON_ADVANCED_SCOPES.map((scope) => ({
        value: scope,
        label: scope,
        hint: describeScope(scope),
      })),
    });
    scopes = normalizeScopeList(commonScopes);
    const hasExpandedDefaults = currentScopes.some((scope) => EXPANDED_ADVANCED_SCOPES.includes(scope));
    const showExpanded = await prompt.confirm({
      message: "Show additional advanced permissions?",
      defaultValue: hasExpandedDefaults,
    });
    if (showExpanded) {
      const defaultExpandedScopes = currentScopes.filter((scope) => EXPANDED_ADVANCED_SCOPES.includes(scope));
      const expandedScopes = await prompt.multiselect({
        message: "Choose additional advanced permissions",
        defaultValues: defaultExpandedScopes,
        required: false,
        choices: EXPANDED_ADVANCED_SCOPES.map((scope) => ({
          value: scope,
          label: scope,
          hint: describeScope(scope),
        })),
      });
      scopes = normalizeScopeList([...scopes, ...expandedScopes]);
    }
  }

  await prompt.note({
    title: "Permissions selected",
    body: scopes.map((scope) => `- ${scope} — ${describeScope(scope)}`).join("\n"),
  });
  return scopes;
}

async function describeCreateStep(prompt: PromptSession | null, title: string, description: string): Promise<void> {
  if (!prompt) return;
  await prompt.message(`${title}: ${description}`);
}

function showOptionalList(values: string[]): string {
  return values.length > 0 ? values.join(", ") : "None";
}

function roleOptionFor(role: string) {
  return ROLE_OPTIONS.find((option) => option.value === role);
}

function describeRole(role: string): string {
  const match = roleOptionFor(role);
  return match ? `${match.label} (${match.value})` : role;
}

function describeRoleHint(role: string): string | null {
  const match = roleOptionFor(role);
  return match?.hint ?? null;
}

async function showCreateReview({
  prompt,
  inputs,
  runnerCheck,
}: {
  prompt: PromptSession;
  inputs: AgentCommandInputs;
  runnerCheck: { ok: boolean; message: string };
}): Promise<void> {
  const runnerDefinition = runnerDefinitionFor(inputs.runner);
  await prompt.note({
    title: "Review agent setup",
    body: [
      `- Agent name: ${inputs.name}`,
      `- Runner: ${runnerDefinition.label}`,
      `- Role: ${describeRole(inputs.role)}`,
      ...(describeRoleHint(inputs.role) ? [`  ${describeRoleHint(inputs.role)}`] : []),
      `- Permissions: ${inputs.scopes.join(", ")}`,
      `- GitHub repo: ${inputs.primaryRepoUrl}`,
      `- Skills: ${showOptionalList(inputs.capabilityTags)}`,
      `- Ownership areas: ${showOptionalList(inputs.ownershipTags)}`,
      `- Task capacity: ${inputs.maxConcurrentTasks}`,
      `- Instructions file: ${inputs.instructionsPath}`,
      `- Generated agent id: ${inputs.agentId}`,
      `- Runner check: ${runnerCheck.message}`,
    ].join("\n"),
  });
}

async function resolvePrimaryRepo({
  flags,
  prompt,
  agentName,
  defaultRepo,
  connectedRepos,
}: {
  flags: AgentCreateFlags;
  prompt: PromptSession | null;
  agentName: string;
  defaultRepo: string;
  connectedRepos: ConnectedRepo[];
}): Promise<{ slug: string; url: string; path: string }> {
  const initialValue = flags.repoAllowlist?.[0] ?? defaultRepo;
  const normalized = normalizeRepoInput(initialValue, connectedRepos);
  if (!prompt) {
    return normalized;
  }

  await describeCreateStep(prompt, "Repo", `Choose the GitHub repo ${agentName} should work in. You can add more repos later with \`agentrail agent update\`.`);
  let current = toGitHubUrl(normalized.slug);
  while (true) {
    const raw = await prompt.input({
      message: `Which repo should ${agentName} work in?`,
      defaultValue: current,
    });
    try {
      return normalizeRepoInput(raw, connectedRepos);
    } catch (error) {
      await prompt.message(error instanceof Error ? error.message : String(error));
      current = raw;
    }
  }
}

async function resolveStructuredTags({
  prompt,
  values,
  message,
  description,
  options,
  required = true,
  defaultValues = [],
}: {
  prompt: PromptSession | null;
  values?: string[];
  message: string;
  description: string;
  options: string[];
  required?: boolean;
  defaultValues?: string[];
}): Promise<string[]> {
  if (values?.length) return normalizeTagList(values);
  if (!prompt) return normalizeTagList(defaultValues);

  await describeCreateStep(prompt, required ? "Skills" : "Ownership areas", description);
  await prompt.message("Use Space to select more than one item, then press Enter to continue.");
  const selected = await prompt.multiselect({
    message,
    required,
    choices: [
      ...options.map((value) => ({ value, label: value })),
      { value: "__custom__", label: "Advanced: custom tags", hint: "Add your own tags." },
    ],
    defaultValues,
  });
  const wantsCustom = selected.includes("__custom__");
  const baseSelections = selected.filter((value) => value !== "__custom__");
  if (!wantsCustom) {
    return normalizeTagList(baseSelections);
  }
  const customRaw = await prompt.input({
    message: "Custom tags (comma-separated)",
    defaultValue: "",
  });
  return normalizeTagList([...baseSelections, ...parseCsv(customRaw)]);
}

async function resolveCreateRole({
  flags,
  prompt,
  agentName,
}: {
  flags: AgentCreateFlags;
  prompt: PromptSession | null;
  agentName: string;
}): Promise<string> {
  if (flags.role) return flags.role;
  if (!prompt) return "coding_agent";

  await describeCreateStep(
    prompt,
    "Role",
    `Choose ${agentName}'s main job in AgentRail. Skills are more specific and help AgentRail decide what kinds of tasks ${agentName} can handle well.`,
  );
  await prompt.note({
    title: "Role guide",
    body: ROLE_OPTIONS.map((role) => `- ${role.label}: ${role.hint}`).join("\n"),
  });
  return await prompt.select({
    message: `What is ${agentName}'s main role?`,
    defaultValue: "coding_agent",
    choices: ROLE_OPTIONS.map((role) => ({
      value: role.value,
      label: role.label,
      hint: role.hint,
    })),
  }) as RoleValue;
}

async function resolveCreateCapacity({
  flags,
  prompt,
  agentName,
}: {
  flags: AgentCreateFlags;
  prompt: PromptSession | null;
  agentName: string;
}): Promise<number> {
  if (typeof flags.maxConcurrentTasks === "number" && Number.isFinite(flags.maxConcurrentTasks)) {
    return flags.maxConcurrentTasks;
  }
  if (!prompt) return 1;

  await describeCreateStep(prompt, "Capacity", "Lower values keep the agent more focused. Higher values increase throughput but add context switching.");
  const selected = await prompt.select({
    message: `How many tasks can ${agentName} handle at once?`,
    defaultValue: "1",
    choices: [
      { value: "1", label: "1 task (Recommended)", hint: "Best for focused specialist agents." },
      { value: "2", label: "2 tasks", hint: "Useful for light parallel work with limited overlap." },
      { value: "3", label: "3 tasks", hint: "More throughput, more context switching." },
      { value: "5", label: "5 tasks", hint: "Broad utility mode, easiest to overload." },
    ],
  });
  return Number.parseInt(selected, 10);
}

function normalizeRepoInput(value: string, connectedRepos: ConnectedRepo[]): { slug: string; url: string; path: string } {
  const trimmed = value.trim();
  if (!trimmed) {
    throw new Error("Enter a GitHub repo URL like https://github.com/owner/repo.");
  }
  if (/^https?:\/\//iu.test(trimmed)) {
    try {
      const url = new URL(trimmed);
      if (url.hostname !== "github.com") {
        throw new Error("Use a GitHub repo URL like https://github.com/owner/repo.");
      }
      const parts = url.pathname.replace(/^\/+|\/+$/gu, "").split("/");
      if (parts.length < 2 || !parts[0] || !parts[1]) {
        throw new Error("Use a GitHub repo URL like https://github.com/owner/repo.");
      }
      const slug = `${parts[0]}/${parts[1]}`;
      return { slug, url: toGitHubUrl(slug), path: findRepoPath(connectedRepos, slug) ?? connectedRepos[0]?.path ?? process.cwd() };
    } catch (error) {
      if (error instanceof Error) throw error;
      throw new Error("Use a GitHub repo URL like https://github.com/owner/repo.");
    }
  }
  if (/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/u.test(trimmed)) {
    return { slug: trimmed, url: toGitHubUrl(trimmed), path: findRepoPath(connectedRepos, trimmed) ?? connectedRepos[0]?.path ?? process.cwd() };
  }
  throw new Error("Use a GitHub repo URL like https://github.com/owner/repo.");
}

function toGitHubUrl(slug: string): string {
  return `https://github.com/${slug.replace(/^\/+|\/+$/gu, "")}`;
}

function findRepoPath(repos: ConnectedRepo[], slug: string): string | null {
  return repos.find((repo) => repo.slug === slug)?.path ?? null;
}

function normalizeTagList(values: string[]): string[] {
  return [...new Set(values.map((value) => value.trim()).filter(Boolean))];
}

function runnerDefinitionFor(runner: string): RunnerDefinition {
  return RUNNER_DEFINITIONS.find((definition) => definition.value === runner)
    ?? { value: runner, label: runner, description: "Custom local runner.", signInHint: `Make sure you are already signed in to ${runner} on this machine.` };
}

function verifyRunnerReadiness(runner: string): { ok: boolean; message: string } {
  const definition = runnerDefinitionFor(runner);
  if (!definition.executable) {
    return {
      ok: false,
      message: `Runner check skipped for ${definition.label}. ${definition.signInHint}`,
    };
  }

  const result = spawnSync(definition.executable, ["--version"], {
    stdio: "ignore",
    encoding: "utf8",
  });
  if (result.error && "code" in result.error && result.error.code === "ENOENT") {
    return {
      ok: false,
      message: `${definition.label} was not found on this machine. Install it first, then make sure you are already signed in.`,
    };
  }

  return {
    ok: true,
    message: `${definition.label} looks available. ${definition.signInHint}`,
  };
}

function normalizePermissionPreset(value: string | undefined, enableShip?: boolean): PermissionPreset {
  if (value) {
    if (PERMISSION_PRESET_VALUES.includes(value as PermissionPreset)) {
      return value as PermissionPreset;
    }
    throw new Error(`Unsupported permission preset: ${value}`);
  }
  return enableShip ? "read_write_ship" : "read_write";
}

function presetScopes(preset: PermissionPreset): string[] {
  switch (preset) {
    case "read_only":
      return [...READ_ONLY_SCOPE_PRESET];
    case "read_write":
      return [...READ_WRITE_SCOPE_PRESET];
    case "read_write_ship":
      return [...READ_WRITE_SHIP_SCOPE_PRESET];
    case "advanced":
      return [...READ_WRITE_SCOPE_PRESET];
  }
}

function inferPermissionPreset(scopes: string[]): PermissionPreset {
  const normalized = normalizeScopeList(scopes);
  if (sameScopes(normalized, READ_ONLY_SCOPE_PRESET)) return "read_only";
  if (sameScopes(normalized, READ_WRITE_SCOPE_PRESET)) return "read_write";
  if (sameScopes(normalized, READ_WRITE_SHIP_SCOPE_PRESET)) return "read_write_ship";
  return "advanced";
}

function sameScopes(left: string[], right: string[]): boolean {
  return left.length === right.length && left.every((scope, index) => scope === normalizeScopeList(right)[index]);
}

function describeScope(scope: string): string {
  switch (scope) {
    case "tasks:read":
      return "Read assigned tasks.";
    case "tasks:write":
      return "Submit task updates and work.";
    case "ci:read":
      return "Read CI status.";
    case "reviews:read":
      return "Read review feedback.";
    case "events:read":
      return "Read task event history.";
    case "ship:write":
      return "Perform ship or release actions.";
    case "routing:read":
      return "Read routing state.";
    case "routing:evaluate":
      return "Run routing evaluations.";
    case "routing:admin":
      return "Change routing rules and profiles.";
    case "usage:read":
      return "Read API key usage details.";
    case "webhooks:read":
      return "Read webhook data.";
    case "webhooks:write":
      return "Create or change webhook state.";
    case "auth:admin":
      return "Create and rotate AgentRail API keys.";
    default:
      return "Advanced AgentRail permission.";
  }
}

function normalizeScopeList(scopes: string[]): string[] {
  const normalized = [...new Set(scopes.map((scope) => scope.trim()).filter(Boolean))].sort();
  const invalid = normalized.find((scope) => !SUPPORTED_SCOPES.has(scope));
  if (invalid) {
    throw new Error(`Unsupported scope: ${invalid}`);
  }
  return normalized;
}

function generateAgentId(runner: string, displayName: string): string {
  const runnerSlug = runner.toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_+|_+$/g, "") || "agent";
  const nameSlug = displayName.toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_+|_+$/g, "").slice(0, 24) || "local";
  const suffix = crypto.randomBytes(4).toString("hex");
  return `agt_${runnerSlug}_${nameSlug}_${suffix}`;
}

function warnPrivilegedScopes(scopes: string[], output: Writer): void {
  const dangerous = scopes.filter((scope) => PRIVILEGED_SCOPES.has(scope));
  if (dangerous.length > 0) {
    output.write(`Warning: privileged scopes selected: ${dangerous.join(", ")}.\n`);
  }
}

function renderRunnerCommand(runner: string, envFilePath: string, repoPath: string): string {
  if (runner === "claude-code") {
    return `source ${envFilePath} && cd ${repoPath} && claude --append-system-prompt-file "$AGENTRAIL_AGENT_RECIPE_PATH"`;
  }
  if (runner === "cursor") {
    return `source ${envFilePath} && cursor ${repoPath}`;
  }
  return `source ${envFilePath} && cd ${repoPath} && ${runner}`;
}

function renderAgentCreateUsage(): string {
  return [
    "Usage:",
    "  agentrail agent create [flags]",
    "",
    "Flags:",
    "  --setup-api-key <key>",
    "  --base-url <url>",
    "  --agent-id <agt_...>",
    "  --env-file <path>",
    "  --name <display name>",
    "  --runner <codex|claude-code|cursor|devin|custom>",
    "  --permission-preset <read_only|read_write|read_write_ship|advanced>",
    "  --scopes <comma,separated>",
    "  --repo-allowlist <owner/repo,...>",
    "  --capability-tags <tag,...>",
    "  --ownership-tags <tag,...>",
    "  --configure-routing",
    "",
  ].join("\n");
}

function renderAgentUpdateUsage(): string {
  return [
    "Usage:",
    "  agentrail agent update --agent-id <agt_...> [flags]",
    "",
    "Flags:",
    "  --setup-api-key <key>",
    "  --base-url <url>",
    "  --env-file <path>",
    "  --api-key-id <akey_...>",
    "  --name <display name>",
    "  --role <role>",
    "  --permission-preset <read_only|read_write|read_write_ship|advanced>",
    "  --scopes <comma,separated>",
    "  --configure-routing",
    "",
  ].join("\n");
}

function nextValue(argv: string[], index: number, flag: string): string {
  const value = argv[index];
  if (!value || value.startsWith("--")) {
    throw new Error(`${flag} requires a value.`);
  }
  return value;
}

function defaultInstructionsPath(homePath: string): string {
  return recipePathForHome(homePath);
}

function toDisplayName(runner: string): string {
  return runner.split(/[-_]/u).map((part) => part.slice(0, 1).toUpperCase() + part.slice(1)).join(" ") + " Local";
}

function stripTrailingSlash(value: string): string {
  return value.replace(/\/+$/, "");
}
