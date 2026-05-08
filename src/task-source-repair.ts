import { TaskLifecycleError } from "./task-lifecycle-errors.ts";
import { normalizeTaskSource, type TaskSource } from "./task-source.ts";

export interface TaskSourceRepairRequest {
  sourceRef: string;
  changeReason: string;
  source: Record<string, unknown>;
}

export const TASK_SOURCE_STRING_FIELDS = [
  "provider",
  "owner",
  "repo",
  "branch",
  "baseBranch",
  "headSha",
  "projectSlug",
  "ciProvider",
  "prUrl",
  "submissionId",
  "deliveryId",
  "receivedAt",
  "linearIssueId",
  "linearIdentifier",
  "linearTeamId",
  "linearTeamKey",
  "linearWorkspaceId",
  "linearWorkspaceUrlKey",
  // These fields are stored with provider-neutral names, but currently represent Linear workflow state metadata.
  "workflowStateId",
  "workflowStateName",
  "workflowStateType",
] as const;

export const TASK_SOURCE_NUMBER_FIELDS = ["issueNumber", "pullNumber"] as const;
export const TASK_SOURCE_ARRAY_FIELDS = ["reviewers", "labels", "assignees"] as const;
const LINEAR_ONLY_FIELDS = [
  "linearIssueId",
  "linearIdentifier",
  "linearTeamId",
  "linearTeamKey",
  "linearWorkspaceId",
  "linearWorkspaceUrlKey",
  "workflowStateId",
  "workflowStateName",
  "workflowStateType",
] as const;
const REPO_ONLY_FIELDS = [
  "owner",
  "repo",
  "issueNumber",
  "branch",
  "baseBranch",
  "headSha",
  "projectSlug",
  "ciProvider",
  "reviewers",
  "pullNumber",
  "prUrl",
  "submissionId",
] as const;

const TASK_SOURCE_FIELD_SET = new Set<string>([
  ...TASK_SOURCE_STRING_FIELDS,
  ...TASK_SOURCE_NUMBER_FIELDS,
  ...TASK_SOURCE_ARRAY_FIELDS,
]);

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

function validationError(message: string): never {
  throw new TaskLifecycleError(400, "validation_error", message, {
    availableActions: ["retry"],
  });
}

function assertSourceShape(source: Record<string, unknown>): void {
  if (source.provider === "linear") {
    for (const field of REPO_ONLY_FIELDS) {
      if (field in source) {
        validationError(`Linear task sources cannot include repo field \`${field}\`.`);
      }
    }
    return;
  }

  if (source.provider === "github" || source.provider === "gitlab") {
    for (const field of LINEAR_ONLY_FIELDS) {
      if (field in source) {
        validationError(`Repo-backed task sources cannot include Linear field \`${field}\`.`);
      }
    }
    return;
  }

  if (typeof source.provider === "string" && source.provider.length > 0) {
    validationError(`Task source provider \`${source.provider}\` is not supported. Supported providers: linear, github, gitlab.`);
  }
}

export function validateTaskSourceRepairRequest(payload: unknown): TaskSourceRepairRequest {
  if (!isRecord(payload)) {
    validationError("Task source repair payload must be an object.");
  }
  if (!isNonEmptyString(payload.sourceRef)) {
    validationError("Task source repair payload requires a non-empty `sourceRef`.");
  }
  if (!isNonEmptyString(payload.changeReason)) {
    validationError("Task source repair payload requires a non-empty `changeReason`.");
  }
  if (!isRecord(payload.source)) {
    validationError("Task source repair payload requires a `source` object.");
  }
  if (Object.keys(payload.source).length === 0) {
    validationError("Task source repair payload requires at least one `source` field.");
  }

  for (const key of Object.keys(payload.source)) {
    if (!TASK_SOURCE_FIELD_SET.has(key)) {
      validationError(`Task source repair payload field \`${key}\` is not supported.`);
    }
  }

  for (const field of TASK_SOURCE_STRING_FIELDS) {
    if (!(field in payload.source)) continue;
    const value = payload.source[field];
    if (value !== null && !isNonEmptyString(value)) {
      validationError(`Task source repair field \`${field}\` must be a non-empty string or null.`);
    }
  }

  for (const field of TASK_SOURCE_NUMBER_FIELDS) {
    if (!(field in payload.source)) continue;
    const value = payload.source[field];
    if (value !== null && (!Number.isInteger(value) || Number(value) <= 0)) {
      validationError(`Task source repair field \`${field}\` must be a positive integer or null.`);
    }
  }

  for (const field of TASK_SOURCE_ARRAY_FIELDS) {
    if (!(field in payload.source)) continue;
    const value = payload.source[field];
    if (value !== null && (!Array.isArray(value) || value.some((item) => !isNonEmptyString(item)))) {
      validationError(`Task source repair field \`${field}\` must be an array of non-empty strings or null.`);
    }
  }

  if ("provider" in payload.source) {
    assertSourceShape(payload.source);
  }

  if (("owner" in payload.source) !== ("repo" in payload.source)) {
    validationError("Task source repair must provide both `owner` and `repo` together.");
  }

  return {
    sourceRef: payload.sourceRef.trim(),
    changeReason: payload.changeReason.trim(),
    source: payload.source,
  };
}

export function mergeTaskSource({
  currentSource,
  patch,
}: {
  currentSource: TaskSource | undefined;
  patch: Record<string, unknown>;
}): TaskSource {
  const base: Record<string, unknown> = currentSource ? { ...currentSource } : {};

  for (const [key, value] of Object.entries(patch)) {
    if (value === null) {
      delete base[key];
      continue;
    }
    base[key] = Array.isArray(value) ? [...value] : value;
  }

  if (!isNonEmptyString(base.provider)) {
    validationError("Task source repair must result in a non-empty `provider`.");
  }
  if ((base.owner && !base.repo) || (!base.owner && base.repo)) {
    validationError("Task source repair must result in both `owner` and `repo` together.");
  }
  assertSourceShape(base);

  const normalized = normalizeTaskSource(base as unknown as TaskSource);
  if (!normalized) {
    validationError("Task source repair produced an invalid task source.");
  }
  return normalized;
}
