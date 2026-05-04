// Types generated from docs/api/task-lifecycle.openapi.yaml v0.3.0

// ── Enums ──────────────────────────────────────────────────────────

export type AgentAuthScope =
  | "auth:admin"
  | "ci:read"
  | "events:read"
  | "reviews:read"
  | "ship:write"
  | "tasks:read"
  | "tasks:write"
  | "usage:read"
  | "webhooks:read"
  | "webhooks:write";

export type AgentApiKeyStatus = "active" | "rotated" | "revoked";

export type TaskStatus =
  | "todo"
  | "in_progress"
  | "in_review"
  | "blocked"
  | "done"
  | "cancelled";

export type TaskPriority = "low" | "medium" | "high" | "critical";

export type CiOverallStatus =
  | "queued"
  | "running"
  | "passed"
  | "failed"
  | "cancelled";

export type CiCheckStatus =
  | "queued"
  | "running"
  | "passed"
  | "failed"
  | "cancelled"
  | "skipped";

export type ReviewOutcome = "approved" | "changes_requested" | "pending";

export type CommentSeverity = "must_fix" | "should_fix" | "note";

export type ArtifactType =
  | "pull_request"
  | "commit"
  | "doc"
  | "ci_run"
  | "other";

export type CheckStatus = "passed" | "failed" | "running" | "skipped";

export type ShipMode = "merge_only" | "merge_and_deploy";

export type ShipEnvironment = "staging" | "production";

export type ShipStatus = "queued" | "running" | "succeeded" | "failed";

export type TaskEventType =
  | "task.updated"
  | "task.reviewed"
  | "task.shipped";

export type WebhookSubscriptionStatus = "active" | "disabled";

export type FlakyConfidence = "low" | "medium" | "high";

export type TokenBudgetHint = "compact" | "standard";

// ── Shared primitives ──────────────────────────────────────────────

export interface AgentExternalIdentity {
  provider: string;
  subject: string;
}

export interface AgentIdentity {
  id: string;
  displayName: string;
  role: string;
  externalIdentities: AgentExternalIdentity[];
}

export interface AgentRateLimit {
  windowSeconds: number;
  maxRequests: number;
}

export interface AgentRateLimitWindow {
  startedAt: string;
  resetAt: string;
  used: number;
  remaining: number;
}

export interface ResponseMeta {
  tokenBudgetHint: TokenBudgetHint;
  truncatedFields?: string[];
}

export interface ErrorDetail {
  code: string;
  message: string;
  details: Record<string, unknown>;
}

export interface ErrorResponse {
  error: ErrorDetail;
}

// ── Agent Auth ─────────────────────────────────────────────────────

export interface AgentApiKeyCreateRequest {
  agent: AgentIdentity;
  scopes: AgentAuthScope[];
  rateLimit: AgentRateLimit;
  expiresAt?: string | null;
}

export interface AgentApiKeyRotateRequest {
  expiresAt?: string | null;
}

export interface AgentApiKeyData {
  id: string;
  apiKey: string;
  agent: AgentIdentity;
  scopes: AgentAuthScope[];
  rateLimit: AgentRateLimit;
  status: AgentApiKeyStatus;
  createdAt: string;
  expiresAt: string | null;
  rotatedFromKeyId: string | null;
  availableActions: string[];
}

export interface AgentApiKeyResponse {
  data: AgentApiKeyData;
  availableActions: string[];
}

export interface AgentScopeUsage {
  scope: AgentAuthScope;
  count: number;
}

export interface AgentOperationUsage {
  operation: string;
  count: number;
}

export interface AgentApiKeyUsageData {
  keyId: string;
  agent: AgentIdentity;
  status: AgentApiKeyStatus;
  lastUsedAt: string | null;
  totals: { accepted: number; denied: number };
  byScope: AgentScopeUsage[];
  byOperation: AgentOperationUsage[];
  rateLimit: AgentRateLimit & { currentWindow: AgentRateLimitWindow };
  availableActions: string[];
}

export interface AgentApiKeyUsageResponse {
  data: AgentApiKeyUsageData;
  availableActions: string[];
}

// ── Tasks ──────────────────────────────────────────────────────────

