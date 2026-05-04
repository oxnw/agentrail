from __future__ import annotations

from enum import Enum
from typing import Literal

from pydantic import BaseModel, Field


class TaskPriority(str, Enum):
    CRITICAL = "critical"
    HIGH = "high"
    MEDIUM = "medium"
    LOW = "low"


class TaskStatus(str, Enum):
    TODO = "todo"
    IN_PROGRESS = "in_progress"
    IN_REVIEW = "in_review"
    DONE = "done"
    BLOCKED = "blocked"


class FeedbackSeverity(str, Enum):
    REQUIRED = "required"
    SUGGESTION = "suggestion"
    NITPICK = "nitpick"


class WebhookEvent(str, Enum):
    TASK_CREATED = "task.created"
    TASK_UPDATED = "task.updated"
    TASK_SUBMITTED = "task.submitted"
    TASK_SHIPPED = "task.shipped"
    TASK_REVIEW_FEEDBACK = "task.review_feedback"
    TASK_STATUS_CHANGED = "task.status_changed"


class LinkedPR(BaseModel):
    number: int
    url: str
    title: str
    state: str


class TaskComment(BaseModel):
    id: int
    author: str
    body: str
    created_at: str = Field(alias="createdAt")

    model_config = {"populate_by_name": True}


class TaskMeta(BaseModel):
    token_budget_hint: int = Field(alias="tokenBudgetHint")

    model_config = {"populate_by_name": True}


class Task(BaseModel):
    id: str
    source: Literal["github"]
    repo: str
    number: int
    title: str
    body: str
    status: TaskStatus
    priority: TaskPriority
    labels: list[str]
    assignees: list[str]
    acceptance_criteria: list[str] = Field(alias="acceptanceCriteria")
    linked_prs: list[LinkedPR] = Field(alias="linkedPRs")
    comments: list[TaskComment]
    url: str
    created_at: str = Field(alias="createdAt")
    updated_at: str = Field(alias="updatedAt")
    available_actions: list[str] = Field(alias="availableActions")
    meta: TaskMeta

    model_config = {"populate_by_name": True}


class TaskSummary(BaseModel):
    id: str
    source: Literal["github"]
    repo: str
    number: int
    title: str
    status: TaskStatus
    priority: TaskPriority
    labels: list[str]
    url: str
    updated_at: str = Field(alias="updatedAt")
    available_actions: list[str] = Field(alias="availableActions")

    model_config = {"populate_by_name": True}


class TaskListResponse(BaseModel):
    tasks: list[TaskSummary]
    cursor: str | None
    has_more: bool = Field(alias="hasMore")
    meta: TaskMeta

    model_config = {"populate_by_name": True}


class TaskDetailResponse(BaseModel):
    task: Task


class SubmitRequest(BaseModel):
    head: str
    base: str | None = None
    title: str | None = None
    body: str | None = None
    reviewers: list[str] | None = None
    draft: bool | None = None


class SubmitPR(LinkedPR):
    draft: bool
    base: str
    head: str
    reviewers: list[str]
    checks_status: Literal["pending", "passing", "failing", "unknown"] = Field(alias="checksStatus")

    model_config = {"populate_by_name": True}


class SubmitResult(BaseModel):
    action: Literal["created", "existing"]
    pr: SubmitPR
    issue_number: int = Field(alias="issueNumber")
    available_actions: list[str] = Field(alias="availableActions")

    model_config = {"populate_by_name": True}


class ShipResultPR(BaseModel):
    number: int
    url: str
    merged: bool
    merge_commit_sha: str | None = Field(alias="mergeCommitSha")

    model_config = {"populate_by_name": True}


class ShipResultIssue(BaseModel):
    number: int
    url: str
    state: str


class ShipResult(BaseModel):
    action: Literal["merged", "closed_issue"]
    pr: ShipResultPR
    issue: ShipResultIssue
    available_actions: list[str] = Field(alias="availableActions")

    model_config = {"populate_by_name": True}


class ShipBlockedPR(BaseModel):
    number: int
    url: str
    mergeable: bool | None
    mergeable_state: str = Field(alias="mergeableState")

    model_config = {"populate_by_name": True}


class ShipBlockedResult(BaseModel):
    action: Literal["blocked"]
    reason: str
    code: Literal["merge_conflict", "checks_failing", "review_required", "branch_protection", "not_mergeable"]
    pr: ShipBlockedPR
    available_actions: list[str] = Field(alias="availableActions")

    model_config = {"populate_by_name": True}


class ReviewFeedbackItem(BaseModel):
    id: str
    reviewer: str
    severity: FeedbackSeverity
    file: str | None
    line: int | None
    request: str
    suggested_action: str | None = Field(alias="suggestedAction")
    url: str
    created_at: str = Field(alias="createdAt")
    source: Literal["review", "review_comment", "issue_comment"]

    model_config = {"populate_by_name": True}


class ReviewFeedbackSummary(BaseModel):
    total: int
    required: int
    suggestion: int
    nitpick: int


class ReviewFeedbackResponse(BaseModel):
    task_id: str = Field(alias="taskId")
    pr_number: int = Field(alias="prNumber")
    feedback: list[ReviewFeedbackItem]
    summary: ReviewFeedbackSummary
    available_actions: list[str] = Field(alias="availableActions")

    model_config = {"populate_by_name": True}


class ErrorResponse(BaseModel):
    error: str
    code: str
    available_actions: list[str] = Field(alias="availableActions")

    model_config = {"populate_by_name": True}


class WebhookRegistration(BaseModel):
    id: str
    url: str
    events: list[WebhookEvent]
    active: bool
    created_at: str = Field(alias="createdAt")

    model_config = {"populate_by_name": True}


class WebhookPayload(BaseModel):
    event: WebhookEvent
    task_id: str = Field(alias="taskId")
    timestamp: str
    data: dict

    model_config = {"populate_by_name": True}


class ClientConfig(BaseModel):
    base_url: str
    token: str
    retries: int = 2
    retry_delay_s: float = 0.5
    timeout_s: float = 30.0
