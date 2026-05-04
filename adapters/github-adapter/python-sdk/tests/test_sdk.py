"""Pure-logic tests for the AgentRail Python SDK — no network calls."""
from __future__ import annotations

import asyncio
import hashlib
import hmac
import json

from agentrail import (
    AgentRailClient,
    AgentRailError,
    NetworkError,
    TimeoutError,
    verify_webhook_signature,
    parse_webhook_payload,
    WebhookRouter,
)
from agentrail.errors import is_retryable
from agentrail.models import (
    Task,
    TaskSummary,
    TaskListResponse,
    TaskDetailResponse,
    SubmitRequest,
    SubmitResult,
    ShipResult,
    ShipBlockedResult,
    ReviewFeedbackItem,
    ReviewFeedbackResponse,
    ErrorResponse,
    WebhookRegistration,
    WebhookPayload,
    ClientConfig,
    TaskPriority,
    TaskStatus,
    FeedbackSeverity,
    WebhookEvent,
)

passed = 0
failed = 0


def assert_true(condition: bool, message: str) -> None:
    global passed, failed
    if condition:
        print(f"  ✓ {message}")
        passed += 1
    else:
        print(f"  ✗ {message}")
        failed += 1


def assert_equal(actual: object, expected: object, message: str) -> None:
    global passed, failed
    if actual == expected:
        print(f"  ✓ {message}")
        passed += 1
    else:
        print(f"  ✗ {message}")
        print(f"    expected: {expected!r}")
        print(f"    actual:   {actual!r}")
        failed += 1


# --- Client construction ---
print("\nClient construction")
client = AgentRailClient("https://api.example.com/", "test-token")
assert_true(isinstance(client, AgentRailClient), "creates client instance")

client2 = AgentRailClient("https://api.example.com", "tok", retries=5, retry_delay_s=1.0, timeout_s=60.0)
assert_true(isinstance(client2, AgentRailClient), "accepts custom config")

config = ClientConfig(base_url="https://api.example.com", token="tok", retries=3)
client3 = AgentRailClient.from_config(config)
assert_true(isinstance(client3, AgentRailClient), "from_config() works")

# --- Error classes ---
print("\nError classes")
err = AgentRailError(404, "Not found", "not_found", ["GET /tasks/mine"])
assert_true(isinstance(err, Exception), "AgentRailError extends Exception")
assert_equal(err.status, 404, "preserves status")
assert_equal(err.code, "not_found", "preserves code")
assert_equal(str(err), "Not found", "preserves message")
assert_equal(err.available_actions, ["GET /tasks/mine"], "preserves available_actions")

net_err = NetworkError("Request failed", ValueError("conn refused"))
assert_true(isinstance(net_err, Exception), "NetworkError extends Exception")
assert_true(net_err.__cause__ is not None, "preserves cause")

to_err = TimeoutError("https://api.example.com/tasks", 5.0)
assert_true(isinstance(to_err, Exception), "TimeoutError extends Exception")
assert_true("5.0s" in str(to_err), "includes timeout in message")

# --- is_retryable ---
print("\nis_retryable")
assert_equal(is_retryable(429), True, "429 is retryable")
assert_equal(is_retryable(500), True, "500 is retryable")
assert_equal(is_retryable(502), True, "502 is retryable")
assert_equal(is_retryable(503), True, "503 is retryable")
assert_equal(is_retryable(400), False, "400 is not retryable")
assert_equal(is_retryable(401), False, "401 is not retryable")
assert_equal(is_retryable(404), False, "404 is not retryable")
assert_equal(is_retryable(409), False, "409 is not retryable")

# --- Pydantic models ---
print("\nPydantic models")

task_data = {
    "id": "owner/repo#1",
    "source": "github",
    "repo": "owner/repo",
    "number": 1,
    "title": "Test task",
    "body": "Description",
    "status": "todo",
    "priority": "high",
    "labels": ["bug"],
    "assignees": ["dev"],
    "acceptanceCriteria": ["Tests pass"],
    "linkedPRs": [{"number": 10, "url": "https://github.com/pr/10", "title": "Fix", "state": "open"}],
    "comments": [{"id": 1, "author": "dev", "body": "WIP", "createdAt": "2026-01-01T00:00:00Z"}],
    "url": "https://github.com/issue/1",
    "createdAt": "2026-01-01T00:00:00Z",
    "updatedAt": "2026-01-02T00:00:00Z",
    "availableActions": ["POST /tasks/{id}/submit"],
    "meta": {"tokenBudgetHint": 450},
}
task = Task.model_validate(task_data)
assert_equal(task.status, TaskStatus.TODO, "Task parses status enum")
assert_equal(task.priority, TaskPriority.HIGH, "Task parses priority enum")
assert_equal(task.acceptance_criteria, ["Tests pass"], "Task maps camelCase alias")
assert_equal(len(task.linked_prs), 1, "Task parses linked PRs")
assert_equal(task.comments[0].author, "dev", "Task parses comments")