export interface TaskSummary {
  id: string;
  identifier: string;
  title: string;
  status: TaskStatus;
  priority: TaskPriority;
  dueAt: string | null;
  updatedAt: string;
  availableActions: string[];
}

export interface TaskAssignee {
  id: string;
  name: string;
}

export interface TaskLinks {
  issue: string;
  parentIssue?: string | null;
}

export interface TaskContext {
  project: string | null;
  goal: string;
}

export interface TaskDetail {
  id: string;
  identifier: string;
  title: string;
  description: string;
  status: TaskStatus;
  priority: TaskPriority;
  assignee: TaskAssignee;
  acceptanceCriteria: string[];
  links: TaskLinks;
  context: TaskContext;
  updatedAt: string;
  availableActions: string[];
}

export interface PageInfo {
  nextCursor: string | null;
  hasMore: boolean;
}

export interface TaskListResponse {
  data: TaskSummary[];
  page: PageInfo;
  availableActions: string[];
  meta: ResponseMeta;
}

export interface TaskDetailResponse {
  data: TaskDetail;
  availableActions: string[];
  meta: ResponseMeta;
}

// ── Submit ─────────────────────────────────────────────────────────

export interface SubmitArtifact {
  type: ArtifactType;
  url: string;
}

export interface SubmitCheck {
  name: string;
  status: CheckStatus;
}

export interface TaskSubmitRequest {
  summary: string;
  artifacts: SubmitArtifact[];
  checks?: SubmitCheck[];
  notes?: string | null;
}

export interface ReviewParticipant {
  id: string;
  role: string;
}

export interface TaskSubmissionData {
  submissionId: string;
  taskId: string;
  status: "in_review";
  reviewRoute: { participants: ReviewParticipant[] };
  acceptedAt: string;
  availableActions: string[];
}

export interface TaskSubmissionResponse {
  data: TaskSubmissionData;
  availableActions: string[];
}

// ── CI Status ──────────────────────────────────────────────────────

export interface CiSummary {
  total: number;
  passed: number;
  failed: number;
  running: number;
  queued: number;
  cancelled: number;
  skipped: number;
}

export interface CiWorkflow {
  name: string;
  path: string | null;
  status: CiCheckStatus;
  passed: number;
  failed: number;
  running: number;
  queued: number;
  cancelled: number;
  skipped: number;
  url: string | null;
}

export interface CiCheck {
  name: string;
  workflow: string;
  status: CiCheckStatus;
  url: string | null;
  durationSeconds: number | null;
  failureCount: number;
}

export interface CiFailureSummary {
  checkName: string;
  workflow: string;
  testName: string;
  file: string | null;
  line: number | null;
  message: string;
}

export interface CiFlakyHint {
  checkName: string;
  confidence: FlakyConfidence;
  reason: string;
}

export interface TaskCiStatusData {
  taskId: string;
  submissionId: string | null;
  overallStatus: CiOverallStatus;
  summary: CiSummary;
  workflows: CiWorkflow[];
  checks: CiCheck[];
  failureSummaries: CiFailureSummary[];
  flakyHints: CiFlakyHint[];
  updatedAt: string | null;
  availableActions: string[];
}

export interface TaskCiStatusResponse {
  data: TaskCiStatusData;
  availableActions: string[];
  meta: ResponseMeta;
}

// ── Review Feedback ────────────────────────────────────────────────

export interface ReviewDecision {
  outcome: ReviewOutcome;
  reviewer: { id: string; role: string };
  createdAt: string;
  summary: string;
}

export interface ReviewComment {
  id: string;
  authorRole: string;
  body: string;
  severity: CommentSeverity;
}

export interface TaskReviewFeedbackData {
  taskId: string;
  latestDecision: ReviewDecision;
  comments: ReviewComment[];
  availableActions: string[];
}

export interface TaskReviewFeedbackResponse {
  data: TaskReviewFeedbackData;
  availableActions: string[];
}

// ── Ship ───────────────────────────────────────────────────────────

export interface TaskShipRequest {
  mode: ShipMode;
  targetEnvironment: ShipEnvironment;
  expectedHeadSha: string;
}

