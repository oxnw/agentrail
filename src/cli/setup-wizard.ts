import {
  buildDetectedSummary,
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
  writeLine("AgentRail local setup");
  writeLine("");

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
    baseUrl: flags.baseUrl,
    persistence: flags.persistence,
    providerMode: flags.providerMode,
    repoPath: flags.repo,
    repoAllowlist: flags.repoAllowlist,
    defaultBranch: flags.defaultBranch,
    markdownExport,
  });
  const summaryLines = buildDetectedSummary(config, detectedRepo);
  const planLines = buildSetupPlan(config);

  summaryLines.forEach((line) => writeLine(line));
  writeLine("");
  writeLine("Review setup plan:");
  planLines.forEach((line) => writeLine(`- ${line}`));
  writeLine("");

  const action = flags.printOnly
    ? "print_only"
    : await prompt.select({
      message: "Continue",
      defaultValue: "write",
      choices: [
        { label: "Yes, write files", value: "write" },
        { label: "No, print commands only", value: "print_only" },
        { label: "Cancel", value: "cancelled" },
      ],
    }) as SetupWizardResult["action"];

  return {
    action,
    config,
    command: buildInitCommand(config),
    planLines,
  };
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
