"""Async HTTP client for the AgentRail Task Lifecycle API."""

from __future__ import annotations

import asyncio
import json
from collections.abc import AsyncIterator
from dataclasses import dataclass, field
from typing import Any
from urllib.parse import quote

import httpx
from pydantic import TypeAdapter

from .errors import RateLimitError, parse_error_response
from .models import (
    AgentApiKeyCreateRequest,
    AgentApiKeyResponse,
    AgentApiKeyRotateRequest,
    AgentApiKeyUsageResponse,
    TaskCiStatusResponse,
    TaskDetailResponse,
    TaskLifecycleEvent,
    TaskListResponse,
    TaskReviewFeedbackResponse,
    TaskShipRequest,
    TaskShipResponse,
    TaskStatus,
    TaskSubmissionResponse,
    TaskSubmitRequest,
    TaskWebhookSubscriptionCreateRequest,
    TaskWebhookSubscriptionListResponse,
    TaskWebhookSubscriptionResponse,
)

_event_adapter: TypeAdapter[TaskLifecycleEvent] = TypeAdapter(TaskLifecycleEvent)
DEFAULT_BASE_URL = "http://127.0.0.1:3000"


@dataclass(frozen=True)
class RetryOptions:
    max_attempts: int = 3
    initial_delay_s: float = 1.0
    max_delay_s: float = 30.0
    retryable_status_codes: tuple[int, ...] = (429, 500, 502, 503, 504)


@dataclass(frozen=True)
class StreamOptions:
    event_types: list[str] | None = None
    task_id: str | None = None
    cursor: str | None = None
    heartbeat_seconds: int | None = None


