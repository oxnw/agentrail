"""Pydantic models generated from docs/api/task-lifecycle.openapi.yaml v0.3.0."""

from __future__ import annotations

from datetime import datetime
from enum import Enum
from typing import Annotated, Literal, Union

from pydantic import AliasChoices, BaseModel, Field


# ── Enums ──────────────────────────────────────────────────────────


class AgentAuthScope(str, Enum):
    AUTH_ADMIN = "auth:admin"
    CI_READ = "ci:read"
    EVENTS_READ = "events:read"
    PROVIDERS_WRITE = "providers:write"
    ROUTING_ADMIN = "routing:admin"
    ROUTING_EVALUATE = "routing:evaluate"
    ROUTING_READ = "routing:read"
    REVIEWS_READ = "reviews:read"
    SHIP_WRITE = "ship:write"
    TASKS_READ = "tasks:read"
    TASKS_WRITE = "tasks:write"
    USAGE_READ = "usage:read"
    WEBHOOKS_READ = "webhooks:read"
    WEBHOOKS_WRITE = "webhooks:write"


class AgentApiKeyStatus(str, Enum):
    ACTIVE = "active"
    ROTATED = "rotated"
    REVOKED = "revoked"


class TaskStatus(str, Enum):
    TODO = "todo"
    IN_PROGRESS = "in_progress"
    IN_REVIEW = "in_review"
    BLOCKED = "blocked"
    DONE = "done"
    CANCELLED = "cancelled"


class TaskPriority(str, Enum):
    LOW = "low"
    MEDIUM = "medium"
    HIGH = "high"
    CRITICAL = "critical"


class CiOverallStatus(str, Enum):
    QUEUED = "queued"
    RUNNING = "running"
    PASSED = "passed"
    FAILED = "failed"
    CANCELLED = "cancelled"


class CiCheckStatus(str, Enum):
    QUEUED = "queued"
    RUNNING = "running"
    PASSED = "passed"
    FAILED = "failed"
    CANCELLED = "cancelled"
    SKIPPED = "skipped"


class ReviewOutcome(str, Enum):
    APPROVED = "approved"
    CHANGES_REQUESTED = "changes_requested"
    PENDING = "pending"
    NOT_REQUIRED = "not_required"


class CommentSeverity(str, Enum):
    MUST_FIX = "must_fix"
    SHOULD_FIX = "should_fix"
    NOTE = "note"


class ArtifactType(str, Enum):
    PULL_REQUEST = "pull_request"
    COMMIT = "commit"
    DOC = "doc"
    CI_RUN = "ci_run"
    OTHER = "other"


class CheckStatus(str, Enum):
    PASSED = "passed"
    FAILED = "failed"
    RUNNING = "running"
    SKIPPED = "skipped"


class TaskSubmitMode(str, Enum):
    ADAPTER_MANAGED = "adapter_managed"
    ARTIFACT = "artifact"


class TaskSubmissionAction(str, Enum):
    CREATED = "created"
    EXISTING = "existing"
    ACCEPTED = "accepted"


class TaskAssignmentSource(str, Enum):
    DETERMINISTIC_RULE = "deterministic_rule"
    CLASSIFIER = "classifier"
    MANUAL_TRIAGE = "manual_triage"
    PROVIDER_ASSIGNEE_MAPPING = "provider_assignee_mapping"


class ShipMode(str, Enum):
    MERGE_ONLY = "merge_only"
    MERGE_AND_DEPLOY = "merge_and_deploy"


class ShipEnvironment(str, Enum):
    STAGING = "staging"
    PRODUCTION = "production"


class ShipStatus(str, Enum):
    QUEUED = "queued"
    RUNNING = "running"
    SUCCEEDED = "succeeded"
    FAILED = "failed"


class TaskEventType(str, Enum):
    TASK_UPDATED = "task.updated"
    TASK_AWAITING_USER = "task.awaiting_user"
    TASK_REVIEWED = "task.reviewed"
    TASK_SHIPPED = "task.shipped"


class EventSubscriptionStatus(str, Enum):
    ACTIVE = "active"
    DISABLED = "disabled"


WebhookSubscriptionStatus = EventSubscriptionStatus


class FlakyConfidence(str, Enum):
    LOW = "low"
    MEDIUM = "medium"
    HIGH = "high"


class TokenBudgetHint(str, Enum):
    COMPACT = "compact"
    STANDARD = "standard"


