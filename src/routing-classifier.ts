import { spawn } from "node:child_process";

import type { ClassifierConfig, ProviderIssueSnapshot } from "./intake-routing-control-plane.ts";
import { DEFAULT_ROUTING_CLASSIFIER_TIMEOUT_MS } from "./routing-classifier-config.ts";

export interface RoutingClassifierCandidate {
  agentId: string;
  displayName: string;
  capabilityTags: string[];
  ownershipTags: string[];
  repoAllowlist: string[];
  activeTaskCount: number;
  maxConcurrentTasks: number;
}

export interface RoutingClassifierInput {
  snapshot: ProviderIssueSnapshot;
  candidates: RoutingClassifierCandidate[];
  maxBodyChars?: number;
}

export interface RoutingClassifierOutput {
  taskType: "bugfix" | "feature" | "maintenance" | "documentation" | "unknown";
  requiredCapabilities: string[];
  optionalCapabilities: string[];
  ownershipHints: string[];
  missingInfo: string[];
  unmatchedCapabilities: string[];
  confidence: number;
  evidence: string[];
}

export interface RoutingClassifier {
  classify(input: RoutingClassifierInput, config: ClassifierConfig): Promise<RoutingClassifierOutput>;
}

export interface LocalRunnerRoutingClassifierOptions {
  now?: () => Date;
  spawnProcess?: typeof spawn;
}

const DEFAULT_BODY_CHARS = 6000;
const MAX_ARRAY_ITEMS = 20;
const TASK_TYPES = new Set(["bugfix", "feature", "maintenance", "documentation", "unknown"]);

function uniqueNormalized(values: unknown, field: string, maxItems = MAX_ARRAY_ITEMS): string[] {
  if (!Array.isArray(values)) {
    throw new Error(`Classifier output \`${field}\` must be an array of strings.`);
  }
  const seen = new Set<string>();
  const normalized: string[] = [];
  for (const item of values) {
    if (typeof item !== "string") {
      throw new Error(`Classifier output \`${field}\` must be an array of strings.`);
    }
    const trimmed = item.trim();
    if (!trimmed) continue;
    const key = trimmed.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    normalized.push(trimmed);
    if (normalized.length >= maxItems) break;
  }
  return normalized;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function truncate(value: string, limit: number): string {
  if (value.length <= limit) return value;
  return `${value.slice(0, limit)}\n[truncated]`;
}

function capabilityInventory(candidates: RoutingClassifierCandidate[]): string[] {
  return [...new Set(candidates.flatMap(candidate => candidate.capabilityTags).map(tag => tag.trim()).filter(Boolean))]
    .sort((left, right) => left.localeCompare(right));
}

export function buildRoutingClassifierPrompt({
  snapshot,
  candidates,
  maxBodyChars = DEFAULT_BODY_CHARS,
}: RoutingClassifierInput): string {
  const capabilities = capabilityInventory(candidates);
  const candidateSummary = candidates.map(candidate => ({
    agentId: candidate.agentId,
    displayName: candidate.displayName,
    capabilities: candidate.capabilityTags,
    ownership: candidate.ownershipTags,
    repos: candidate.repoAllowlist,
    activeTaskCount: candidate.activeTaskCount,
    maxConcurrentTasks: candidate.maxConcurrentTasks,
  }));

  return [
    "You are AgentRail's routing classifier.",
    "Classify the provider issue into required capabilities. Do not choose the agent.",
    "Pick requiredCapabilities and optionalCapabilities only from the availableCapabilities list.",
    "If the issue clearly needs a capability not in availableCapabilities, put it in unmatchedCapabilities and do not put it in requiredCapabilities.",
    "Use missingInfo when the issue is too vague to route confidently.",
    "Return only JSON. Do not include markdown or commentary.",
    "",
    "JSON schema:",
    JSON.stringify({
      taskType: "bugfix | feature | maintenance | documentation | unknown",
      requiredCapabilities: ["capability-from-list"],
      optionalCapabilities: ["capability-from-list"],
      ownershipHints: ["short area hint"],
      missingInfo: ["critical missing detail"],
      unmatchedCapabilities: ["needed capability not configured"],
      confidence: 0.0,
      evidence: ["brief evidence string"],
    }, null, 2),
    "",
    "Issue:",
    JSON.stringify({
      provider: snapshot.provider,
      id: snapshot.providerIssueId,
      repo: `${snapshot.repository.owner}/${snapshot.repository.name}`,
      title: snapshot.title,
      labels: snapshot.labels,
      project: snapshot.project ?? null,
      issueType: snapshot.issueType,
      priority: snapshot.priority,
      bodyPreview: truncate(snapshot.bodyPreview ?? "", maxBodyChars),
    }, null, 2),
    "",
    "availableCapabilities:",
    JSON.stringify(capabilities, null, 2),
    "",
    "activeAgentInventory:",
    JSON.stringify(candidateSummary, null, 2),
  ].join("\n");
}

function extractJsonPayload(raw: string): string {
  const trimmed = raw.trim();
  const fenced = trimmed.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/iu);
  if (fenced?.[1]) return fenced[1].trim();

  const firstObject = trimmed.indexOf("{");
  const lastObject = trimmed.lastIndexOf("}");
  if (firstObject !== -1 && lastObject > firstObject) {
    return trimmed.slice(firstObject, lastObject + 1);
  }
  return trimmed;
}

