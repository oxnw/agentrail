export interface TaskSourceFields {
  owner?: string;
  repo?: string;
  issueNumber?: number;
  linearIssueId?: string;
  linearIdentifier?: string;
  linearTeamId?: string;
  linearTeamKey?: string;
  linearWorkspaceId?: string;
  linearWorkspaceUrlKey?: string;
  // Linear workflow state metadata mirrored into the persisted task source.
  workflowStateId?: string;
  workflowStateName?: string;
  workflowStateType?: string;
  branch?: string;
  baseBranch?: string;
  headSha?: string;
  projectSlug?: string;
  ciProvider?: string;
  reviewers?: string[];
  pullNumber?: number;
  prUrl?: string;
  submissionId?: string;
  mergedSha?: string;
  labels?: string[];
  assignees?: string[];
  deliveryId?: string;
  receivedAt?: string;
}

export interface LinearTaskSource extends TaskSourceFields {
  provider: "linear";
}

export interface RepoTaskSource extends TaskSourceFields {
  provider: "github" | "gitlab";
}

export interface SyntheticTaskSource extends TaskSourceFields {
  provider: "agentrail_setup";
}

export type TaskSource = LinearTaskSource | RepoTaskSource | SyntheticTaskSource;

const COMMON_FIELDS: ReadonlyArray<keyof TaskSourceFields> = [
  "labels",
  "assignees",
  "deliveryId",
  "receivedAt",
];

const LINEAR_FIELDS: ReadonlyArray<keyof TaskSourceFields | "provider"> = [
  "provider",
  "owner",
  "repo",
  "branch",
  "baseBranch",
  "headSha",
  "projectSlug",
  "ciProvider",
  "reviewers",
  "pullNumber",
  "prUrl",
  "submissionId",
  "mergedSha",
  "linearIssueId",
  "linearIdentifier",
  "linearTeamId",
  "linearTeamKey",
  "linearWorkspaceId",
  "linearWorkspaceUrlKey",
  "workflowStateId",
  "workflowStateName",
  "workflowStateType",
  ...COMMON_FIELDS,
];

const REPO_FIELDS: ReadonlyArray<keyof TaskSourceFields | "provider"> = [
  "provider",
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
  "mergedSha",
  ...COMMON_FIELDS,
];

const SYNTHETIC_FIELDS: ReadonlyArray<keyof TaskSourceFields | "provider"> = [
  "provider",
  "owner",
  "repo",
  ...COMMON_FIELDS,
];

function copyFields(source: Record<string, unknown>, fields: ReadonlyArray<string>): Record<string, unknown> {
  const copied: Record<string, unknown> = {};
  for (const field of fields) {
    if (source[field] !== undefined) {
      copied[field] = source[field];
    }
  }
  return copied;
}

export function isLinearTaskSource(source: TaskSource | null | undefined): source is LinearTaskSource {
  return source?.provider === "linear";
}

export function isRepoTaskSource(source: TaskSource | null | undefined): source is RepoTaskSource {
  return source?.provider === "github" || source?.provider === "gitlab";
}

export function normalizeTaskSource(source: TaskSource | null | undefined): TaskSource | undefined {
  if (!source) {
    return undefined;
  }

  const sourceRecord = source as unknown as Record<string, unknown>;

  if (source.provider === "linear") {
    return copyFields(sourceRecord, LINEAR_FIELDS) as unknown as LinearTaskSource;
  }

  if (source.provider === "github" || source.provider === "gitlab") {
    const normalized = copyFields(sourceRecord, REPO_FIELDS) as unknown as RepoTaskSource;
    // Treat owner and repo atomically so we never persist half of a repo identity.
    if (!normalized.owner || !normalized.repo) {
      delete normalized.owner;
      delete normalized.repo;
    }
    return normalized;
  }

  if (source.provider === "agentrail_setup") {
    const normalized = copyFields(sourceRecord, SYNTHETIC_FIELDS) as unknown as SyntheticTaskSource;
    // Treat owner and repo atomically so we never persist half of a repo identity.
    if (!normalized.owner || !normalized.repo) {
      delete normalized.owner;
      delete normalized.repo;
    }
    return normalized;
  }

  return undefined;
}

export function getTaskSourceRepoKey(source: TaskSource | null | undefined): string | null {
  if (
    !source
    || !source.owner
    || !source.repo
  ) {
    return null;
  }
  const repoProvider = source.provider === "gitlab" ? "gitlab" : "github";
  return `${repoProvider}:${source.owner}/${source.repo}`;
}
