import type { TaskRecord, TaskSubmission } from "./task-store.ts";

type TaskSourceInput = Map<string, unknown> | Record<string, unknown> | null | undefined;
type TaskLookup = ((taskId: string) => TaskRecord | null) | null | undefined;

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function lookupConfiguredTaskSource(taskSources: TaskSourceInput, taskId: string): Record<string, unknown> | null {
  if (taskSources instanceof Map) {
    const source = taskSources.get(taskId);
    return isObject(source) ? source : null;
  }

  const source = taskSources?.[taskId];
  return isObject(source) ? source : null;
}

export function getLatestTaskSubmission(task: TaskRecord | null): TaskSubmission | null {
  if (!task || task.submissions.length === 0) {
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
  { taskSources, getTask }: { taskSources?: TaskSourceInput; getTask?: TaskLookup } = {},
): Record<string, unknown> | null {
  const configuredSource = lookupConfiguredTaskSource(taskSources, taskId);
  const task = typeof getTask === "function" ? getTask(taskId) : null;
  const persistedSource = isObject(task?.source) ? task.source : null;
  const latestSubmission = getLatestTaskSubmission(task);

  if (!configuredSource && !persistedSource && !latestSubmission) {
    return null;
  }

  const source: Record<string, unknown> = {
    ...(configuredSource ?? {}),
    ...(persistedSource ?? {}),
  };

  if (source.submissionId == null && task?.latestSubmissionId) {
    source.submissionId = task.latestSubmissionId;
  }

  if (source.pullNumber == null && latestSubmission?.prNumber != null) {
    source.pullNumber = latestSubmission.prNumber;
  }

  if (source.prUrl == null && latestSubmission?.prUrl) {
    source.prUrl = latestSubmission.prUrl;
  }

  return source;
}