# ── Shared primitives ──────────────────────────────────────────────


class AgentExternalIdentity(BaseModel):
    provider: str
    subject: str


class AgentIdentity(BaseModel):
    id: str
    display_name: str = Field(alias="displayName")
    role: str
    external_identities: list[AgentExternalIdentity] = Field(alias="externalIdentities")

    model_config = {"populate_by_name": True}


class AgentRateLimit(BaseModel):
    window_seconds: int = Field(alias="windowSeconds")
    max_requests: int = Field(alias="maxRequests")

    model_config = {"populate_by_name": True}


class AgentRateLimitWindow(BaseModel):
    started_at: datetime = Field(alias="startedAt")
    reset_at: datetime = Field(alias="resetAt")
    used: int
    remaining: int

    model_config = {"populate_by_name": True}


class ResponseMeta(BaseModel):
    token_budget_hint: TokenBudgetHint = Field(alias="tokenBudgetHint")
    truncated_fields: list[str] | None = Field(default=None, alias="truncatedFields")

    model_config = {"populate_by_name": True}


class ErrorDetail(BaseModel):
    code: str
    message: str
    details: dict[str, object]


class ErrorResponse(BaseModel):
    error: ErrorDetail


# ── Agent Auth ─────────────────────────────────────────────────────


class AgentApiKeyCreateRequest(BaseModel):
    agent: AgentIdentity
    scopes: list[AgentAuthScope]
    rate_limit: AgentRateLimit = Field(alias="rateLimit")
    expires_at: datetime | None = Field(default=None, alias="expiresAt")

    model_config = {"populate_by_name": True, "by_alias": True}


class AgentApiKeyRotateRequest(BaseModel):
    expires_at: datetime | None = Field(default=None, alias="expiresAt")

    model_config = {"populate_by_name": True, "by_alias": True}


class AgentApiKeyData(BaseModel):
    id: str
    api_key: str = Field(alias="apiKey")
    agent: AgentIdentity
    scopes: list[AgentAuthScope]
    rate_limit: AgentRateLimit = Field(alias="rateLimit")
    status: AgentApiKeyStatus
    created_at: datetime = Field(alias="createdAt")
    expires_at: datetime | None = Field(alias="expiresAt")
    rotated_from_key_id: str | None = Field(alias="rotatedFromKeyId")
    available_actions: list[str] = Field(alias="availableActions")

    model_config = {"populate_by_name": True}


class AgentApiKeyResponse(BaseModel):
    data: AgentApiKeyData
    available_actions: list[str] = Field(alias="availableActions")

    model_config = {"populate_by_name": True}


class AgentScopeUsage(BaseModel):
    scope: AgentAuthScope
    count: int


class AgentOperationUsage(BaseModel):
    operation: str
    count: int


class UsageRateLimit(BaseModel):
    window_seconds: int = Field(alias="windowSeconds")
    max_requests: int = Field(alias="maxRequests")
    current_window: AgentRateLimitWindow = Field(alias="currentWindow")

    model_config = {"populate_by_name": True}


class AgentApiKeyUsageData(BaseModel):
    key_id: str = Field(alias="keyId")
    agent: AgentIdentity
    status: AgentApiKeyStatus
    last_used_at: datetime | None = Field(alias="lastUsedAt")
    totals: dict[str, int]
    by_scope: list[AgentScopeUsage] = Field(alias="byScope")
    by_operation: list[AgentOperationUsage] = Field(alias="byOperation")
    rate_limit: UsageRateLimit = Field(alias="rateLimit")
    available_actions: list[str] = Field(alias="availableActions")

    model_config = {"populate_by_name": True}


class AgentApiKeyUsageResponse(BaseModel):
    data: AgentApiKeyUsageData
    available_actions: list[str] = Field(alias="availableActions")

    model_config = {"populate_by_name": True}


# ── Tasks ──────────────────────────────────────────────────────────


class TaskBlocker(BaseModel):
    kind: Literal["awaiting_user"]
    source_run_id: str = Field(alias="sourceRunId")
    source_agent_id: str = Field(alias="sourceAgentId")
    reason: str
    action_required: str = Field(alias="actionRequired")
    resume_instructions: str = Field(alias="resumeInstructions")
    created_at: datetime = Field(alias="createdAt")

    model_config = {"populate_by_name": True}


