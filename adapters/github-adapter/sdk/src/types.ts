export type TaskPriority = "critical" | "high" | "medium" | "low";
export type TaskStatus = "todo" | "in_progress" | "in_review" | "done" | "blocked";
export type FeedbackSeverity = "required" | "suggestion" | "nitpick";

export interface LinkedPR {
  number: number;
  url: string;
  title: string;
  state: string;
}

export interface TaskComment {
  id: number;
  author: string;
  body: string;
  createdAt: string;
}

export interface Task {
  id: string;
  source: "github";
  repo: string;
  number: number;
  title: string;
  body: string;
  status: TaskStatus;
  priority: TaskPriority;
  labels: string[];
  assignees: string[];
  acceptanceCriteria: string[];
  linkedPRs: LinkedPR[];
  comments: TaskComment[];
  url: string;
  createdAt: string;
  updatedAt: string;
  availableActions: string[];
  meta: { tokenBudgetHint: number };
}

export interface TaskSummary {
  id: string;
  source: "github";
  repo: string;
  number: number;
  title: string;
  status: TaskStatus;
  priority: TaskPriority;
  labels: string[];
  url: string;
  updatedAt: string;
  availableActions: string[];
}

export interface TaskListResponse {
  tasks: TaskSummary[];
  cursor: string | null;
  hasMore: boolean;
  meta: { tokenBudgetHint: number };
}

export interface TaskDetailResponse {
  task: Task;
}

export interface SubmitRequest {
  head: string;
  base?: string;
  title?: string;
  body?: string;
  reviewers?: string[];
  draft?: boolean;
}

export interface SubmitResult {
  action: "created" | "existing";
  pr: LinkedPR & {
    draft: boolean;
    base: string;
    head: string;
    reviewers: string[];
    checksStatus: "pending" | "passing" | "failing" | "unknown";
  };
  issueNumber: number;
  availableActions: string[];
}

export interface ShipResult {
  action: "merged" | "closed_issue";
  pr: {
    number: number;
    url: string;
    merged: boolean;
    mergeCommitSha: string | null;
  };
  issue: {
    number: number;
    url: string;
    state: string;
  };
  availableActions: string[];
}

export interface ShipBlockedResult {
  action: "blocked";
  reason: string;
  code: "merge_conflict" | "checks_failing" | "review_required" | "branch_protection" | "not_mergeable";
  pr: {
    number: number;
    url: string;
    mergeable: boolean | null;
    mergeableState: string;
  };
  availableActions: string[];
}

export interface ReviewFeedbackItem {
  id: string;
  reviewer: string;
  severity: FeedbackSeverity;
  file: string | null;
  line: number | null;
  request: string;
  suggestedAction: string | null;
  url: string;
  createdAt: string;
  source: "review" | "review_comment" | "issue_comment";
}

export interface ReviewFeedbackResponse {
  taskId: string;
  prNumber: number;
  feedback: ReviewFeedbackItem[];
  summary: {
    total: number;
    required: number;
    suggestion: number;
    nitpick: number;
  };
  availableActions: string[];
}

export interface ErrorResponse {
  error: string;
  code: string;
  availableActions: string[];
}

export interface WebhookRegistration {
  id: string;
  url: string;
  events: WebhookEvent[];
  active: boolean;
  createdAt: string;
}

export type WebhookEvent =
  | "task.created"
  | "task.updated"
  | "task.submitted"
  | "task.shipped"
  | "task.review_feedback"
  | "task.status_changed";

export interface WebhookPayload {
  event: WebhookEvent;
  taskId: string;
  timestamp: string;
  data: Record<string, unknown>;
}

export interface ClientConfig {
  baseUrl: string;
  token: string;
  retries?: number;
  retryDelayMs?: number;
  timeoutMs?: number;
}