class AgentRailClient:
    def __init__(
        self,
        *,
        base_url: str = DEFAULT_BASE_URL,
        api_key: str,
        retry: RetryOptions | None = None,
        timeout: float = 30.0,
    ) -> None:
        self._base_url = base_url.rstrip("/")
        self._api_key = api_key
        self._retry = retry or RetryOptions()
        self._client = httpx.AsyncClient(
            base_url=self._base_url,
            headers={
                "Authorization": f"Bearer {api_key}",
                "Accept": "application/json",
            },
            timeout=timeout,
        )

    async def close(self) -> None:
        await self._client.aclose()

    async def __aenter__(self) -> AgentRailClient:
        return self

    async def __aexit__(self, *exc: object) -> None:
        await self.close()

    # ── Agent Auth ─────────────────────────────────────────────────

    async def create_api_key(
        self,
        request: AgentApiKeyCreateRequest,
        idempotency_key: str,
    ) -> AgentApiKeyResponse:
        return await self._request(
            "POST",
            "/agent-api-keys",
            body=request.model_dump(by_alias=True, exclude_none=True),
            headers={"Idempotency-Key": idempotency_key},
            response_model=AgentApiKeyResponse,
        )

    async def rotate_api_key(
        self,
        key_id: str,
        request: AgentApiKeyRotateRequest | None = None,
        idempotency_key: str | None = None,
    ) -> AgentApiKeyResponse:
        headers: dict[str, str] = {}
        if idempotency_key:
            headers["Idempotency-Key"] = idempotency_key
        body = request.model_dump(by_alias=True, exclude_none=True) if request else None
        return await self._request(
            "POST",
            f"/agent-api-keys/{quote(key_id, safe='')}/rotate",
            body=body,
            headers=headers,
            response_model=AgentApiKeyResponse,
        )

    async def get_api_key_usage(self, key_id: str) -> AgentApiKeyUsageResponse:
        return await self._request(
            "GET",
            f"/agent-api-keys/{quote(key_id, safe='')}/usage",
            response_model=AgentApiKeyUsageResponse,
        )

    # ── Tasks ──────────────────────────────────────────────────────

    async def list_my_tasks(
        self,
        *,
        status: TaskStatus | None = None,
        limit: int | None = None,
        cursor: str | None = None,
    ) -> TaskListResponse:
        params: dict[str, str] = {}
        if status is not None:
            params["status"] = status.value
        if limit is not None:
            params["limit"] = str(limit)
        if cursor is not None:
            params["cursor"] = cursor
        return await self._request(
            "GET", "/tasks/mine", params=params, response_model=TaskListResponse
        )

    async def get_task(self, task_id: str) -> TaskDetailResponse:
        return await self._request(
            "GET",
            f"/tasks/{quote(task_id, safe='')}",
            response_model=TaskDetailResponse,
        )

    async def submit_task(
        self,
        task_id: str,
        request: TaskSubmitRequest,
        idempotency_key: str,
    ) -> TaskSubmissionResponse:
        return await self._request(
            "POST",
            f"/tasks/{quote(task_id, safe='')}/submit",
            body=request.model_dump(by_alias=True, exclude_none=True),
            headers={"Idempotency-Key": idempotency_key},
            response_model=TaskSubmissionResponse,
        )

    async def get_task_ci_status(self, task_id: str) -> TaskCiStatusResponse:
        return await self._request(
            "GET",
            f"/tasks/{quote(task_id, safe='')}/ci-status",
            response_model=TaskCiStatusResponse,
        )

    async def get_task_review_feedback(
        self, task_id: str
    ) -> TaskReviewFeedbackResponse:
        return await self._request(
            "GET",
            f"/tasks/{quote(task_id, safe='')}/review-feedback",
            response_model=TaskReviewFeedbackResponse,
        )

    async def ship_task(
        self,
        task_id: str,
        request: TaskShipRequest,
        idempotency_key: str,
    ) -> TaskShipResponse:
        return await self._request(
            "POST",
            f"/tasks/{quote(task_id, safe='')}/ship",
            body=request.model_dump(by_alias=True, exclude_none=True),
            headers={"Idempotency-Key": idempotency_key},
            response_model=TaskShipResponse,
        )

    # ── Webhooks ───────────────────────────────────────────────────

    async def list_webhook_subscriptions(self) -> TaskWebhookSubscriptionListResponse:
        return await self._request(
            "GET",
            "/task-webhook-subscriptions",
            response_model=TaskWebhookSubscriptionListResponse,
        )

    async def get_webhook_subscription(
        self, subscription_id: str
    ) -> TaskWebhookSubscriptionResponse:
        return await self._request(
            "GET",
            f"/task-webhook-subscriptions/{quote(subscription_id, safe='')}",
            response_model=TaskWebhookSubscriptionResponse,
        )

    async def create_webhook_subscription(
        self,
        request: TaskWebhookSubscriptionCreateRequest,
        idempotency_key: str,
    ) -> TaskWebhookSubscriptionResponse:
        return await self._request(
            "POST",
            "/task-webhook-subscriptions",
            body=request.model_dump(by_alias=True, exclude_none=True),
            headers={"Idempotency-Key": idempotency_key},
            response_model=TaskWebhookSubscriptionResponse,
        )

    async def deactivate_webhook_subscription(
        self, subscription_id: str
    ) -> TaskWebhookSubscriptionResponse:
        return await self._request(
            "DELETE",
            f"/task-webhook-subscriptions/{quote(subscription_id, safe='')}",
            response_model=TaskWebhookSubscriptionResponse,
        )

    # ── Event Stream ───────────────────────────────────────────────

    async def stream_events(
        self, options: StreamOptions | None = None
    ) -> AsyncIterator[TaskLifecycleEvent]:
        opts = options or StreamOptions()
        params: dict[str, str] = {}
        if opts.event_types:
            params["eventTypes"] = ",".join(opts.event_types)
        if opts.task_id:
            params["taskId"] = opts.task_id
        if opts.cursor:
            params["cursor"] = opts.cursor
        if opts.heartbeat_seconds is not None:
            params["heartbeatSeconds"] = str(opts.heartbeat_seconds)

        headers: dict[str, str] = {
            "Accept": "text/event-stream",
            "Authorization": f"Bearer {self._api_key}",
        }
        if opts.cursor:
            headers["Last-Event-ID"] = opts.cursor

        async with self._client.stream(
            "GET",
            "/task-events/stream",
            params=params,
            headers=headers,
        ) as resp:
            if resp.status_code >= 400:
                body = json.loads(await resp.aread())
                raise parse_error_response(
                    resp.status_code,
                    body,
                    dict(resp.headers),
                )

            buffer = ""
            async for chunk in resp.aiter_text():
                buffer += chunk
                while "\n\n" in buffer:
                    block, buffer = buffer.split("\n\n", 1)
                    if not block.strip():
                        continue
                    data_line: str | None = None
                    for line in block.split("\n"):
                        if line.startswith("data: "):
                            data_line = line[6:]
                    if data_line:
                        yield _event_adapter.validate_json(data_line)

    # ── Internal ───────────────────────────────────────────────────

    async def _request(
        self,
        method: str,
        path: str,
        *,
        body: Any = None,
        headers: dict[str, str] | None = None,
        params: dict[str, str] | None = None,
        response_model: type[Any] | None = None,
    ) -> Any:
        last_error: Exception | None = None

        for attempt in range(1, self._retry.max_attempts + 1):
            resp = await self._client.request(
                method,
                path,
                json=body,
                headers=headers,
                params=params,
            )

            if resp.status_code < 400:
                data = resp.json()
                if response_model is not None:
                    return response_model.model_validate(data)
                return data

            try:
                err_body = resp.json()
            except Exception:
                err_body = {
                    "error": {
                        "code": "unknown",
                        "message": f"HTTP {resp.status_code}",
                        "details": {},
                    }
                }

            err = parse_error_response(
                resp.status_code, err_body, dict(resp.headers)
            )

            if (
                not err.retryable
                or resp.status_code not in self._retry.retryable_status_codes
                or attempt == self._retry.max_attempts
            ):
                raise err

            last_error = err
            if isinstance(err, RateLimitError) and err.retry_after_seconds:
                delay = float(err.retry_after_seconds)
            else:
                delay = min(
                    self._retry.initial_delay_s * (2 ** (attempt - 1)),
                    self._retry.max_delay_s,
                )
            await asyncio.sleep(delay)

        raise last_error or RuntimeError("Retry loop exhausted")
