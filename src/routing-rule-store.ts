import crypto from "node:crypto";
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import path from "node:path";

import { TaskLifecycleError } from "./task-lifecycle-errors.ts";

export interface RoutingTarget {
  type: "agent" | "triage_queue";
  id: string;
}

export interface RoutingConditions {
  repositories?: string[];
  labelsAny?: string[];
  providerAssigneesAny?: string[];
  projects?: string[];
  issueTypes?: string[];
  priorities?: string[];
  ownershipTagsAny?: string[];
  capabilityTagsAll?: string[];
}

export interface RoutingRule {
  id: string;
  name: string;
  enabled: boolean;
  priority: number;
  conditions: RoutingConditions;
  target: RoutingTarget;
  confidence: number;
  explanation: string;
}

export interface ClassifierConfig {
  enabled: boolean;
  provider: string;
  confidenceThreshold: number;
  maxCandidates: number;
  fallbackTriageQueueId: string;
}

export interface RoutingRuleSetReplaceRequest {
  sourceRef: string;
  changeReason: string;
  rules: RoutingRule[];
  classifier: ClassifierConfig;
}

export interface RoutingRuleSet {
  id: string;
  version: number;
  status: "active" | "superseded";
  source: "admin_api" | "config_file_import" | "database_seed";
  sourceRef: string;
  createdBy: string;
  createdAt: string;
  rules: RoutingRule[];
  classifier: ClassifierConfig;
  audit: {
    supersedesRuleSetId: string | null;
    changeReason: string;
  };
}

interface IdempotencyEntry {
  fingerprint: string;
  response: RoutingRuleSet;
}

interface PersistedState {
  ruleSets?: RoutingRuleSet[];
  idempotencyEntries?: Array<[string, IdempotencyEntry]>;
}

const MAX_IDEMPOTENCY_ENTRIES = 1000;
const ROUTING_TARGET_TYPES = new Set(["agent", "triage_queue"]);
const ROUTING_CONDITION_FIELDS = [
  "repositories",
  "labelsAny",
  "providerAssigneesAny",
  "projects",
  "issueTypes",
  "priorities",
  "ownershipTagsAny",
  "capabilityTagsAll",
] as const;

function createId(prefix: string): string {
  return `${prefix}_${crypto.randomBytes(10).toString("hex")}`;
}

function stableStringify(value: unknown, seen = new WeakSet<object>()): string {
  if (value === undefined) {
    return "\"[Undefined]\"";
  }
  if (value instanceof Date) {
    return JSON.stringify(value.toISOString());
  }
  if (value instanceof Map) {
    if (seen.has(value)) return "\"[Circular]\"";
    seen.add(value);
    const entries = [...value.entries()]
      .map(([key, item]) => `[${stableStringify(key, seen)},${stableStringify(item, seen)}]`)
      .sort();
    seen.delete(value);
    return `{"[Map]":[${entries.join(",")}]}`;
  }
  if (value instanceof Set) {
    if (seen.has(value)) return "\"[Circular]\"";
    seen.add(value);
    const entries = [...value.values()].map(item => stableStringify(item, seen)).sort();
    seen.delete(value);
    return `{"[Set]":[${entries.join(",")}]}`;
  }
  if (Array.isArray(value)) {
    if (seen.has(value)) return "\"[Circular]\"";
    seen.add(value);
    const serialized = `[${value.map(item => stableStringify(item, seen)).join(",")}]`;
    seen.delete(value);
    return serialized;
  }
  if (value && typeof value === "object") {
    if (seen.has(value)) return "\"[Circular]\"";
    seen.add(value);
    const serialized = `{${Object.keys(value as Record<string, unknown>)
      .sort()
      .map(key => `${JSON.stringify(key)}:${stableStringify((value as Record<string, unknown>)[key], seen)}`)
      .join(",")}}`;
    seen.delete(value);
    return serialized;
  }
  return JSON.stringify(value) ?? "null";
}

function sha256(value: unknown): string {
  return `sha256:${crypto.createHash("sha256").update(stableStringify(value)).digest("hex")}`;
}

function clone<T>(value: T): T {
  return structuredClone(value);
}

function warnInvalidState(storagePath: string | undefined, reason: string): void {
  if (!storagePath) return;
  process.emitWarning(`Ignoring invalid RoutingRuleStore state at ${storagePath}: ${reason}`);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.length > 0;
}

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every(item => typeof item === "string");
}