class TaskSummary(BaseModel):
    id: str
    identifier: str
    title: str
    status: TaskStatus
    priority: TaskPriority
    due_at: datetime | None = Field(default=None, alias="dueAt")
    updated_at: datetime = Field(alias="updatedAt")
    blocker: TaskBlocker | None = None
    available_actions: list[str] = Field(alias="availableActions")

    model_config = {"populate_by_name": True}


class TaskAssignee(BaseModel):
    id: str
    name: str


class TaskLinks(BaseModel):
    issue: str
    parent_issue: str | None = Field(default=None, alias="parentIssue")

    model_config = {"populate_by_name": True}


class TaskContext(BaseModel):
    project: str | None
    goal: str


class TaskRoutingTarget(BaseModel):
    type: Literal["agent", "triage_queue"]
    id: str


class TaskRoutingClassifierResult(BaseModel):
    provider: str
    confidence: float
    suggested_target: TaskRoutingTarget = Field(alias="suggestedTarget")

    model_config = {"populate_by_name": True}


class TaskRoutingMatchedRule(BaseModel):
    id: str
    name: str
    confidence: float


class TaskRoutingReason(BaseModel):
    summary: str
    matched_rules: list[TaskRoutingMatchedRule] = Field(alias="matchedRules")
    classifier: TaskRoutingClassifierResult | None
    conflict_reasons: list[str] = Field(alias="conflictReasons")

    model_config = {"populate_by_name": True}


class TaskDetail(BaseModel):
    id: str
    identifier: str
    title: str
    description: str
    status: TaskStatus
    priority: TaskPriority
    assignee: TaskAssignee
    acceptance_criteria: list[str] = Field(alias="acceptanceCriteria")
    links: TaskLinks
    context: TaskContext
    updated_at: datetime = Field(alias="updatedAt")
    submission_id: str | None = Field(default=None, alias="submissionId")
    pr_url: str | None = Field(default=None, alias="prUrl")
    pr_number: int | None = Field(default=None, alias="prNumber")
    branch: str | None = None
    base_branch: str | None = Field(default=None, alias="baseBranch")
    head_sha: str | None = Field(default=None, alias="headSha")
    assignee_agent_id: str | None = Field(default=None, alias="assigneeAgentId")
    triage_queue_id: str | None = Field(default=None, alias="triageQueueId")
    assignment_source: TaskAssignmentSource | None = Field(default=None, alias="assignmentSource")
    routing_decision_id: str | None = Field(default=None, alias="routingDecisionId")
    routing_reason: TaskRoutingReason | None = Field(default=None, alias="routingReason")
    routing_confidence: float | None = Field(default=None, alias="routingConfidence")
    blocker: TaskBlocker | None = None
    available_actions: list[str] = Field(alias="availableActions")

    model_config = {"populate_by_name": True}


class PageInfo(BaseModel):
    next_cursor: str | None = Field(alias="nextCursor")
    has_more: bool = Field(alias="hasMore")

    model_config = {"populate_by_name": True}


class TaskListResponse(BaseModel):
    data: list[TaskSummary]
    page: PageInfo
    available_actions: list[str] = Field(alias="availableActions")
    meta: ResponseMeta

    model_config = {"populate_by_name": True}


class TaskDetailResponse(BaseModel):
    data: TaskDetail
    available_actions: list[str] = Field(alias="availableActions")
    meta: ResponseMeta

    model_config = {"populate_by_name": True}


# ── Submit ─────────────────────────────────────────────────────────


class SubmitArtifact(BaseModel):
    type: ArtifactType
    url: str

    model_config = {"by_alias": True}


class SubmitCheck(BaseModel):
    name: str
    status: CheckStatus

    model_config = {"by_alias": True}


class PullRequestSubmitOptions(BaseModel):
    title: str | None = None
    body: str | None = None
    head: str | None = None
    base: str | None = None
    draft: bool | None = None
    reviewers: list[str] | None = None

    model_config = {"populate_by_name": True, "by_alias": True}


class TaskSubmitRequest(BaseModel):
    summary: str
    mode: TaskSubmitMode | None = None
    pull_request: PullRequestSubmitOptions | None = Field(default=None, alias="pullRequest")
    artifacts: list[SubmitArtifact] | None = None
    checks: list[SubmitCheck] | None = None
    notes: str | None = None

    model_config = {"populate_by_name": True, "by_alias": True}


class ReviewParticipant(BaseModel):
    id: str
    role: str


