from __future__ import annotations

import asyncio
from typing import AsyncIterator, Literal
from urllib.parse import quote

import httpx

from .errors import AgentRailError, NetworkError, TimeoutError, is_retryable
from .models import (
    ClientConfig,
    TaskListResponse,
    TaskDetailResponse,
    SubmitRequest,
    SubmitResult,
    ShipResult,
    ShipBlockedResult,
    ReviewFeedbackResponse,
    WebhookRegistration,
    WebhookEvent,
)


class AgentRailClient:
    def __init__(
        self,
        base_url: str,
        token: str,
        *,
        retries: int = 2,
        retry_delay_s: float = 0.5,
        timeout_s: float = 30.0,
    ) -> None:
        self._base_url = base_url.rstrip("/")
        self._token = token
        self._retries = retries
        self._retry_delay_s = retry_delay_s
        self._timeout_s = timeout_s
        self._client = httpx.AsyncClient(
            base_url=self._base_url,
            headers={
                "Authorization": f"Bearer {token}",
                "Content-Type": "application/json",
                "Accept": "application/json",
            },
            timeout=timeout_s,
        )

    @classmethod
    def from_config(cls, config: ClientConfig) -> AgentRailClient:
        return cls(
            base_url=config.base_url,
            token=config.token,
            retries=config.retries,
            retry_delay_s=config.retry_delay_s,
            timeout_s=config.timeout_s,
        )

    async def close(self) -> None:
        await self._client.aclose()

    async def __aenter__(self) -> AgentRailClient:
        return self

    async def __aexit__(self, *args: object) -> None:
        await self.close()

    async def _request(self, method: str, path: str, *, json: dict | None = None) -> dict | list:
        last_error: BaseException | None = None

        for attempt in range(self._retries + 1):
            if attempt > 0:
                delay = self._retry_delay_s * (2 ** (attempt - 1))
                await asyncio.sleep(delay)

            try:
                resp = await self._client.request(method, path, json=json)
            except httpx.TimeoutException:
                raise TimeoutError(f"{self._base_url}{path}", self._timeout_s)
            except httpx.HTTPError as exc:
                last_error = exc
                if attempt < self._retries:
                    continue
                raise NetworkError(f"Request to {self._base_url}{path} failed", exc)

            if resp.is_success:
                if resp.status_code == 204:
                    return {}
                return resp.json()

            if is_retryable(resp.status_code) and attempt < self._retries:
                last_error = AgentRailError(
                    resp.status_code,
                    resp.json().get("error", resp.reason_phrase),
                    resp.json().get("code", "unknown"),
                    resp.json().get("availableActions", []),
                )
                continue

            body = resp.json()
            raise AgentRailError(
                resp.status_code,
                body.get("error", resp.reason_phrase),
                body.get("code", "unknown"),
                body.get("availableActions", []),
            )

        raise NetworkError(f"Request to {self._base_url}{path} failed after retries", last_error)

    async def list_tasks(
        self, assignee: str, *, cursor: str | None = None, per_page: int | None = None
    ) -> TaskListResponse:
        params = f"assignee={quote(assignee)}"
        if cursor:
            params += f"&cursor={quote(cursor)}"
        if per_page:
            params += f"&per_page={per_page}"
        data = await self._request("GET", f"/tasks/mine?{params}")
        return TaskListResponse.model_validate(data)

    async def get_task(self, task_id: str) -> TaskDetailResponse:
        data = await self._request("GET", f"/tasks/{quote(task_id, safe='')}")
        return TaskDetailResponse.model_validate(data)

    async def submit_task(self, task_id: str, request: SubmitRequest) -> SubmitResult:
        data = await self._request(
            "POST",
            f"/tasks/{quote(task_id, safe='')}/submit",
            json=request.model_dump(exclude_none=True),
        )
        return SubmitResult.model_validate(data)

    async def ship_task(
        self,
        task_id: str,
        pr_number: int,
        merge_method: Literal["merge", "squash", "rebase"] = "squash",
    ) -> ShipResult | ShipBlockedResult:
        data = await self._request(
            "POST",
            f"/tasks/{quote(task_id, safe='')}/ship",
            json={"prNumber": pr_number, "mergeMethod": merge_method},
        )
        if data.get("action") == "blocked":
            return ShipBlockedResult.model_validate(data)
        return ShipResult.model_validate(data)

    async def get_review_feedback(self, task_id: str, pr_number: int) -> ReviewFeedbackResponse:
        data = await self._request(
            "GET", f"/tasks/{quote(task_id, safe='')}/review-feedback?pr={pr_number}"
        )
        return ReviewFeedbackResponse.model_validate(data)

    async def register_webhook(self, url: str, events: list[WebhookEvent]) -> WebhookRegistration:
        data = await self._request(
            "POST", "/webhooks", json={"url": url, "events": [e.value for e in events]}
        )
        return WebhookRegistration.model_validate(data)

    async def list_webhooks(self) -> list[WebhookRegistration]:
        data = await self._request("GET", "/webhooks")
        return [WebhookRegistration.model_validate(w) for w in data]

    async def delete_webhook(self, webhook_id: str) -> None:
        await self._request("DELETE", f"/webhooks/{webhook_id}")

    async def paginate_tasks(self, assignee: str, per_page: int = 20) -> AsyncIterator[TaskListResponse]:
        cursor: str | None = None
        while True:
            page = await self.list_tasks(assignee, cursor=cursor, per_page=per_page)
            yield page
            cursor = page.cursor
            if cursor is None:
                break