function loadState(storagePath: string | undefined): PersistedState {
  if (!storagePath || !existsSync(storagePath)) return {};
  try {
    const content = readFileSync(storagePath, "utf8");
    if (!content.trim()) return {};
    const parsed = JSON.parse(content) as unknown;
    if (isRecord(parsed) && (parsed.ruleSets === undefined || Array.isArray(parsed.ruleSets)) && (parsed.idempotencyEntries === undefined || Array.isArray(parsed.idempotencyEntries))) {
      return parsed as PersistedState;
    }
    warnInvalidState(storagePath, "state object shape is unsupported");
    return {};
  } catch (error) {
    if (error instanceof SyntaxError) {
      warnInvalidState(storagePath, error.message);
      return {};
    }
    throw error;
  }
}

function persistState(storagePath: string | undefined, ruleSets: RoutingRuleSet[], idempotency: Map<string, IdempotencyEntry>): void {
  if (!storagePath) return;
  mkdirSync(path.dirname(storagePath), { recursive: true });
  const state: PersistedState = {
    ruleSets,
    idempotencyEntries: [...idempotency.entries()],
  };
  const tempPath = `${storagePath}.tmp`;
  writeFileSync(tempPath, JSON.stringify(state, null, 2) + "\n", "utf8");
  renameSync(tempPath, storagePath);
}

export interface RoutingRuleStoreOptions {
  now?: () => Date;
  storagePath?: string;
}

export class RoutingRuleStore {
  private readonly now: () => Date;
  private readonly storagePath: string | undefined;
  private ruleSets: RoutingRuleSet[];
  private readonly idempotency: Map<string, IdempotencyEntry>;

  constructor({ now = () => new Date(), storagePath }: RoutingRuleStoreOptions = {}) {
    this.now = now;
    this.storagePath = storagePath;
    const state = loadState(storagePath);
    this.ruleSets = clone((state.ruleSets ?? []).filter(isRoutingRuleSet));
    this.idempotency = new Map(filterIdempotencyEntries(state.idempotencyEntries ?? []));
    this.trimIdempotency();
  }

  getCurrentRuleSet(): RoutingRuleSet | null {
    const current = this.ruleSets.at(-1) ?? null;
    return current ? clone(current) : null;
  }

  replaceRuleSet(payload: RoutingRuleSetReplaceRequest, createdBy: string, idempotencyKey?: string): RoutingRuleSet {
    this.validateRuleSetPayload(payload);
    const fingerprint = sha256(payload);

    if (idempotencyKey) {
      const entry = this.idempotency.get(`rule-set:${idempotencyKey}`);
      if (entry) {
        if (entry.fingerprint !== fingerprint) {
          throw new TaskLifecycleError(409, "conflict", "Idempotency-Key has already been used with a different routing rule set payload.", {
            idempotencyKey,
            availableActions: ["retry"],
          });
        }
        return clone(entry.response);
      }
    }

    const previous = this.ruleSets.at(-1) ?? null;
    if (previous) {
      previous.status = "superseded";
    }

    const next: RoutingRuleSet = {
      id: createId("rset"),
      version: previous ? previous.version + 1 : 1,
      status: "active",
      source: "admin_api",
      sourceRef: payload.sourceRef,
      createdBy,
      createdAt: this.now().toISOString(),
      rules: clone(payload.rules),
      classifier: clone(payload.classifier),
      audit: {
        supersedesRuleSetId: previous?.id ?? null,
        changeReason: payload.changeReason,
      },
    };

    this.ruleSets.push(next);

    if (idempotencyKey) {
      this.setIdempotency(`rule-set:${idempotencyKey}`, { fingerprint, response: clone(next) });
    }

    this.persist();
    return clone(next);
  }

  getRuleSet(version: number): RoutingRuleSet | null {
    const ruleSet = this.ruleSets.find(r => r.version === version);
    return ruleSet ? clone(ruleSet) : null;
  }

  listRuleSets(): RoutingRuleSet[] {
    return clone(this.ruleSets);
  }

  private persist(): void {
    persistState(this.storagePath, this.ruleSets, this.idempotency);
  }

  private setIdempotency(key: string, entry: IdempotencyEntry): void {
    if (this.idempotency.has(key)) {
      this.idempotency.delete(key);
    }
    this.idempotency.set(key, entry);
    this.trimIdempotency();
  }

  private trimIdempotency(): void {
    while (this.idempotency.size > MAX_IDEMPOTENCY_ENTRIES) {
      const oldestKey = this.idempotency.keys().next().value as string | undefined;
      if (!oldestKey) break;
      this.idempotency.delete(oldestKey);
    }
  }