class ReviewRoute(BaseModel):
    participants: list[ReviewParticipant]


class TaskSubmissionData(BaseModel):
    submission_id: str = Field(alias="submissionId")
    task_id: str = Field(alias="taskId")
    status: Literal["in_review"]
    review_route: ReviewRoute | None = Field(default=None, alias="reviewRoute")
    pr_url: str | None = Field(default=None, alias="prUrl")
    pr_number: int | None = Field(default=None, alias="prNumber")
    head: str | None = None
    base: str | None = None
    head_sha: str | None = Field(default=None, alias="headSha")
    action: TaskSubmissionAction | None = None
    idempotency_key: str | None = Field(default=None, alias="idempotencyKey")
    accepted_at: datetime = Field(alias="acceptedAt")
    available_actions: list[str] = Field(alias="availableActions")

    model_config = {"populate_by_name": True}


class TaskSubmissionResponse(BaseModel):
    data: TaskSubmissionData
    available_actions: list[str] = Field(alias="availableActions")

    model_config = {"populate_by_name": True}


# ── Linear Provider Sync ──────────────────────────────────────────


class LinearTaskCommentRequest(BaseModel):
    body: str = Field(min_length=1)

    model_config = {"populate_by_name": True, "by_alias": True}


class LinearTaskCommentData(BaseModel):
    task_id: str = Field(alias="taskId")
    linear_issue_id: str = Field(alias="linearIssueId")
    comment_id: str | None = Field(default=None, alias="commentId")
    comment_url: str | None = Field(default=None, alias="commentUrl")
    success: bool
    synced_at: datetime = Field(alias="syncedAt")
    available_actions: list[str] = Field(alias="availableActions")

    model_config = {"populate_by_name": True}


class LinearTaskCommentResponse(BaseModel):
    data: LinearTaskCommentData
    available_actions: list[str] = Field(alias="availableActions")

    model_config = {"populate_by_name": True}


class LinearTaskWorkflowStateRequest(BaseModel):
    state_id: str = Field(alias="stateId")

    model_config = {"populate_by_name": True, "by_alias": True}


class LinearTaskWorkflowStateData(BaseModel):
    task_id: str = Field(alias="taskId")
    linear_issue_id: str = Field(alias="linearIssueId")
    state_id: str = Field(alias="stateId")
    state_name: str | None = Field(default=None, alias="stateName")
    success: bool
    agentrail_status: TaskStatus = Field(
        alias="agentRailStatus",
        validation_alias=AliasChoices("agentRailStatus", "agentrailStatus"),
    )
    synced_at: datetime = Field(alias="syncedAt")
    available_actions: list[str] = Field(alias="availableActions")

    model_config = {"populate_by_name": True}


class LinearTaskWorkflowStateResponse(BaseModel):
    data: LinearTaskWorkflowStateData
    available_actions: list[str] = Field(alias="availableActions")

    model_config = {"populate_by_name": True}


# ── CI Status ──────────────────────────────────────────────────────


class CiSummary(BaseModel):
    total: int
    passed: int
    failed: int
    running: int
    queued: int
    cancelled: int
    skipped: int


class CiWorkflow(BaseModel):
    name: str
    path: str | None
    status: CiCheckStatus
    passed: int
    failed: int
    running: int
    queued: int
    cancelled: int
    skipped: int
    url: str | None


class CiCheck(BaseModel):
    name: str
    workflow: str
    status: CiCheckStatus
    url: str | None
    duration_seconds: int | None = Field(alias="durationSeconds")
    failure_count: int = Field(alias="failureCount")

    model_config = {"populate_by_name": True}


class CiFailureSummary(BaseModel):
    check_name: str = Field(alias="checkName")
    workflow: str
    test_name: str = Field(alias="testName")
    file: str | None
    line: int | None
    message: str

    model_config = {"populate_by_name": True}


class CiFlakyHint(BaseModel):
    check_name: str = Field(alias="checkName")
    confidence: FlakyConfidence
    reason: str

    model_config = {"populate_by_name": True}


class TaskCiStatusData(BaseModel):
    task_id: str = Field(alias="taskId")
    submission_id: str | None = Field(alias="submissionId")
    overall_status: CiOverallStatus = Field(alias="overallStatus")
    summary: CiSummary
    workflows: list[CiWorkflow]
    checks: list[CiCheck]
    failure_summaries: list[CiFailureSummary] = Field(alias="failureSummaries")
    flaky_hints: list[CiFlakyHint] = Field(alias="flakyHints")
    updated_at: datetime | None = Field(alias="updatedAt")
    head_sha: str | None = Field(default=None, alias="headSha")
    available_actions: list[str] = Field(alias="availableActions")

    model_config = {"populate_by_name": True}


