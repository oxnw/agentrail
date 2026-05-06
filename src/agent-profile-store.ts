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
  changeReason: string;
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

const MAX_IDEMPOTENCY_ENTRIES = 1000;
const PROFILE_STATUSES = new Set(["active", "paused", "disabled"]);
const PROFILE_SOURCES = new Set(["agent_created", "operator_admin", "skill_assignment_sync", "config_file_import"]);
const PROFILE_PROVIDERS = new Set(["github", "linear", "jira", "gitlab"]);

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

function warnInvalidState(storagePath: string | undefined, reason: string): void {
  if (!storagePath) return;
  process.emitWarning(`Ignoring invalid AgentProfileStore state at ${storagePath}: ${reason}`);
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
    if (isRecord(parsed) && (parsed.profiles === undefined || Array.isArray(parsed.profiles)) && (parsed.idempotencyEntries === undefined || Array.isArray(parsed.idempotencyEntries))) {
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
    this.profiles = new Map(
      (state.profiles ?? [])
        .map(profile => normalizeProfile(profile))
        .filter((profile): profile is AgentProfile => profile !== null)
        .map(profile => [profile.agentId, profile]),
    );
    this.idempotency = new Map(filterIdempotencyEntries(state.idempotencyEntries ?? []));
    this.trimIdempotency();
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
      changeReason: payload.changeReason,
      updatedBy,
      updatedAt: this.now().toISOString(),
    };
    this.profiles.set(agentId, profile);

    if (idempotencyKey) {
      this.setIdempotency(`profile:${idempotencyKey}`, { fingerprint, response: clone(profile) });
    }

    this.persist();
    return clone(profile);
  }

  private persist(): void {
    persistState(this.storagePath, this.profiles, this.idempotency);
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
    if (
      !isNonEmptyString(payload.displayName) ||
      !isNonEmptyString(payload.role) ||
      !PROFILE_STATUSES.has(payload.status) ||
      !Number.isInteger(payload.maxConcurrentTasks) ||
      payload.maxConcurrentTasks < 1 ||
      payload.maxConcurrentTasks > 50 ||
      !isNonEmptyString(payload.sourceRef) ||
      !isNonEmptyString(payload.changeReason) ||
      payload.changeReason.length > 500
    ) {
      throw new TaskLifecycleError(400, "validation_error", "Routing agent profile is missing required scalar fields.", {
        availableActions: ["retry"],
      });
    }
    if (!isStringArray(payload.capabilityTags) || payload.capabilityTags.length > 50) {
      throw new TaskLifecycleError(400, "validation_error", "Routing agent profile `capabilityTags` must be an array of strings.", {
        availableActions: ["retry"],
      });
    }
    if (!isStringArray(payload.ownershipTags) || payload.ownershipTags.length > 50) {
      throw new TaskLifecycleError(400, "validation_error", "Routing agent profile `ownershipTags` must be an array of strings.", {
        availableActions: ["retry"],
      });
    }
    if (!isStringArray(payload.repoAllowlist) || payload.repoAllowlist.length > 200) {
      throw new TaskLifecycleError(400, "validation_error", "Routing agent profile `repoAllowlist` must be an array of strings.", {
        availableActions: ["retry"],
      });
    }
    if (
      !Array.isArray(payload.providerIdentityMappings) ||
      payload.providerIdentityMappings.length > 20 ||
      !payload.providerIdentityMappings.every(mapping =>
        isRecord(mapping) &&
        isNonEmptyString(mapping.provider) &&
        PROFILE_PROVIDERS.has(mapping.provider) &&
        isNonEmptyString(mapping.subject)
      )
    ) {
      throw new TaskLifecycleError(400, "validation_error", "Routing agent profile `providerIdentityMappings` must contain provider/subject mappings.", {
        availableActions: ["retry"],
      });
    }
  }
}

function normalizeProfile(value: unknown): AgentProfile | null {
  if (!isRecord(value)) return null;
  if (!isNonEmptyString(value.agentId) || !isNonEmptyString(value.displayName) || !isNonEmptyString(value.role)) return null;
  if (typeof value.status !== "string" || !PROFILE_STATUSES.has(value.status)) return null;
  if (!isStringArray(value.capabilityTags) || !isStringArray(value.ownershipTags) || !isStringArray(value.repoAllowlist)) return null;
  if (!Array.isArray(value.providerIdentityMappings)) return null;
  if (!value.providerIdentityMappings.every(mapping =>
    isRecord(mapping) &&
    typeof mapping.provider === "string" &&
    PROFILE_PROVIDERS.has(mapping.provider) &&
    typeof mapping.subject === "string"
  )) return null;
  if (!Number.isInteger(value.maxConcurrentTasks)) return null;
  if (typeof value.source !== "string" || !PROFILE_SOURCES.has(value.source)) return null;
  if (!isNonEmptyString(value.sourceRef) || !isNonEmptyString(value.updatedBy) || !isNonEmptyString(value.updatedAt)) return null;

  return {
    agentId: value.agentId,
    displayName: value.displayName,
    role: value.role,
    status: value.status as AgentProfile["status"],
    capabilityTags: clone(value.capabilityTags),
    ownershipTags: clone(value.ownershipTags),
    repoAllowlist: clone(value.repoAllowlist),
    providerIdentityMappings: clone(value.providerIdentityMappings as ProviderIdentityMapping[]),
    maxConcurrentTasks: Number(value.maxConcurrentTasks),
    source: value.source as AgentProfile["source"],
    sourceRef: value.sourceRef,
    changeReason: typeof value.changeReason === "string" ? value.changeReason : "",
    updatedBy: value.updatedBy,
    updatedAt: value.updatedAt,
  };
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
