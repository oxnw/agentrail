import {
  buildInitCommand,
  createSetupConfig,
  type CreateSetupConfigOptions,
  type DetectedRepoContext,
  type PersistenceKind,
  type ProviderMode,
  type SetupConfig,
  type SetupMode,
} from "./setup-config.ts";
import { resolveAgentRailHome } from "./agentrail-home.ts";
import { PromptCancelledError, type PromptSession } from "./prompt.ts";

export interface InitFlags {
  help?: boolean;
  interactive?: boolean;
  yes?: boolean;
  printOnly?: boolean;
  mode?: SetupMode;
  host?: string;
  port?: number;
  baseUrl?: string;
  persistence?: PersistenceKind;
  providerMode?: ProviderMode;
  repo?: string;
  repoAllowlist?: string[];
  defaultBranch?: string;
  markdownExport?: boolean;
}

export interface SetupWizardResult {
  action: "write" | "print_only" | "cancelled";
  config: SetupConfig;
  command: string;
  planLines: string[];
}

export interface RunSetupWizardOptions {
  cwd: string;
  flags: InitFlags;
  detectedRepo: DetectedRepoContext;
  prompt: PromptSession;
  writeLine(line: string): void;
}

export async function runSetupWizard({
  cwd,
  flags,
  detectedRepo,
  prompt,
  writeLine,
}: RunSetupWizardOptions): Promise<SetupWizardResult> {
  const detectedAllowlist = detectedRepo.remoteSlug ?? detectedRepo.repoPath;
  const detectedRepoUrl = toGitHubUrl(detectedAllowlist);
  const detectedBaseUrl = flags.baseUrl ?? "http://127.0.0.1:3000";
  const homePath = resolveAgentRailHome({ cwd, explicitHome: null });
  await prompt.message(`AgentRail home: ${homePath}`);
  await prompt.message(`Detected repo you can connect: ${detectedRepo.repoPath}`);
  if (detectedRepo.remoteSlug) {
    await prompt.message(`GitHub repo detected: ${detectedRepoUrl} • default branch: ${detectedRepo.defaultBranch}`);
  }
  const repoPath = flags.repo ?? resolvePromptValue(
    await prompt.input({
      message: "Which local repo should AgentRail connect first?",
      defaultValue: detectedRepo.repoPath,
    }),
    detectedRepo.repoPath,
  );
  const repoAllowlist = flags.repoAllowlist ?? [
    await promptForRepoAllowlist({
      prompt,
      detectedRepoUrl,
      fallback: detectedAllowlist,
    }),
  ];
  const defaultBranch = flags.defaultBranch ?? resolvePromptValue(
    await prompt.input({
      message: "Default branch",
      defaultValue: detectedRepo.defaultBranch,
    }),
    detectedRepo.defaultBranch,
  );
  const baseUrl = flags.baseUrl ?? resolvePromptValue(
    await prompt.input({
      message: "Local API base URL for AgentRail",
      defaultValue: detectedBaseUrl,
    }),
    detectedBaseUrl,
  );
  const providerMode = flags.providerMode ?? "real";
  const markdownExport = flags.markdownExport ?? await prompt.confirm({
    message: "Enable Markdown/Obsidian export?",
    defaultValue: false,
  });

  const config = createSetupConfig({
    cwd,
    detectedRepo,
    interactionMode: "interactive",
    acceptedDefaults: acceptedDefaultsFromFlags(flags),
    mode: "server",
    host: flags.host,
    port: flags.port,
    baseUrl,
    persistence: flags.persistence,
    providerMode,
    repoPath,
    repoAllowlist,
    defaultBranch,
    markdownExport,
  });
  await prompt.note({
    title: "Review setup plan",
    body: [
      "AgentRail is ready to create its local home and connect your first repo.",
      "",
      "Setup choices:",
      `- AgentRail home: ${homePath}`,
      `- First connected local repo: ${repoPath}`,
      `- GitHub repo: ${toGitHubUrl(repoAllowlist[0] ?? detectedAllowlist)}`,
      `- Default branch: ${defaultBranch}`,
      `- Local API base URL: ${baseUrl}`,
      `- Provider mode: ${providerMode}`,
      `- Markdown export: ${markdownExport ? "enabled" : "disabled"}`,
      "",
      "Nothing is written until you answer yes.",
    ].join("\n"),
  });

  const action = flags.printOnly
    ? "print_only"
    : await prompt.confirm({
      message: "Write setup files and continue?",
      defaultValue: true,
    })
      ? "write"
      : "cancelled";

  if (action === "write") {
    await prompt.note({
      title: "What happens next",
      body: [
        "Init creates `~/.agentrail/operator.env` so local admin commands can run without a manual curl step.",
        "Real agent env files are written later under `~/.agentrail/agents/<agentId>.env`.",
        "If no local agents exist yet, the wizard will offer first-agent creation before you leave setup.",
        "You can rerun `agentrail init` safely to refresh your global AgentRail home.",
        "",
        "Use `agentrail provider connect github` or `agentrail provider connect circleci` when you are ready to connect live providers.",
        "When the API is running, `agentrail doctor` is the final verification step.",
        "Use `./agentrail server start` whenever you want the local API running outside the wizard.",
      ].join("\n"),
    });
  }

  return {
    action,
    config,
    command: buildInitCommand(config),
    planLines: [],
  };
}

