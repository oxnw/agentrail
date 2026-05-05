import {
  buildInitCommand,
  buildSetupPlan,
  createSetupConfig,
  type CreateSetupConfigOptions,
  type DetectedRepoContext,
  type PersistenceKind,
  type ProviderMode,
  type SetupConfig,
  type SetupMode,
} from "./setup-config.ts";
import type { PromptSession } from "./prompt.ts";

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
  const detectedBaseUrl = flags.baseUrl ?? "http://127.0.0.1:3000";
  await prompt.note({
    title: "What these settings do",
    body: [
      "- Target GitHub repo: local repository where AgentRail writes `.agentrail/` and reads repo context.",
      "- GitHub remote (owner/repo): remote slug AgentRail stores as the initial allowed GitHub repository.",
      "- Default branch: branch AgentRail assumes for new work and pull requests.",
      "- Local API base URL: where local agents call the AgentRail API server.",
      "- Setup mode: demo stays local and token-free; server prepares real GitHub and CircleCI providers.",
      "- Markdown/Obsidian export: optional read-only notes written under `.agentrail/notes`.",
    ].join("\n"),
  });
  await prompt.message(`Local git repo detected: ${detectedRepo.repoPath}`);
  const repoPath = flags.repo ?? resolvePromptValue(
    await prompt.input({
      message: "Target GitHub repo",
      defaultValue: detectedRepo.repoPath,
    }),
    detectedRepo.repoPath,
  );
  const repoAllowlist = flags.repoAllowlist ?? [
    resolvePromptValue(
      await prompt.input({
        message: "GitHub remote (owner/repo)",
        defaultValue: detectedAllowlist,
      }),
      detectedAllowlist,
    ),
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
      message: "Local API base URL",
      defaultValue: detectedBaseUrl,
    }),
    detectedBaseUrl,
  );
  const mode = flags.mode ?? await prompt.select({
    message: "Setup mode",
    defaultValue: "demo",
    choices: [
      { label: "Demo, no provider tokens", value: "demo" },
      { label: "Self-hosted with real GitHub/CI providers", value: "server" },
    ],
  }) as SetupMode;
  const markdownExport = flags.markdownExport ?? await prompt.confirm({
    message: "Enable Markdown/Obsidian export?",
    defaultValue: false,
  });

  const config = createSetupConfig({
    cwd,
    detectedRepo,
    interactionMode: "interactive",
    acceptedDefaults: acceptedDefaultsFromFlags(flags),
    mode,
    host: flags.host,
    port: flags.port,
    baseUrl,
    persistence: flags.persistence,
    providerMode: flags.providerMode,
    repoPath,
    repoAllowlist,
    defaultBranch,
    markdownExport,
  });
  const planLines = buildSetupPlan(config);

  writeLine("Review setup plan:");
  planLines.forEach((line) => writeLine(`- ${line}`));
  writeLine("");
  await prompt.note({
    title: "Before you confirm",
    body: "Nothing is written until you answer yes. Setup will create `.agentrail/config.json`, `.agentrail/agent.env.example`, and `.agentrail/README.md`.",
  });

  const action = flags.printOnly
    ? "print_only"
    : await prompt.confirm({
      message: "Complete setup and write local files?",
      defaultValue: true,
    })
      ? "write"
      : "cancelled";

  return {
    action,
    config,
    command: buildInitCommand(config),
    planLines,
  };
}

function resolvePromptValue(value: string, fallback: string): string {
  return value.trim() || fallback;
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
