import { createHash } from "node:crypto";
import { chmod, lstat, mkdir, readdir, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";

export type RunnerPolicyPreset = "strict" | "balanced" | "advisory" | "external_sandbox";
export type RunnerPolicyStrength = "enforced" | "partial" | "advisory" | "unsupported";
export type RunnerPolicyArea = "filesystem" | "network" | "credentials" | "publish" | "commands" | "config";

export interface RunnerExecutionPolicy {
  preset: RunnerPolicyPreset;
  enforcementMode: "strict" | "partial" | "advisory";
  filesystem: {
    worktree: "read" | "write";
    runDir: "none" | "read" | "write";
    extraReadablePaths: string[];
    extraWritablePaths: string[];
    denyReadGlobs: string[];
    denyWriteGlobs: string[];
  };
  network: {
    mode: "none" | "agentrail_local_only" | "allowlist" | "unrestricted";
    allowedHosts: string[];
  };
  credentials: {
    inherit: "none" | "allowlist";
    allowEnv: string[];
    denyEnvPatterns: string[];
  };
  publish: {
    mode: "agentrail_owned" | "direct_allowed";
  };
  commands: {
    deny: string[];
    allow?: string[];
  };
  externalSandbox?: {
    command: string[];
  };
}

export interface RunnerPolicyGeneratedFile {
  path: string;
  content: string;
  mode?: number;
}

export interface RunnerPolicyEnforcementItem {
  area: RunnerPolicyArea;
  strength: RunnerPolicyStrength;
  detail: string;
  critical?: boolean;
}

export interface RunnerPolicyPlan {
  runner: string;
  enforcementMode: RunnerExecutionPolicy["enforcementMode"];
  executable: string;
  args: string[];
  cwd: string;
  env: NodeJS.ProcessEnv;
  generatedFiles: RunnerPolicyGeneratedFile[];
  filesystemPolicy: RunnerPolicyFilesystemPlan;
  enforcement: RunnerPolicyEnforcementItem[];
  manualContinuationAllowed: boolean;
}

export interface RunnerPolicyFilesystemPlan {
  enforceDeniedPaths: boolean;
  readableRoots: string[];
  writableRoots: string[];
  denyReadGlobs: string[];
  denyWriteGlobs: string[];
}

export interface RunnerPolicyFilesystemSnapshotEntry {
  path: string;
  root: string;
  relativePath: string;
  type: string;
  digest: string;
  mode?: number;
  fileContentBase64?: string;
}

export interface RunnerPolicyFilesystemSnapshot {
  entries: Record<string, RunnerPolicyFilesystemSnapshotEntry>;
}

export interface RunnerPolicyFilesystemCheckResult {
  ok: boolean;
  reason: string | null;
  summary: string;
  matches: string[];
  snapshot: RunnerPolicyFilesystemSnapshot;
}

export interface CompileRunnerExecutionPlanParams {
  runner: string;
  model: string | null;
  policy?: RunnerExecutionPolicy | RunnerExecutionPolicyLike | null;
  worktreePath: string;
  runDir: string;
  recipePath: string;
  prompt: string;
  baseEnv: NodeJS.ProcessEnv;
  values: NodeJS.ProcessEnv;
}

export interface RunnerPolicyValidationResult {
  ok: boolean;
  reasons: string[];
}

export type RunnerExecutionPolicyLike = Partial<{
  preset: unknown;
  enforcementMode: unknown;
  filesystem: Partial<{
    worktree: unknown;
    runDir: unknown;
    extraReadablePaths: unknown;
    extraWritablePaths: unknown;
    denyReadGlobs: unknown;
    denyWriteGlobs: unknown;
  }>;
  network: Partial<{
    mode: unknown;
    allowedHosts: unknown;
  }>;
  credentials: Partial<{
    inherit: unknown;
    allowEnv: unknown;
    denyEnvPatterns: unknown;
  }>;
  publish: Partial<{
    mode: unknown;
  }>;
  commands: Partial<{
    deny: unknown;
    allow: unknown;
  }>;
  externalSandbox: Partial<{
    command: unknown;
  }>;
}>;

const DEFAULT_DENY_ENV_PATTERNS = [
  "AGENTRAIL_API_KEY",
  "AGENTRAIL_API_KEY_ID",
  "AGENTRAIL_ADMIN_API_KEY",
  "AGENTRAIL_OPERATOR_API_KEY",
  "AGENTRAIL_OPERATOR_KEY",
  "AGENTRAIL_OPERATOR_KEY_ID",
  "AGENTRAIL_SETUP_API_KEY",
  "GITHUB_TOKEN",
  "GH_TOKEN",
  "GITHUB_WEBHOOK_SECRET",
  "CIRCLECI_TOKEN",
  "CIRCLECI_WEBHOOK_SECRET",
  "LINEAR_API_KEY",
  "LINEAR_WEBHOOK_SECRET",
  "*_WEBHOOK_SECRET",
];

const CORE_ENV_ALLOWLIST = [
  "CI",
  "COLORTERM",
  "HOME",
  "LANG",
  "LC_ALL",
  "LC_CTYPE",
  "LOGNAME",
  "PATH",
  "PWD",
  "SHELL",
  "TEMP",
  "TERM",
  "TMP",
  "TMPDIR",
  "USER",
  "XDG_CACHE_HOME",
  "XDG_CONFIG_HOME",
  "XDG_DATA_HOME",
];

const DEFAULT_COMMAND_DENY = [
  "git push",
  "gh pr create",
  "gh pr merge",
  "gh pr close",
  "gh release create",
  "agentrail tasks submit",
  "agentrail tasks ship",
  "agentrail ship",
];

const CODEX_ARG_ENV_DENY_PATTERNS = [
  "*TOKEN*",
  "*SECRET*",
  "*PASSWORD*",
  "*API_KEY*",
  "*PRIVATE_KEY*",
  "*KEY*",
];

const DEFAULT_DENY_WRITE_GLOBS = [
  ".env",
  ".env.*",
  "**/.env",
  "**/.env.*",
  "AGENTS.md",
  "**/AGENTS.md",
  "CLAUDE.md",
  "**/CLAUDE.md",
  ".agentrail/**",
  ".codex/**",
  ".claude/**",
  ".cursor/rules/**",
];

const RECOVERABLE_INSTRUCTION_FILE_GLOBS = [
  "AGENTS.md",
  "**/AGENTS.md",
  "CLAUDE.md",
  "**/CLAUDE.md",
];

export const DEFAULT_RUNNER_EXECUTION_POLICY: RunnerExecutionPolicy = {
  preset: "strict",
  enforcementMode: "strict",
  filesystem: {
    worktree: "write",
    runDir: "write",
    extraReadablePaths: [],
    extraWritablePaths: [],
    denyReadGlobs: [".env", ".env.*", "**/.env", "**/.env.*", "**/*secret*", "**/*credential*"],
    denyWriteGlobs: DEFAULT_DENY_WRITE_GLOBS,
  },
  network: {
    mode: "agentrail_local_only",
    allowedHosts: ["127.0.0.1", "localhost", "::1"],
  },
  credentials: {
    inherit: "none",
    allowEnv: CORE_ENV_ALLOWLIST,
    denyEnvPatterns: DEFAULT_DENY_ENV_PATTERNS,
  },
  publish: {
    mode: "agentrail_owned",
  },
  commands: {
    deny: DEFAULT_COMMAND_DENY,
  },
};

export function normalizeRunnerExecutionPolicy(value: RunnerExecutionPolicyLike | RunnerExecutionPolicy | null | undefined): RunnerExecutionPolicy {
  const source = isRecord(value) ? value : {};
  const defaults = DEFAULT_RUNNER_EXECUTION_POLICY;
  const preset = enumValue(source.preset, ["strict", "balanced", "advisory", "external_sandbox"], defaults.preset);
  const enforcementMode = enumValue(
    source.enforcementMode,
    ["strict", "partial", "advisory"],
    preset === "advisory" ? "advisory" : preset === "external_sandbox" ? "partial" : defaults.enforcementMode,
  );
  const filesystem = isRecord(source.filesystem) ? source.filesystem : {};
  const network = isRecord(source.network) ? source.network : {};
  const credentials = isRecord(source.credentials) ? source.credentials : {};
  const publish = isRecord(source.publish) ? source.publish : {};
  const commands = isRecord(source.commands) ? source.commands : {};
  const externalSandbox = isRecord(source.externalSandbox) ? source.externalSandbox : null;

  return {
    preset,
    enforcementMode,
    filesystem: {
      worktree: enumValue(filesystem.worktree, ["read", "write"], defaults.filesystem.worktree),
      runDir: enumValue(filesystem.runDir, ["none", "read", "write"], defaults.filesystem.runDir),
      extraReadablePaths: stringList(filesystem.extraReadablePaths, defaults.filesystem.extraReadablePaths),
      extraWritablePaths: stringList(filesystem.extraWritablePaths, defaults.filesystem.extraWritablePaths),
      denyReadGlobs: stringList(filesystem.denyReadGlobs, defaults.filesystem.denyReadGlobs),
      denyWriteGlobs: stringList(filesystem.denyWriteGlobs, defaults.filesystem.denyWriteGlobs),
    },
    network: {
      mode: enumValue(network.mode, ["none", "agentrail_local_only", "allowlist", "unrestricted"], defaults.network.mode),
      allowedHosts: stringList(network.allowedHosts, defaults.network.allowedHosts),
    },
    credentials: {
      inherit: enumValue(credentials.inherit, ["none", "allowlist"], defaults.credentials.inherit),
      allowEnv: stringList(credentials.allowEnv, defaults.credentials.allowEnv),
      denyEnvPatterns: stringList(credentials.denyEnvPatterns, defaults.credentials.denyEnvPatterns),
    },
    publish: {
      mode: enumValue(publish.mode, ["agentrail_owned", "direct_allowed"], defaults.publish.mode),
    },
    commands: {
      deny: stringList(commands.deny, defaults.commands.deny),
      ...(Array.isArray(commands.allow) ? { allow: stringList(commands.allow, []) } : {}),
    },
    ...(externalSandbox ? { externalSandbox: { command: stringList(externalSandbox.command, []) } } : {}),
  };
}

export async function writeRunnerPolicyGeneratedFiles(plan: RunnerPolicyPlan): Promise<void> {
  for (const file of plan.generatedFiles) {
    await mkdir(path.dirname(file.path), { recursive: true });
    await writeFile(file.path, file.content, { encoding: "utf8", mode: file.mode ?? 0o600 });
  }
}

export async function validateRunnerPolicyFilesystemPreflight(plan: RunnerPolicyPlan): Promise<RunnerPolicyFilesystemCheckResult> {
  const emptySnapshot = emptyFilesystemSnapshot();
  if (!plan.filesystemPolicy.enforceDeniedPaths || plan.enforcementMode === "advisory") {
    return {
      ok: true,
      reason: null,
      summary: "Runner filesystem policy does not require AgentRail deny-path preflight.",
      matches: [],
      snapshot: emptySnapshot,
    };
  }

  const deniedReadMatches = await findMatchingPaths(
    plan.filesystemPolicy.readableRoots,
    plan.filesystemPolicy.denyReadGlobs,
  );
  if (deniedReadMatches.length > 0) {
    return {
      ok: false,
      reason: "runner_policy_denied_files_present",
      summary: `Runner policy denied read paths are present before launch: ${formatPathList(deniedReadMatches)}.`,
      matches: deniedReadMatches,
      snapshot: emptySnapshot,
    };
  }

  const snapshot = await snapshotMatchingPaths(
    plan.filesystemPolicy.writableRoots,
    plan.filesystemPolicy.denyWriteGlobs,
  );
  return {
    ok: true,
    reason: null,
    summary: "Runner filesystem policy preflight passed.",
    matches: [],
    snapshot,
  };
}

export async function hardenProtectedInstructionFiles(plan: RunnerPolicyPlan): Promise<void> {
  if (!plan.filesystemPolicy.enforceDeniedPaths || plan.enforcementMode === "advisory") {
    return;
  }
  const snapshot = await snapshotMatchingPaths(
    plan.filesystemPolicy.writableRoots,
    RECOVERABLE_INSTRUCTION_FILE_GLOBS,
  );
  for (const entry of Object.values(snapshot.entries)) {
    if (entry.type !== "file" || typeof entry.mode !== "number") {
      continue;
    }
    await chmod(entry.path, entry.mode & ~0o222);
  }
}

export async function validateRunnerPolicyFilesystemPostRun(
  plan: RunnerPolicyPlan,
  before: RunnerPolicyFilesystemSnapshot | null | undefined,
): Promise<RunnerPolicyFilesystemCheckResult> {
  const baseline = before ?? emptyFilesystemSnapshot();
  if (!plan.filesystemPolicy.enforceDeniedPaths || plan.enforcementMode === "advisory") {
    return {
      ok: true,
      reason: null,
      summary: "Runner filesystem policy does not require AgentRail deny-path post-run validation.",
      matches: [],
      snapshot: baseline,
    };
  }

  let after = await snapshotMatchingPaths(
    plan.filesystemPolicy.writableRoots,
    plan.filesystemPolicy.denyWriteGlobs,
  );
  const restoredModes = await restoreRecoverableInstructionModes(baseline, after);
  if (restoredModes) {
    after = await snapshotMatchingPaths(
      plan.filesystemPolicy.writableRoots,
      plan.filesystemPolicy.denyWriteGlobs,
    );
  }
  const changes = compareFilesystemSnapshots(baseline, after);
  if (changes.length === 0) {
    return {
      ok: true,
      reason: null,
      summary: "Runner filesystem policy post-run validation passed.",
      matches: [],
      snapshot: after,
    };
  }

  const repaired = await repairRecoverableInstructionDrift(baseline, after, changes);
  if (repaired) {
    const restored = await snapshotMatchingPaths(
      plan.filesystemPolicy.writableRoots,
      plan.filesystemPolicy.denyWriteGlobs,
    );
    const residualChanges = compareFilesystemSnapshots(baseline, restored);
    if (residualChanges.length === 0) {
      return {
        ok: true,
        reason: null,
        summary: `Runner modified protected instruction files, and AgentRail restored them: ${formatPathList(changes)}.`,
        matches: changes,
        snapshot: restored,
      };
    }
    return {
      ok: false,
      reason: "runner_policy_violation",
      summary: `Runner modified deny-write paths and AgentRail could not fully restore them: ${formatPathList(residualChanges)}.`,
      matches: residualChanges,
      snapshot: restored,
    };
  }

  return {
    ok: false,
    reason: "runner_policy_violation",
    summary: `Runner modified deny-write paths: ${formatPathList(changes)}.`,
    matches: changes,
    snapshot: after,
  };
}

export async function restoreProtectedInstructionFileModes(
  plan: RunnerPolicyPlan,
  before: RunnerPolicyFilesystemSnapshot | null | undefined,
): Promise<void> {
  if (!plan.filesystemPolicy.enforceDeniedPaths || plan.enforcementMode === "advisory") {
    return;
  }
  const baseline = before ?? emptyFilesystemSnapshot();
  const after = await snapshotMatchingPaths(
    plan.filesystemPolicy.writableRoots,
    plan.filesystemPolicy.denyWriteGlobs,
  );
  await restoreRecoverableInstructionModes(baseline, after);
}

export function compileRunnerExecutionPlan(params: CompileRunnerExecutionPlanParams): RunnerPolicyPlan {
  const policy = normalizeRunnerExecutionPolicy(params.policy);
  const env = buildRunnerPolicyEnv(params.baseEnv, params.values, policy);
  const externalSandbox = policy.externalSandbox?.command.filter(Boolean) ?? [];
  const runner = params.runner;
  const directPlan = runner === "codex"
    ? codexPlan(params, policy, env)
    : runner === "claude-code"
      ? claudePlan(params, policy, env)
      : runner === "cursor"
        ? cursorPlan(params, policy, env)
        : customPlan(params, policy, env);

  if (externalSandbox.length === 0) {
    return directPlan;
  }

  return {
    ...directPlan,
    executable: externalSandbox[0],
    args: [...externalSandbox.slice(1), directPlan.executable, ...directPlan.args],
    enforcement: directPlan.enforcement.map((item) => item.strength === "unsupported"
      ? { ...item, strength: "partial", detail: `${item.detail} External sandbox wrapper is configured.` }
      : item),
  };
}

export function validateRunnerPolicyPlan(plan: RunnerPolicyPlan): RunnerPolicyValidationResult {
  if (plan.enforcementMode === "advisory") {
    return {
      ok: true,
      reasons: [],
    };
  }
  const blocking = plan.enforcement.filter((item) => {
    if (item.strength === "unsupported") return true;
    return plan.enforcementMode === "strict" && item.critical === true && item.strength === "partial";
  });
  return {
    ok: blocking.length === 0,
    reasons: blocking.map((item) => `${item.area}: ${item.detail}`),
  };
}

export function buildRunnerPolicyEnv(
  baseEnv: NodeJS.ProcessEnv,
  values: NodeJS.ProcessEnv,
  policyInput?: RunnerExecutionPolicyLike | RunnerExecutionPolicy | null,
): NodeJS.ProcessEnv {
  const policy = normalizeRunnerExecutionPolicy(policyInput);
  const env: NodeJS.ProcessEnv = {};
  const allowed = new Set(policy.credentials.allowEnv);

  for (const [key, envValue] of Object.entries(baseEnv)) {
    if (envValue === undefined) continue;
    if (matchesAnyPattern(key, policy.credentials.denyEnvPatterns)) continue;
    if (policy.credentials.inherit === "none" && !allowed.has(key)) continue;
    if (policy.credentials.inherit === "allowlist" && !allowed.has(key)) continue;
    env[key] = envValue;
  }

  for (const [key, envValue] of Object.entries(values)) {
    if (envValue !== undefined) {
      env[key] = envValue;
    }
  }

  return env;
}

export function renderRunnerPolicySummary(plan: RunnerPolicyPlan): string {
  return plan.enforcement
    .map((item) => `${item.strength.toUpperCase()} ${item.area}: ${item.detail}`)
    .join("\n");
}

function codexPlan(
  params: CompileRunnerExecutionPlanParams,
  policy: RunnerExecutionPolicy,
  env: NodeJS.ProcessEnv,
): RunnerPolicyPlan {
  const shellSet = codexShellEnvironmentSet(env);
  const networkAccess = policy.network.mode === "unrestricted" ? "true" : "false";
  const args = [
    "-a",
    "never",
    "-c",
    "shell_environment_policy.inherit=core",
    "-c",
    `shell_environment_policy.set=${shellSet}`,
    "-c",
    `sandbox_workspace_write.network_access=${networkAccess}`,
    "-c",
    "features.hooks=false",
    "exec",
    "--sandbox",
    policy.filesystem.worktree === "write" ? "workspace-write" : "read-only",
    "--ephemeral",
    "--ignore-user-config",
    "--ignore-rules",
    "--cd",
    params.worktreePath,
    ...(policy.filesystem.runDir === "write" ? ["--add-dir", params.runDir] : []),
    ...policy.filesystem.extraWritablePaths.flatMap((extraPath) => ["--add-dir", extraPath]),
    ...(params.model ? ["--model", params.model] : []),
    "--json",
    "-",
  ];

  return {
    runner: params.runner,
    enforcementMode: policy.enforcementMode,
    executable: "codex",
    args,
    cwd: params.worktreePath,
    env,
    generatedFiles: [],
    filesystemPolicy: buildFilesystemPlan(params, policy, true),
    manualContinuationAllowed: false,
    enforcement: [
      { area: "filesystem", strength: "enforced", detail: "Codex sandbox roots are configured and AgentRail validates denied paths before and after launch.", critical: true },
      { area: "network", strength: "enforced", detail: networkAccess === "true" ? "Codex workspace-write network access is explicitly enabled." : "Codex workspace-write network access is disabled; run context falls back to the local snapshot.", critical: true },
      { area: "credentials", strength: "enforced", detail: "Child environment is built from AgentRail's allowlist and run-scoped values.", critical: true },
      { area: "publish", strength: "enforced", detail: "AgentRail owns branch push and task submission after handoff validation.", critical: true },
      { area: "config", strength: "enforced", detail: "Codex user config, hooks, and execpolicy rules are disabled for the managed run.", critical: true },
      { area: "commands", strength: "partial", detail: "Codex command blocking relies on sandbox, no provider credentials, and AgentRail-owned publish.", critical: false },
    ],
  };
}

function claudePlan(
  params: CompileRunnerExecutionPlanParams,
  policy: RunnerExecutionPolicy,
  env: NodeJS.ProcessEnv,
): RunnerPolicyPlan {
  const settingsPath = path.join(params.runDir, "claude-settings.json");
  const settings = {
    sandbox: {
      enabled: true,
      failIfUnavailable: true,
      allowUnsandboxedCommands: false,
      filesystem: {
        allowWrite: [
          ...(policy.filesystem.worktree === "write" ? [params.worktreePath] : []),
          ...(policy.filesystem.runDir === "write" ? [params.runDir] : []),
          ...policy.filesystem.extraWritablePaths,
        ],
        denyRead: policy.filesystem.denyReadGlobs,
        denyWrite: policy.filesystem.denyWriteGlobs,
      },
      network: {
        allowedDomains: policy.network.mode === "unrestricted" ? ["*"] : policy.network.allowedHosts,
      },
    },
    permissions: {
      deny: [
        ...policy.commands.deny.map((command) => `Bash(${command} *)`),
        ...policy.filesystem.denyReadGlobs.map((glob) => `Read(${glob})`),
        ...policy.filesystem.denyWriteGlobs.map((glob) => `Edit(${glob})`),
      ],
    },
  };
  const args = [
    "--print",
    "--output-format",
    "stream-json",
    "--permission-mode",
    "acceptEdits",
    "--settings",
    settingsPath,
    ...(params.model ? ["--model", params.model] : []),
    "--append-system-prompt-file",
    params.recipePath,
  ];

  return {
    runner: params.runner,
    enforcementMode: policy.enforcementMode,
    executable: "claude",
    args,
    cwd: params.worktreePath,
    env,
    generatedFiles: [{ path: settingsPath, content: `${JSON.stringify(settings, null, 2)}\n` }],
    filesystemPolicy: buildFilesystemPlan(params, policy, false),
    manualContinuationAllowed: false,
    enforcement: [
      { area: "filesystem", strength: "enforced", detail: "Claude sandbox filesystem settings are generated for this run.", critical: true },
      { area: "network", strength: "enforced", detail: "Claude sandbox network allowlist is generated for this run.", critical: true },
      { area: "credentials", strength: "enforced", detail: "Child environment is built from AgentRail's allowlist and run-scoped values.", critical: true },
      { area: "publish", strength: "enforced", detail: "AgentRail owns branch push and task submission after handoff validation.", critical: true },
      { area: "commands", strength: "partial", detail: "Claude deny rules block known direct publish commands; arbitrary shell behavior still depends on sandbox coverage.", critical: false },
      { area: "config", strength: "partial", detail: "AgentRail supplies per-run settings, but Claude may still merge higher-priority managed settings.", critical: false },
    ],
  };
}

function cursorPlan(
  params: CompileRunnerExecutionPlanParams,
  policy: RunnerExecutionPolicy,
  env: NodeJS.ProcessEnv,
): RunnerPolicyPlan {
  const configDir = path.join(params.runDir, "cursor-config");
  const configPath = path.join(configDir, "cli-config.json");
  const cursorConfig = {
    version: 1,
    editor: {
      vimMode: false,
    },
    permissions: {
      allow: [
        "Read(**)",
        "Write(**)",
        "Shell(git)",
        "Shell(npm)",
        "Shell(node)",
        "Shell(agentrail)",
      ],
      deny: [
        ...policy.commands.deny.map((command) => `Shell(${command.split(/\s+/u)[0]})`),
        ...policy.filesystem.denyReadGlobs.map((glob) => `Read(${glob})`),
        ...policy.filesystem.denyWriteGlobs.map((glob) => `Write(${glob})`),
      ],
    },
  };
  const envWithConfig = {
    ...env,
    CURSOR_CONFIG_DIR: configDir,
  };
  const args = [
    "-p",
    "--force",
    "--output-format",
    "stream-json",
    ...(params.model ? ["--model", params.model] : []),
    params.prompt,
  ];

  return {
    runner: params.runner,
    enforcementMode: policy.enforcementMode,
    executable: "cursor-agent",
    args,
    cwd: params.worktreePath,
    env: envWithConfig,
    generatedFiles: [{ path: configPath, content: `${JSON.stringify(cursorConfig, null, 2)}\n` }],
    filesystemPolicy: buildFilesystemPlan(params, policy, false),
    manualContinuationAllowed: policy.enforcementMode !== "strict",
    enforcement: [
      { area: "filesystem", strength: "partial", detail: "Cursor permissions can restrict Read/Write tokens, but no comparable OS-level sandbox was verified.", critical: true },
      { area: "network", strength: "unsupported", detail: "Cursor CLI network isolation is not verified for managed local runs.", critical: true },
      { area: "credentials", strength: "enforced", detail: "Child environment is built from AgentRail's allowlist and run-scoped values.", critical: true },
      { area: "publish", strength: "partial", detail: "AgentRail owns publish, but Cursor shell permissions are command-base based.", critical: true },
      { area: "commands", strength: "partial", detail: "Cursor command permissions are generated, but command-base matching is coarse.", critical: false },
      { area: "config", strength: "partial", detail: "AgentRail supplies an isolated Cursor config dir when supported by the local CLI.", critical: false },
    ],
  };
}

function customPlan(
  params: CompileRunnerExecutionPlanParams,
  policy: RunnerExecutionPolicy,
  env: NodeJS.ProcessEnv,
): RunnerPolicyPlan {
  return {
    runner: params.runner,
    enforcementMode: policy.enforcementMode,
    executable: params.runner,
    args: [params.prompt],
    cwd: params.worktreePath,
    env,
    generatedFiles: [],
    filesystemPolicy: buildFilesystemPlan(params, policy, false),
    manualContinuationAllowed: policy.enforcementMode !== "strict",
    enforcement: [
      { area: "filesystem", strength: "unsupported", detail: `Runner "${params.runner}" has no known AgentRail filesystem policy mapping.`, critical: true },
      { area: "network", strength: "unsupported", detail: `Runner "${params.runner}" has no known AgentRail network policy mapping.`, critical: true },
      { area: "credentials", strength: "enforced", detail: "Child environment is built from AgentRail's allowlist and run-scoped values.", critical: true },
      { area: "publish", strength: "partial", detail: "AgentRail owns publish after handoff, but direct runner side effects cannot be blocked without a known adapter.", critical: true },
      { area: "commands", strength: "unsupported", detail: `Runner "${params.runner}" has no known command policy mapping.`, critical: false },
      { area: "config", strength: "unsupported", detail: `Runner "${params.runner}" has no known config isolation mapping.`, critical: false },
    ],
  };
}

function buildFilesystemPlan(
  params: CompileRunnerExecutionPlanParams,
  policy: RunnerExecutionPolicy,
  enforceDeniedPaths: boolean,
): RunnerPolicyFilesystemPlan {
  const runDirVisible = policy.filesystem.runDir === "write";
  return {
    enforceDeniedPaths,
    readableRoots: uniquePaths([
      params.worktreePath,
      ...(runDirVisible ? [params.runDir] : []),
      ...policy.filesystem.extraReadablePaths,
      ...policy.filesystem.extraWritablePaths,
    ]),
    writableRoots: uniquePaths([
      ...(policy.filesystem.worktree === "write" ? [params.worktreePath] : []),
      ...(policy.filesystem.runDir === "write" ? [params.runDir] : []),
      ...policy.filesystem.extraWritablePaths,
    ]),
    denyReadGlobs: [...policy.filesystem.denyReadGlobs],
    denyWriteGlobs: [...policy.filesystem.denyWriteGlobs],
  };
}

function emptyFilesystemSnapshot(): RunnerPolicyFilesystemSnapshot {
  return { entries: {} };
}

async function findMatchingPaths(roots: string[], patterns: string[]): Promise<string[]> {
  if (patterns.length === 0 || roots.length === 0) return [];
  const matches = new Set<string>();
  for (const root of uniquePaths(roots)) {
    await walkFilesystemRoot(root, patterns, false, async ({ relativePath, matched }) => {
      if (matched) {
        matches.add(relativePath);
      }
    });
  }
  return [...matches].sort((a, b) => a.localeCompare(b));
}

async function snapshotMatchingPaths(roots: string[], patterns: string[]): Promise<RunnerPolicyFilesystemSnapshot> {
  if (patterns.length === 0 || roots.length === 0) return emptyFilesystemSnapshot();
  const entries: Record<string, RunnerPolicyFilesystemSnapshotEntry> = {};
  for (const root of uniquePaths(roots)) {
    await walkFilesystemRoot(root, patterns, true, async ({ absolutePath, relativePath, matched }) => {
      if (!matched) return;
      const entry = await snapshotFilesystemEntry(root, absolutePath, relativePath);
      entries[entry.path] = entry;
    });
  }
  return { entries };
}

async function snapshotFilesystemEntry(
  root: string,
  absolutePath: string,
  relativePath: string,
): Promise<RunnerPolicyFilesystemSnapshotEntry> {
  const stats = await lstat(absolutePath);
  const type = stats.isFile()
    ? "file"
    : stats.isDirectory()
      ? "directory"
      : stats.isSymbolicLink()
        ? "symlink"
        : "other";
  const fileContent = stats.isFile() ? await readFile(absolutePath) : null;
  const digest = fileContent
    ? createHash("sha256").update(fileContent).digest("hex")
    : createHash("sha256")
      .update(`${type}:${stats.size}:${stats.mode}:${stats.mtimeMs}`)
      .digest("hex");
  return {
    path: path.resolve(absolutePath),
    root: path.resolve(root),
    relativePath,
    type,
    digest,
    mode: stats.mode,
    fileContentBase64: fileContent ? fileContent.toString("base64") : undefined,
  };
}

async function walkFilesystemRoot(
  root: string,
  patterns: string[],
  includeMatchedDescendants: boolean,
  visitor: (entry: { absolutePath: string; relativePath: string; matched: boolean }) => Promise<void>,
): Promise<void> {
  const resolvedRoot = path.resolve(root);
  let rootStats;
  try {
    rootStats = await lstat(resolvedRoot);
  } catch (error) {
    if (isNodeErrorWithCode(error, "ENOENT")) return;
    throw error;
  }
  if (!rootStats.isDirectory()) return;

  const stack: Array<{ dirPath: string; relativeDir: string; ancestorMatched: boolean }> = [
    { dirPath: resolvedRoot, relativeDir: "", ancestorMatched: false },
  ];
  while (stack.length > 0) {
    const current = stack.pop();
    if (!current) break;
    let children;
    try {
      children = await readdir(current.dirPath, { withFileTypes: true });
    } catch (error) {
      if (isNodeErrorWithCode(error, "EACCES") || isNodeErrorWithCode(error, "ENOENT")) continue;
      throw error;
    }

    for (const child of children) {
      if (child.name === ".git") continue;
      const absolutePath = path.join(current.dirPath, child.name);
      const relativePath = normalizeRelativePath(path.join(current.relativeDir, child.name));
      const pathMatched = matchesAnyPathGlob(relativePath, patterns);
      const matched = pathMatched || (includeMatchedDescendants && current.ancestorMatched);
      await visitor({ absolutePath, relativePath, matched });
      if (child.isDirectory()) {
        stack.push({
          dirPath: absolutePath,
          relativeDir: relativePath,
          ancestorMatched: includeMatchedDescendants && (current.ancestorMatched || pathMatched),
        });
      }
    }
  }
}

function compareFilesystemSnapshots(
  before: RunnerPolicyFilesystemSnapshot,
  after: RunnerPolicyFilesystemSnapshot,
): string[] {
  const changes: string[] = [];
  const beforeEntries = before.entries;
  const afterEntries = after.entries;
  for (const [entryPath, entry] of Object.entries(afterEntries)) {
    const previous = beforeEntries[entryPath];
    if (!previous) {
      changes.push(`created ${entry.relativePath}`);
    } else if (previous.type !== entry.type || previous.digest !== entry.digest) {
      changes.push(`modified ${entry.relativePath}`);
    }
  }
  for (const [entryPath, entry] of Object.entries(beforeEntries)) {
    if (!afterEntries[entryPath]) {
      changes.push(`deleted ${entry.relativePath}`);
    }
  }
  return [...new Set(changes)].sort((a, b) => a.localeCompare(b));
}

function formatPathList(paths: string[]): string {
  const unique = [...new Set(paths)].sort((a, b) => a.localeCompare(b));
  const visible = unique.slice(0, 10);
  const hiddenCount = unique.length - visible.length;
  return hiddenCount > 0
    ? `${visible.join(", ")} and ${hiddenCount} more`
    : visible.join(", ");
}

async function repairRecoverableInstructionDrift(
  before: RunnerPolicyFilesystemSnapshot,
  after: RunnerPolicyFilesystemSnapshot,
  changes: string[],
): Promise<boolean> {
  const changedEntries = collectChangedEntries(before, after);
  if (changedEntries.length === 0) {
    return false;
  }
  if (changedEntries.some((entry) => !isRecoverableInstructionPath(entry.relativePath))) {
    return false;
  }

  for (const entry of changedEntries) {
    if (!entry.before) {
      await rm(entry.absolutePath, { recursive: true, force: true });
      continue;
    }
    if (entry.before.type !== "file" || !entry.before.fileContentBase64) {
      return false;
    }
    await mkdir(path.dirname(entry.absolutePath), { recursive: true });
    await writeFile(entry.absolutePath, Buffer.from(entry.before.fileContentBase64, "base64"), {
      mode: entry.before.mode,
    });
  }
  return changes.length > 0;
}

async function restoreRecoverableInstructionModes(
  before: RunnerPolicyFilesystemSnapshot,
  after: RunnerPolicyFilesystemSnapshot,
): Promise<boolean> {
  let restoredAny = false;
  for (const [entryPath, previous] of Object.entries(before.entries)) {
    if (!isRecoverableInstructionPath(previous.relativePath)) {
      continue;
    }
    const current = after.entries[entryPath];
    if (!current || previous.type !== "file" || current.type !== "file") {
      continue;
    }
    if (previous.digest !== current.digest) {
      continue;
    }
    if (typeof previous.mode !== "number" || typeof current.mode !== "number") {
      continue;
    }
    if ((previous.mode & 0o777) === (current.mode & 0o777)) {
      continue;
    }
    await chmod(current.path, previous.mode & 0o777);
    restoredAny = true;
  }
  return restoredAny;
}

function collectChangedEntries(
  before: RunnerPolicyFilesystemSnapshot,
  after: RunnerPolicyFilesystemSnapshot,
): Array<{
  absolutePath: string;
  relativePath: string;
  before: RunnerPolicyFilesystemSnapshotEntry | null;
  after: RunnerPolicyFilesystemSnapshotEntry | null;
}> {
  const entryPaths = new Set([
    ...Object.keys(before.entries),
    ...Object.keys(after.entries),
  ]);
  const changed: Array<{
    absolutePath: string;
    relativePath: string;
    before: RunnerPolicyFilesystemSnapshotEntry | null;
    after: RunnerPolicyFilesystemSnapshotEntry | null;
  }> = [];
  for (const entryPath of entryPaths) {
    const previous = before.entries[entryPath] ?? null;
    const next = after.entries[entryPath] ?? null;
    if (previous && next && previous.type === next.type && previous.digest === next.digest) {
      continue;
    }
    changed.push({
      absolutePath: next?.path ?? previous?.path ?? entryPath,
      relativePath: next?.relativePath ?? previous?.relativePath ?? path.basename(entryPath),
      before: previous,
      after: next,
    });
  }
  return changed;
}

function isRecoverableInstructionPath(relativePath: string): boolean {
  return RECOVERABLE_INSTRUCTION_FILE_GLOBS.some((pattern) => matchesPathGlob(relativePath, pattern));
}

function uniquePaths(values: string[]): string[] {
  const result: string[] = [];
  const seen = new Set<string>();
  for (const value of values) {
    const resolved = path.resolve(value);
    if (seen.has(resolved)) continue;
    seen.add(resolved);
    result.push(resolved);
  }
  return result;
}

function normalizeRelativePath(value: string): string {
  return value.split(path.sep).join("/").replace(/^\.\//u, "");
}

function matchesAnyPathGlob(relativePath: string, patterns: string[]): boolean {
  return patterns.some((pattern) => matchesPathGlob(relativePath, pattern));
}

function matchesPathGlob(relativePath: string, pattern: string): boolean {
  const normalizedPath = normalizeRelativePath(relativePath);
  const normalizedPattern = normalizeGlob(pattern);
  if (!normalizedPattern.includes("/")) {
    return pathGlobToRegExp(normalizedPattern).test(path.posix.basename(normalizedPath))
      || pathGlobToRegExp(normalizedPattern).test(normalizedPath);
  }
  return pathGlobToRegExp(normalizedPattern).test(normalizedPath);
}

function normalizeGlob(pattern: string): string {
  return pattern.trim().split(path.sep).join("/").replace(/^\.\//u, "");
}

function pathGlobToRegExp(pattern: string): RegExp {
  let source = "";
  for (let index = 0; index < pattern.length; index += 1) {
    const char = pattern[index];
    const next = pattern[index + 1];
    const afterNext = pattern[index + 2];
    if (char === "*" && next === "*" && afterNext === "/") {
      source += "(?:.*/)?";
      index += 2;
      continue;
    }
    if (char === "*" && next === "*") {
      source += ".*";
      index += 1;
      continue;
    }
    if (char === "*") {
      source += "[^/]*";
      continue;
    }
    if (char === "?") {
      source += "[^/]";
      continue;
    }
    source += char.replace(/[|\\{}()[\]^$+?.]/gu, "\\$&");
  }
  return new RegExp(`^${source}$`, "u");
}

function isNodeErrorWithCode(error: unknown, code: string): boolean {
  return typeof error === "object" && error !== null && "code" in error && (error as { code?: unknown }).code === code;
}

function codexShellEnvironmentSet(env: NodeJS.ProcessEnv): string {
  const entries = Object.entries(env)
    .filter(([, value]) => value !== undefined)
    .filter(([key]) => !matchesAnyPattern(key, CODEX_ARG_ENV_DENY_PATTERNS))
    .map(([key, value]) => `${key}=${tomlString(value ?? "")}`);
  return `{${entries.join(",")}}`;
}

function tomlString(value: string): string {
  return JSON.stringify(value);
}

function enumValue<T extends string>(value: unknown, allowed: readonly T[], fallback: T): T {
  return typeof value === "string" && (allowed as readonly string[]).includes(value) ? value as T : fallback;
}

function stringList(value: unknown, fallback: string[]): string[] {
  if (!Array.isArray(value)) {
    return [...fallback];
  }
  const seen = new Set<string>();
  const result: string[] = [];
  for (const item of value) {
    if (typeof item !== "string") continue;
    const trimmed = item.trim();
    if (!trimmed || seen.has(trimmed)) continue;
    seen.add(trimmed);
    result.push(trimmed);
  }
  return result;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function matchesAnyPattern(value: string, patterns: string[]): boolean {
  return patterns.some((pattern) => matchesPattern(value, pattern));
}

function matchesPattern(value: string, pattern: string): boolean {
  if (!pattern.includes("*")) {
    return value === pattern;
  }
  const escaped = pattern
    .split("*")
    .map((part) => part.replace(/[|\\{}()[\]^$+?.]/gu, "\\$&"))
    .join(".*");
  return new RegExp(`^${escaped}$`, "u").test(value);
}