  private validateRuleSetPayload(payload: RoutingRuleSetReplaceRequest) {
    if (!payload || typeof payload !== "object") {
      throw new TaskLifecycleError(400, "validation_error", "Routing rule set payload must be an object.", {
        availableActions: ["retry"],
      });
    }
    if (!Array.isArray(payload.rules) || payload.rules.length === 0) {
      throw new TaskLifecycleError(400, "validation_error", "Routing rule set payload must contain at least one rule.", {
        availableActions: ["retry"],
      });
    }
    if (!isNonEmptyString(payload.sourceRef) || !isNonEmptyString(payload.changeReason)) {
      throw new TaskLifecycleError(400, "validation_error", "Routing rule set payload requires `sourceRef` and `changeReason`.", {
        availableActions: ["retry"],
      });
    }
    this.validateClassifier(payload.classifier);
    const seenRuleIds = new Set<string>();
    payload.rules.forEach((rule, index) => {
      this.validateRule(rule, index);
      if (seenRuleIds.has(rule.id)) {
        throw new TaskLifecycleError(400, "validation_error", `Routing rule set payload contains duplicate rule id \`${rule.id}\`.`, {
          availableActions: ["retry"],
        });
      }
      seenRuleIds.add(rule.id);
    });
  }

  private validateClassifier(classifier: ClassifierConfig) {
    if (
      !isRecord(classifier) ||
      typeof classifier.enabled !== "boolean" ||
      !isNonEmptyString(classifier.provider) ||
      typeof classifier.confidenceThreshold !== "number" ||
      classifier.confidenceThreshold < 0 ||
      classifier.confidenceThreshold > 1 ||
      !Number.isInteger(classifier.maxCandidates) ||
      classifier.maxCandidates < 1 ||
      !isNonEmptyString(classifier.fallbackTriageQueueId)
    ) {
      throw new TaskLifecycleError(400, "validation_error", "Routing rule set payload contains an invalid classifier config.", {
        availableActions: ["retry"],
      });
    }
  }

  private validateRule(rule: RoutingRule, index: number) {
    const label = isRecord(rule) && typeof rule.id === "string" ? rule.id : `index ${index}`;
    if (
      !isRecord(rule) ||
      !isNonEmptyString(rule.id) ||
      !isNonEmptyString(rule.name) ||
      typeof rule.enabled !== "boolean" ||
      !Number.isInteger(rule.priority) ||
      typeof rule.confidence !== "number" ||
      rule.confidence < 0 ||
      rule.confidence > 1 ||
      !isNonEmptyString(rule.explanation)
    ) {
      throw new TaskLifecycleError(400, "validation_error", `Routing rule ${label} has invalid required fields.`, {
        availableActions: ["retry"],
      });
    }
    if (!isRecord(rule.target) || !ROUTING_TARGET_TYPES.has(rule.target.type) || !isNonEmptyString(rule.target.id)) {
      throw new TaskLifecycleError(400, "validation_error", `Routing rule ${label} has an invalid target.`, {
        availableActions: ["retry"],
      });
    }
    if (!isRecord(rule.conditions)) {
      throw new TaskLifecycleError(400, "validation_error", `Routing rule ${label} has invalid conditions.`, {
        availableActions: ["retry"],
      });
    }
    for (const key of Object.keys(rule.conditions)) {
      if (!(ROUTING_CONDITION_FIELDS as readonly string[]).includes(key)) {
        throw new TaskLifecycleError(400, "validation_error", `Routing rule ${label} uses unsupported condition \`${key}\`.`, {
          availableActions: ["retry"],
        });
      }
      if (!isStringArray((rule.conditions as Record<string, unknown>)[key])) {
        throw new TaskLifecycleError(400, "validation_error", `Routing rule ${label} condition \`${key}\` must be an array of strings.`, {
          availableActions: ["retry"],
        });
      }
    }
  }
}

function isRoutingRuleSet(value: unknown): value is RoutingRuleSet {
  return (
    isRecord(value) &&
    isNonEmptyString(value.id) &&
    Number.isInteger(value.version) &&
    typeof value.status === "string" &&
    isNonEmptyString(value.sourceRef) &&
    isNonEmptyString(value.createdBy) &&
    isNonEmptyString(value.createdAt) &&
    Array.isArray(value.rules) &&
    isRecord(value.classifier)
  );
}

function filterIdempotencyEntries(entries: Array<[string, IdempotencyEntry]>): Array<[string, IdempotencyEntry]> {
  return entries.filter((entry): entry is [string, IdempotencyEntry] =>
    Array.isArray(entry) &&
    entry.length === 2 &&
    typeof entry[0] === "string" &&
    isRecord(entry[1]) &&
    typeof entry[1].fingerprint === "string" &&
    "response" in entry[1],
  );
}
