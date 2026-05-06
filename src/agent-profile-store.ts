import crypto from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";

import { TaskLifecycleError } from "./task-lifecycle-errors.ts";

export interface ProviderIdentityMapping {
  provider: string;
  subject: string;
}

export interface AgentProfileReplaceRequest {
  displayName: string;
  role: string;
  status: "active" | "paused" | "disabled";
  capabilityTags: string[];
  ownershipTags: string[];
  repoAllowlist: string[];
  providerIdentityMappings: ProviderIdentityMapping[];
  maxConcurrentTasks: number;
  sourceRef: string;
  changeReason: string;
}

export interface AgentProfile {
  agentId: string;
  displayName: string;
  role: string;
  status: "active" | "paused" | "disabled";
  capabilityTags: string[];
  ownershipTags: string[];
  repoAllowlist: string[];
  providerIdentityMappings: ProviderIdentityMapping[];
  maxConcurrentTasks: number;
  source: "agent_created" | "operator_admin" | "skill_assignment_sync" | "config_file_import";
  sourceRef: string;
  updatedBy: string;
  updatedAt: string;
}

interface IdempotencyEntry {
  fingerprint: string;
  response: AgentProfile;
}

interface PersistedState {
  profiles?: AgentProfile[];
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
  if (parsed && typeof parsed === "object" && !Array.isArray(parsed) && "profiles" in parsed) {
    return parsed as PersistedState;
  }
  return {};
}

function persistState(storagePath: string | undefined, profiles: Map<string, AgentProfile>, idempotency: Map<string, IdempotencyEntry>): void {
  if (!storagePath) return;
  mkdirSync(path.dirname(storagePath), { recursive: true });
  const state: PersistedState = {
    profiles: [...profiles.values()],
    idempotencyEntries: [...idempotency.entries()],
  };
  writeFileSync(storagePath, JSON.stringify(state, null, 2) + "\n", "utf8");
}

export interface AgentProfileStoreOptions {
  now?: () => Date;
  storagePath?: string;
}

export class AgentProfileStore {
  private readonly now: () => Date;
  private readonly storagePath: string | undefined;
  private readonly profiles: Map<string, AgentProfile>;
  private readonly idempotency: Map<string, IdempotencyEntry>;

  constructor({ now = () => new Date(), storagePath }: AgentProfileStoreOptions = {}) {
    this.now = now;
    this.storagePath = storagePath;
    const state = loadState(storagePath);
    this.profiles = new Map((state.profiles ?? []).map(p => [p.agentId, p]));
    this.idempotency = new Map(state.idempotencyEntries ?? []);
  }

  getAgentProfile(agentId: string): AgentProfile | null {
    const profile = this.profiles.get(agentId);
    return profile ? clone(profile) : null;
  }

  listProfiles(): AgentProfile[] {
    return [...this.profiles.values()].map(clone);
  }

  replaceAgentProfile(agentId: string, payload: AgentProfileReplaceRequest, updatedBy: string, idempotencyKey?: string): AgentProfile {
    this.validateAgentProfilePayload(agentId, payload);
    const fingerprint = sha256({ agentId, ...payload });

    if (idempotencyKey) {
      const entry = this.idempotency.get(`profile:${idempotencyKey}`);
      if (entry) {
        if (entry.fingerprint !== fingerprint) {
          throw new TaskLifecycleError(409, "conflict", "Idempotency-Key has already been used with a different routing agent profile payload.", {
            idempotencyKey,
            availableActions: ["retry"],
          });
        }
        return clone(entry.response);
      }
    }

    const profile: AgentProfile = {
      agentId,
      displayName: payload.displayName,
      role: payload.role,
      status: payload.status,
      capabilityTags: clone(payload.capabilityTags),
      ownershipTags: clone(payload.ownershipTags),
      repoAllowlist: clone(payload.repoAllowlist),
      providerIdentityMappings: clone(payload.providerIdentityMappings),
      maxConcurrentTasks: payload.maxConcurrentTasks,
      source: "operator_admin",
      sourceRef: payload.sourceRef,
      updatedBy,
      updatedAt: this.now().toISOString(),
    };
    this.profiles.set(agentId, profile);

    if (idempotencyKey) {
      this.idempotency.set(`profile:${idempotencyKey}`, { fingerprint, response: clone(profile) });
    }

    this.persist();
    return clone(profile);
  }

  private persist(): void {
    persistState(this.storagePath, this.profiles, this.idempotency);
  }

  private validateAgentProfilePayload(agentId: string, payload: AgentProfileReplaceRequest) {
    if (!agentId.startsWith("agt_")) {
      throw new TaskLifecycleError(400, "validation_error", "Routing agent profile `agentId` must start with `agt_`.", {
        availableActions: ["retry"],
      });
    }
    if (!payload || typeof payload !== "object") {
      throw new TaskLifecycleError(400, "validation_error", "Routing agent profile payload must be an object.", {
        availableActions: ["retry"],
      });
    }
  }
}