export function parseRoutingClassifierOutput(raw: string, availableCapabilities: string[]): RoutingClassifierOutput {
  let parsed: unknown;
  try {
    parsed = JSON.parse(extractJsonPayload(raw));
  } catch (error) {
    throw new Error(`Classifier output must be valid JSON: ${error instanceof Error ? error.message : String(error)}`);
  }
  if (!isRecord(parsed)) {
    throw new Error("Classifier output must be a JSON object.");
  }

  const taskType = typeof parsed.taskType === "string" && TASK_TYPES.has(parsed.taskType)
    ? parsed.taskType as RoutingClassifierOutput["taskType"]
    : "unknown";
  const requiredCapabilities = uniqueNormalized(parsed.requiredCapabilities, "requiredCapabilities");
  const optionalCapabilities = uniqueNormalized(parsed.optionalCapabilities, "optionalCapabilities");
  const ownershipHints = uniqueNormalized(parsed.ownershipHints, "ownershipHints");
  const missingInfo = uniqueNormalized(parsed.missingInfo, "missingInfo");
  const unmatchedCapabilities = uniqueNormalized(parsed.unmatchedCapabilities, "unmatchedCapabilities");
  const evidence = uniqueNormalized(parsed.evidence, "evidence", 10);

  if (typeof parsed.confidence !== "number" || !Number.isFinite(parsed.confidence) || parsed.confidence < 0 || parsed.confidence > 1) {
    throw new Error("Classifier output `confidence` must be a number between 0 and 1.");
  }

  const availableSet = new Set(availableCapabilities.map(value => value.toLowerCase()));
  const unknownRequired = requiredCapabilities.find(capability => !availableSet.has(capability.toLowerCase()));
  if (unknownRequired) {
    throw new Error(`Classifier output contains unknown required capability \`${unknownRequired}\`.`);
  }
  const unknownOptional = optionalCapabilities.find(capability => !availableSet.has(capability.toLowerCase()));
  if (unknownOptional) {
    throw new Error(`Classifier output contains unknown optional capability \`${unknownOptional}\`.`);
  }

  return {
    taskType,
    requiredCapabilities,
    optionalCapabilities,
    ownershipHints,
    missingInfo,
    unmatchedCapabilities,
    confidence: parsed.confidence,
    evidence,
  };
}

export class LocalRunnerRoutingClassifier implements RoutingClassifier {
  private readonly spawnProcess: typeof spawn;

  constructor({ spawnProcess = spawn }: LocalRunnerRoutingClassifierOptions = {}) {
    this.spawnProcess = spawnProcess;
  }

  async classify(input: RoutingClassifierInput, config: ClassifierConfig): Promise<RoutingClassifierOutput> {
    const prompt = buildRoutingClassifierPrompt(input);
    const availableCapabilities = capabilityInventory(input.candidates);
    const { executable, args } = launchCommand(config);
    const output = await runClassifierProcess({
      spawnProcess: this.spawnProcess,
      executable,
      args,
      prompt,
      timeoutMs: config.timeoutMs ?? DEFAULT_ROUTING_CLASSIFIER_TIMEOUT_MS,
    });
    return parseRoutingClassifierOutput(output, availableCapabilities);
  }
}

function launchCommand(config: ClassifierConfig): { executable: string; args: string[] } {
  const runner = config.runner ?? config.provider;
  const modelArgs = config.model ? ["--model", config.model] : [];

  if (runner === "claude-code") {
    return { executable: "claude", args: ["--print", ...modelArgs] };
  }
  if (runner === "cursor") {
    return { executable: "cursor-agent", args: [] };
  }
  if (runner === "custom") {
    throw new Error("Custom routing classifier commands are not configured yet.");
  }
  return {
    executable: "codex",
    args: ["-a", "never", "exec", "--sandbox", "read-only", ...modelArgs, "-"],
  };
}

async function runClassifierProcess({
  spawnProcess,
  executable,
  args,
  prompt,
  timeoutMs,
}: {
  spawnProcess: typeof spawn;
  executable: string;
  args: string[];
  prompt: string;
  timeoutMs: number;
}): Promise<string> {
  const stdoutChunks: Buffer[] = [];
  const stderrChunks: Buffer[] = [];

  return await new Promise<string>((resolve, reject) => {
    let settled = false;
    const child = spawnProcess(executable, args, {
      stdio: "pipe",
      env: stripAgentRailSecrets(process.env),
    });
    const timeout = setTimeout(() => {
      child.kill("SIGTERM");
      if (!settled) {
        settled = true;
        reject(new Error(`Routing classifier timed out after ${timeoutMs}ms.`));
      }
    }, timeoutMs);
    child.stdout.on("data", chunk => stdoutChunks.push(Buffer.from(chunk)));
    child.stderr.on("data", chunk => stderrChunks.push(Buffer.from(chunk)));
    child.on("error", error => {
      clearTimeout(timeout);
      if (!settled) {
        settled = true;
        reject(error);
      }
    });
    child.on("close", code => {
      clearTimeout(timeout);
      if (settled) return;
      settled = true;
      const stdout = Buffer.concat(stdoutChunks).toString("utf8").trim();
      const stderr = Buffer.concat(stderrChunks).toString("utf8").trim();
      if (code !== 0) {
        reject(new Error(stderr || stdout || `Routing classifier exited with code ${code}.`));
        return;
      }
      resolve(stdout || stderr);
    });
    child.stdin.end(prompt);
  });
}

function stripAgentRailSecrets(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const next: NodeJS.ProcessEnv = {};
  for (const [key, value] of Object.entries(env)) {
    if (key.includes("TOKEN") || key.includes("KEY") || key.includes("SECRET")) continue;
    next[key] = value;
  }
  return next;
}