function resolvePromptValue(value: string, fallback: string): string {
  return value.trim() || fallback;
}

async function promptForRepoAllowlist({
  prompt,
  detectedRepoUrl,
  fallback,
}: {
  prompt: PromptSession;
  detectedRepoUrl: string;
  fallback: string;
}): Promise<string> {
  while (true) {
    const rawValue = resolvePromptValue(
      await prompt.input({
        message: "Primary GitHub repo URL",
        defaultValue: detectedRepoUrl,
      }),
      fallback,
    );

    try {
      return normalizeRepoInput(rawValue);
    } catch (error) {
      if (error instanceof PromptCancelledError) {
        throw error;
      }
      await prompt.message(error instanceof Error ? error.message : String(error));
    }
  }
}

function normalizeRepoInput(value: string): string {
  const trimmed = value.trim();
  if (/^https?:\/\//iu.test(trimmed)) {
    let url: URL;
    try {
      url = new URL(trimmed);
    } catch {
      throw new Error("Use a GitHub repo URL like https://github.com/owner/repo.");
    }
    if (url.hostname !== "github.com") {
      throw new Error("Use a GitHub repo URL like https://github.com/owner/repo.");
    }
    const parts = url.pathname.replace(/^\/+|\/+$/gu, "").split("/");
    if (parts.length < 2 || !parts[0] || !parts[1]) {
      throw new Error("Use a GitHub repo URL like https://github.com/owner/repo.");
    }
    return `${parts[0]}/${stripGitSuffix(parts[1])}`;
  }
  if (/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/u.test(trimmed)) {
    const [owner, repo] = trimmed.split("/", 2);
    return `${owner}/${stripGitSuffix(repo ?? "")}`;
  }
  throw new Error("Use a GitHub repo URL like https://github.com/owner/repo.");
}

function stripGitSuffix(value: string): string {
  return value.replace(/\.git$/iu, "");
}

function toGitHubUrl(value: string): string {
  if (/^https?:\/\//iu.test(value)) {
    return value;
  }
  if (/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/u.test(value)) {
    return `https://github.com/${value}`;
  }
  return value;
}

export function acceptedDefaultsFromFlags(flags: InitFlags): boolean {
  return !flags.mode
    || !flags.baseUrl
    || !flags.persistence
    || !flags.providerMode
    || !flags.repo
    || !flags.repoAllowlist?.length
    || !flags.defaultBranch
    || flags.markdownExport === undefined;
}

export function createSetupConfigFromFlags({
  cwd,
  flags,
  detectedRepo,
  interactionMode,
  acceptedDefaults,
}: {
  cwd: string;
  flags: InitFlags;
  detectedRepo: DetectedRepoContext;
  interactionMode: CreateSetupConfigOptions["interactionMode"];
  acceptedDefaults: boolean;
}): SetupConfig {
  return createSetupConfig({
    cwd,
    detectedRepo,
    interactionMode,
    acceptedDefaults,
    mode: flags.mode,
    host: flags.host,
    port: flags.port,
    baseUrl: flags.baseUrl,
    persistence: flags.persistence,
    providerMode: flags.providerMode,
    repoPath: flags.repo,
    repoAllowlist: flags.repoAllowlist,
    defaultBranch: flags.defaultBranch,
    markdownExport: flags.markdownExport,
  });
}