export interface TaskShipData {
  taskId: string;
  operationId: string;
  status: ShipStatus;
  queuedAt: string;
  availableActions: string[];
}

export interface TaskShipResponse {
  data: TaskShipData;
  availableActions: string[];
}

// ── Webhooks ───────────────────────────────────────────────────────

export interface WebhookFilters {
  taskIds?: string[];
}

export interface TaskWebhookSubscriptionCreateRequest {
  url: string;
  eventTypes: TaskEventType[];
  secret: string;
  description?: string | null;
  filters?: WebhookFilters;
}

export interface WebhookRetryPolicy {
  maxAttempts: number;
  initialBackoffSeconds: number;
  maxBackoffSeconds: number;
}

export interface TaskWebhookSubscriptionData {
  id: string;
  url: string;
  eventTypes: TaskEventType[];
  filters: WebhookFilters;
  status: WebhookSubscriptionStatus;
  signingAlgorithm: "hmac_sha256";
  retryPolicy: WebhookRetryPolicy;
  createdAt: string;
  availableActions: string[];
}

export interface TaskWebhookSubscriptionResponse {
  data: TaskWebhookSubscriptionData;
  availableActions: string[];
}

export interface TaskWebhookSubscriptionListResponse {
  data: TaskWebhookSubscriptionData[];
  availableActions: string[];
}

// ── Task Events ────────────────────────────────────────────────────

export interface TaskEventActor {
  id: string;
  role: string;
}

export interface TaskEventLinks {
  task: string;
  reviewFeedback?: string | null;
  ciStatus?: string | null;
  shipOperation?: string | null;
}

export interface TaskUpdatedEventData {
  taskId: string;
  taskIdentifier: string;
  status: TaskStatus;
  previousStatus: TaskStatus | null;
  changedFields: string[];
  actor: TaskEventActor;
  summary: string;
  availableActions: string[];
  links: TaskEventLinks;
}

export interface TaskReviewedEventData {
  taskId: string;
  taskIdentifier: string;
  status: TaskStatus;
  reviewOutcome: "approved" | "changes_requested";
  reviewer: TaskEventActor;
  summary: string;
  availableActions: string[];
  links: TaskEventLinks;
}

export interface TaskShippedEventData {
  taskId: string;
  taskIdentifier: string;
  status: TaskStatus;
  shipStatus: ShipStatus;
  operationId: string;
  targetEnvironment: ShipEnvironment;
  summary: string;
  availableActions: string[];
  links: TaskEventLinks;
}

interface BaseEvent {
  id: string;
  occurredAt: string;
  sequence: number;
  taskVersion: number;
  traceId: string | null;
}

export interface TaskUpdatedEvent extends BaseEvent {
  type: "task.updated";
  data: TaskUpdatedEventData;
}

export interface TaskReviewedEvent extends BaseEvent {
  type: "task.reviewed";
  data: TaskReviewedEventData;
}

export interface TaskShippedEvent extends BaseEvent {
  type: "task.shipped";
  data: TaskShippedEventData;
}

export type TaskLifecycleEvent =
  | TaskUpdatedEvent
  | TaskReviewedEvent
  | TaskShippedEvent;

// ── Client options ─────────────────────────────────────────────────

export interface AgentRailClientOptions {
  baseUrl?: string;
  apiKey: string;
  retry?: RetryOptions;
}

export interface RetryOptions {
  maxAttempts?: number;
  initialDelayMs?: number;
  maxDelayMs?: number;
  retryableStatusCodes?: number[];
}

export interface ListMyTasksOptions {
  status?: TaskStatus;
  limit?: number;
  cursor?: string;
}

export interface StreamOptions {
  eventTypes?: TaskEventType[];
  taskId?: string;
  cursor?: string;
  heartbeatSeconds?: number;
  signal?: AbortSignal;
}

export interface WebhookHeaders {
  "x-agentrail-webhook-id": string;
  "x-agentrail-event-id": string;
  "x-agentrail-event-type": TaskEventType;
  "x-agentrail-delivery-id": string;
  "x-agentrail-delivery-attempt": string;
  "x-agentrail-signature": string;
}
