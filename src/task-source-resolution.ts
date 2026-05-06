import type { TaskRecord, TaskSubmission } from "./task-store.ts";

type TaskLookup = ((taskId: string) => TaskRecord | null) | null | undefined;

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

export function getLatestTaskSubmission(task: TaskRecord | null): TaskSubmission | null {
  if (!task || !Array.isArray(task.submissions) || task.submissions.length === 0) {
    return null;
  }

  if (task.latestSubmissionId) {
    const matching = task.submissions.find((submission) => submission.id === task.latestSubmissionId);
    if (matching) {
      return matching;
    }
  }

  return task.submissions[task.submissions.length - 1] ?? null;
}

export function resolveTaskSource(
  taskId: string,
  { getTask }: { getTask?: TaskLookup } = {},
): Record<string, unknown> | null {
  const task = typeof getTask === "function" ? getTask(taskId) : null;
  const persistedSource = isObject(task?.source) ? task.source : null;
  const latestSubmission = getLatestTaskSubmission(task);

  if (!persistedSource) {
    return null;
  }

  const source: Record<string, unknown> = { ...persistedSource };

  if (source.submissionId == null && task?.latestSubmissionId) {
    source.submissionId = task.latestSubmissionId;
  }

  if (source.pullNumber == null && latestSubmission?.prNumber != null) {
    source.pullNumber = latestSubmission.prNumber;
  }

  if (source.prUrl == null && latestSubmission?.prUrl) {
    source.prUrl = latestSubmission.prUrl;
  }

  if (source.branch == null && latestSubmission?.branch) {
    source.branch = latestSubmission.branch;
  }

  if (source.baseBranch == null && latestSubmission?.baseBranch) {
    source.baseBranch = latestSubmission.baseBranch;
  }

  if (source.headSha == null && latestSubmission?.headSha) {
    source.headSha = latestSubmission.headSha;
  }

  return source;
}