class TaskCiStatusResponse(BaseModel):
    data: TaskCiStatusData
    available_actions: list[str] = Field(alias="availableActions")
    meta: ResponseMeta

    model_config = {"populate_by_name": True}


# ── Review Feedback ────────────────────────────────────────────────


class ReviewDecision(BaseModel):
    outcome: ReviewOutcome
    reviewer: ReviewParticipant
    created_at: datetime = Field(alias="createdAt")
    head_sha: str | None = Field(default=None, alias="headSha")
    summary: str

    model_config = {"populate_by_name": True}


class ReviewComment(BaseModel):
    id: str
    author_role: str = Field(alias="authorRole")
    body: str
    severity: CommentSeverity

    model_config = {"populate_by_name": True}


class TaskReviewFeedbackData(BaseModel):
    task_id: str = Field(alias="taskId")
    latest_decision: ReviewDecision = Field(alias="latestDecision")
    comments: list[ReviewComment]
    available_actions: list[str] = Field(alias="availableActions")

    model_config = {"populate_by_name": True}


class TaskReviewFeedbackResponse(BaseModel):
    data: TaskReviewFeedbackData
    available_actions: list[str] = Field(alias="availableActions")

    model_config = {"populate_by_name": True}


# ── Ship ───────────────────────────────────────────────────────────


class TaskShipRequest(BaseModel):
    mode: ShipMode
    target_environment: ShipEnvironment = Field(alias="targetEnvironment")
    expected_head_sha: str = Field(alias="expectedHeadSha")

    model_config = {"populate_by_name": True, "by_alias": True}


class TaskShipData(BaseModel):
    task_id: str = Field(alias="taskId")
    operation_id: str = Field(alias="operationId")
    status: ShipStatus
    queued_at: datetime = Field(alias="queuedAt")
    available_actions: list[str] = Field(alias="availableActions")

    model_config = {"populate_by_name": True}


class TaskShipResponse(BaseModel):
    data: TaskShipData
    available_actions: list[str] = Field(alias="availableActions")

    model_config = {"populate_by_name": True}


# ── Webhooks ───────────────────────────────────────────────────────


class WebhookFilters(BaseModel):
    task_ids: list[str] | None = Field(default=None, alias="taskIds")

    model_config = {"populate_by_name": True, "by_alias": True}


class TaskWebhookSubscriptionCreateRequest(BaseModel):
    url: str
    event_types: list[TaskEventType] = Field(alias="eventTypes")
    secret: str
    description: str | None = None
    filters: WebhookFilters | None = None

    model_config = {"populate_by_name": True, "by_alias": True}


class WebhookRetryPolicy(BaseModel):
    max_attempts: int = Field(alias="maxAttempts")
    initial_backoff_seconds: int = Field(alias="initialBackoffSeconds")
    max_backoff_seconds: int = Field(alias="maxBackoffSeconds")

    model_config = {"populate_by_name": True}


class TaskWebhookSubscriptionData(BaseModel):
    id: str
    url: str
    event_types: list[TaskEventType] = Field(alias="eventTypes")
    filters: WebhookFilters
    status: WebhookSubscriptionStatus
    signing_algorithm: Literal["hmac_sha256"] = Field(alias="signingAlgorithm")
    retry_policy: WebhookRetryPolicy = Field(alias="retryPolicy")
    created_at: datetime = Field(alias="createdAt")
    available_actions: list[str] = Field(alias="availableActions")

    model_config = {"populate_by_name": True}


class TaskWebhookSubscriptionResponse(BaseModel):
    data: TaskWebhookSubscriptionData
    available_actions: list[str] = Field(alias="availableActions")

    model_config = {"populate_by_name": True}


class TaskWebhookSubscriptionListResponse(BaseModel):
    data: list[TaskWebhookSubscriptionData]
    available_actions: list[str] = Field(alias="availableActions")

    model_config = {"populate_by_name": True}