feedback_data = {
    "id": "rc-123",
    "reviewer": "alice",
    "severity": "required",
    "file": "src/main.ts",
    "line": 42,
    "request": "Must fix null check",
    "suggestedAction": "const x = y ?? 0;",
    "url": "https://github.com/pr/10#comment-123",
    "createdAt": "2026-01-01T00:00:00Z",
    "source": "review_comment",
}
item = ReviewFeedbackItem.model_validate(feedback_data)
assert_equal(item.severity, FeedbackSeverity.REQUIRED, "ReviewFeedbackItem severity enum")
assert_equal(item.suggested_action, "const x = y ?? 0;", "maps suggestedAction alias")

submit_req = SubmitRequest(head="feature/branch", reviewers=["alice"])
dumped = submit_req.model_dump(exclude_none=True)
assert_equal(dumped["head"], "feature/branch", "SubmitRequest serializes correctly")
assert_true("base" not in dumped, "SubmitRequest excludes None fields")

error_resp = ErrorResponse.model_validate({"error": "Not found", "code": "not_found", "availableActions": []})
assert_equal(error_resp.code, "not_found", "ErrorResponse parses")

webhook_reg_data = {
    "id": "wh-1",
    "url": "https://hooks.example.com",
    "events": ["task.created", "task.updated"],
    "active": True,
    "createdAt": "2026-01-01T00:00:00Z",
}
wh = WebhookRegistration.model_validate(webhook_reg_data)
assert_equal(len(wh.events), 2, "WebhookRegistration parses events")
assert_equal(wh.events[0], WebhookEvent.TASK_CREATED, "WebhookRegistration event enum")

# --- Webhook signature ---
print("\nWebhook signature verification")
secret = "webhook-secret-123"
payload = '{"event":"task.created","taskId":"1"}'
expected_sig = "sha256=" + hmac.new(secret.encode(), payload.encode(), hashlib.sha256).hexdigest()

assert_true(verify_webhook_signature(payload, expected_sig, secret), "valid signature passes")
assert_true(not verify_webhook_signature(payload, "sha256=wrong", secret), "invalid signature fails")
assert_true(not verify_webhook_signature(payload, expected_sig, "wrong-secret"), "wrong secret fails")
assert_true(not verify_webhook_signature("modified", expected_sig, secret), "modified payload fails")

# --- Webhook payload parsing ---
print("\nWebhook payload parsing")
raw = '{"event":"task.updated","taskId":"abc","timestamp":"2026-01-01T00:00:00Z","data":{}}'
parsed = parse_webhook_payload(raw)
assert_equal(parsed.event, WebhookEvent.TASK_UPDATED, "parses event")
assert_equal(parsed.task_id, "abc", "parses taskId")

# --- WebhookRouter ---
print("\nWebhookRouter")
calls: list[str] = []


async def run_router_tests() -> None:
    router = WebhookRouter()
    router.on(WebhookEvent.TASK_CREATED, lambda p: calls.append(f"created:{p.task_id}"))
    router.on("*", lambda p: calls.append(f"wildcard:{p.task_id}"))
    router.on(WebhookEvent.TASK_UPDATED, lambda p: calls.append(f"updated:{p.task_id}"))

    await router.handle(WebhookPayload(event=WebhookEvent.TASK_CREATED, taskId="1", timestamp="", data={}))
    assert_equal(calls, ["created:1", "wildcard:1"], "routes to specific + wildcard")

    calls.clear()
    await router.handle(WebhookPayload(event=WebhookEvent.TASK_UPDATED, taskId="2", timestamp="", data={}))
    assert_equal(calls, ["updated:2", "wildcard:2"], "routes updated event")

    calls.clear()
    await router.handle(WebhookPayload(event=WebhookEvent.TASK_SHIPPED, taskId="3", timestamp="", data={}))
    assert_equal(calls, ["wildcard:3"], "unhandled goes to wildcard only")


asyncio.run(run_router_tests())

# --- Module imports ---
print("\nModule imports")
import agentrail
assert_true(hasattr(agentrail, "AgentRailClient"), "exports AgentRailClient")
assert_true(hasattr(agentrail, "verify_webhook_signature"), "exports verify_webhook_signature")
assert_true(hasattr(agentrail, "WebhookRouter"), "exports WebhookRouter")
assert_true(hasattr(agentrail, "Task"), "exports Task model")

print(f"\nResults: {passed} passed, {failed} failed")
if failed > 0:
    exit(1)
