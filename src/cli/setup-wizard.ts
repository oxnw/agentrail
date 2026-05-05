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
        message: "GitHub remote repository:",
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
  const planLines = buildSetupPlan(config);

  await prompt.note({
    title: "Before you confirm",
    body: [
      "What setup wizard will do:",
      ...planLines.map((line) => `- ${line}`),
      "",
      "Nothing is written until you answer yes.",
    ].join("\n"),
  });

  const action = flags.printOnly
    ? "print_only"
    : await prompt.confirm({
      message: "Complete setup and write local files?",
      defaultValue: true,
    })
      ? "write"
      : "cancelled";

  if (action === "write") {
    await prompt.note({
      title: "Next steps",
      body: [
        "Add tokens to .agentrail/agent.env file in this repository",
        "Template at .agentrail/agent.env.example",
        "",
        "Happy building!",
      ].join("\n"),
    });
  }

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