EventSubscriptionCreateRequest = TaskWebhookSubscriptionCreateRequest
EventSubscriptionData = TaskWebhookSubscriptionData
EventSubscriptionListResponse = TaskWebhookSubscriptionListResponse
EventSubscriptionResponse = TaskWebhookSubscriptionResponse
EventSubscriptionFilters = WebhookFilters
EventSubscriptionRetryPolicy = WebhookRetryPolicy


# ── Task Events ────────────────────────────────────────────────────


class TaskEventActor(BaseModel):
    id: str
    role: str


class TaskEventLinks(BaseModel):
    task: str
    review_feedback: str | None = Field(default=None, alias="reviewFeedback")
    ci_status: str | None = Field(default=None, alias="ciStatus")
    ship_operation: str | None = Field(default=None, alias="shipOperation")

    model_config = {"populate_by_name": True}


class TaskUpdatedEventData(BaseModel):
    task_id: str = Field(alias="taskId")
    task_identifier: str = Field(alias="taskIdentifier")
    status: TaskStatus
    previous_status: TaskStatus | None = Field(alias="previousStatus")
    changed_fields: list[str] = Field(alias="changedFields")
    actor: TaskEventActor
    summary: str
    available_actions: list[str] = Field(alias="availableActions")
    blocker: TaskBlocker | None = None
    links: TaskEventLinks

    model_config = {"populate_by_name": True}


class TaskAwaitingUserEventData(BaseModel):
    task_id: str = Field(alias="taskId")
    task_identifier: str = Field(alias="taskIdentifier")
    status: Literal["blocked"]
    previous_status: TaskStatus | None = Field(alias="previousStatus")
    changed_fields: list[str] = Field(alias="changedFields")
    actor: TaskEventActor
    summary: str
    available_actions: list[str] = Field(alias="availableActions")
    blocker: TaskBlocker
    links: TaskEventLinks

    model_config = {"populate_by_name": True}


class TaskReviewedEventData(BaseModel):
    task_id: str = Field(alias="taskId")
    task_identifier: str = Field(alias="taskIdentifier")
    status: TaskStatus
    review_outcome: Literal["approved", "changes_requested"] = Field(alias="reviewOutcome")
    reviewer: TaskEventActor
    summary: str
    available_actions: list[str] = Field(alias="availableActions")
    links: TaskEventLinks

    model_config = {"populate_by_name": True}


class TaskShippedEventData(BaseModel):
    task_id: str = Field(alias="taskId")
    task_identifier: str = Field(alias="taskIdentifier")
    status: TaskStatus
    ship_status: ShipStatus = Field(alias="shipStatus")
    operation_id: str = Field(alias="operationId")
    target_environment: ShipEnvironment = Field(alias="targetEnvironment")
    summary: str
    available_actions: list[str] = Field(alias="availableActions")
    links: TaskEventLinks

    model_config = {"populate_by_name": True}


class TaskUpdatedEvent(BaseModel):
    id: str
    type: Literal["task.updated"]
    occurred_at: datetime = Field(alias="occurredAt")
    sequence: int
    task_version: int = Field(alias="taskVersion")
    trace_id: str | None = Field(alias="traceId")
    data: TaskUpdatedEventData

    model_config = {"populate_by_name": True}


class TaskAwaitingUserEvent(BaseModel):
    id: str
    type: Literal["task.awaiting_user"]
    occurred_at: datetime = Field(alias="occurredAt")
    sequence: int
    task_version: int = Field(alias="taskVersion")
    trace_id: str | None = Field(alias="traceId")
    data: TaskAwaitingUserEventData

    model_config = {"populate_by_name": True}


class TaskReviewedEvent(BaseModel):
    id: str
    type: Literal["task.reviewed"]
    occurred_at: datetime = Field(alias="occurredAt")
    sequence: int
    task_version: int = Field(alias="taskVersion")
    trace_id: str | None = Field(alias="traceId")
    data: TaskReviewedEventData

    model_config = {"populate_by_name": True}


class TaskShippedEvent(BaseModel):
    id: str
    type: Literal["task.shipped"]
    occurred_at: datetime = Field(alias="occurredAt")
    sequence: int
    task_version: int = Field(alias="taskVersion")
    trace_id: str | None = Field(alias="traceId")
    data: TaskShippedEventData

    model_config = {"populate_by_name": True}


TaskLifecycleEvent = Annotated[
    Union[TaskUpdatedEvent, TaskAwaitingUserEvent, TaskReviewedEvent, TaskShippedEvent],
    Field(discriminator="type"),
]
