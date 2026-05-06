import crypto from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
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

function createId(prefix: string): string {
  return `${prefix}_${crypto.randomBytes(10).toString("hex")}`;
}

function stableStringify(value: unknown): string {
  if (Array.isArray(value)) {
    return `[${value.map(item => stableStringify(item)).join(",")}]`;
  }
  if (value && typeof value === "object") {
    return `{${Object.keys(value as Record<string, unknown>)
      .sort()
      .map(key => `${JSON.stringify(key)}:${stableStringify((value as Record<string, unknown>)[key])}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}

function sha256(value: unknown): string {
  return `sha256:${crypto.createHash("sha256").update(stableStringify(value)).digest("hex")}`;
}

function clone<T>(value: T): T {
  return structuredClone(value);
}

function loadState(storagePath: string | undefined): PersistedState {
  if (!storagePath || !existsSync(storagePath)) return {};
  const content = readFileSync(storagePath, "utf8");
  if (!content.trim()) return {};
  const parsed = JSON.parse(content) as unknown;
  if (parsed && typeof parsed === "object" && !Array.isArray(parsed) && "ruleSets" in parsed) {
    return parsed as PersistedState;
  }
  return {};
}

function persistState(storagePath: string | undefined, ruleSets: RoutingRuleSet[], idempotency: Map<string, IdempotencyEntry>): void {
  if (!storagePath) return;
  mkdirSync(path.dirname(storagePath), { recursive: true });
  const state: PersistedState = {
    ruleSets,
    idempotencyEntries: [...idempotency.entries()],
  };
  writeFileSync(storagePath, JSON.stringify(state, null, 2) + "\n", "utf8");
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
    this.ruleSets = clone(state.ruleSets ?? []);
    this.idempotency = new Map(state.idempotencyEntries ?? []);
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
      this.idempotency.set(`rule-set:${idempotencyKey}`, { fingerprint, response: clone(next) });
    }

    this.persist();
    return clone(next);
  }

  getRuleSet(version: number): RoutingRuleSet | null {
    return this.ruleSets.find(r => r.version === version) ? clone(this.ruleSets.find(r => r.version === version)!) : null;
  }

  listRuleSets(): RoutingRuleSet[] {
    return clone(this.ruleSets);
  }

  private persist(): void {
    persistState(this.storagePath, this.ruleSets, this.idempotency);
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
  }
}
