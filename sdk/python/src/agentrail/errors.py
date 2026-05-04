"""Structured error hierarchy for AgentRail API responses."""

from __future__ import annotations

from .models import ErrorDetail


class AgentRailError(Exception):
    """Base error for all AgentRail API failures."""

    def __init__(self, status_code: int, body: ErrorDetail) -> None:
        super().__init__(body.message)
        self.status_code = status_code
        self.code = body.code
        self.details = body.details
        self.available_actions: list[str] = list(
            body.details.get("availableActions", [])  # type: ignore[arg-type]
        )

    @property
    def retryable(self) -> bool:
        return self.status_code == 429 or self.status_code >= 500


class ValidationError(AgentRailError):
    def __init__(self, body: ErrorDetail) -> None:
        super().__init__(400, body)


class UnauthorizedError(AgentRailError):
    def __init__(self, body: ErrorDetail) -> None:
        super().__init__(401, body)


class InsufficientScopeError(AgentRailError):
    def __init__(self, body: ErrorDetail) -> None:
        super().__init__(403, body)


class NotFoundError(AgentRailError):
    def __init__(self, body: ErrorDetail) -> None:
        super().__init__(404, body)


class ConflictError(AgentRailError):
    def __init__(self, body: ErrorDetail) -> None:
        super().__init__(409, body)

    @property
    def retryable(self) -> bool:
        return False


class RateLimitError(AgentRailError):
    def __init__(self, body: ErrorDetail, retry_after: str | None) -> None:
        super().__init__(429, body)
        self.retry_after_seconds: int | None = (
            int(retry_after) if retry_after else None
        )


def parse_error_response(
    status_code: int,
    body: dict[str, object],
    headers: dict[str, str] | None = None,
) -> AgentRailError:
    detail = ErrorDetail.model_validate(body.get("error", body))
    _map = {
        400: lambda: ValidationError(detail),
        401: lambda: UnauthorizedError(detail),
        403: lambda: InsufficientScopeError(detail),
        404: lambda: NotFoundError(detail),
        409: lambda: ConflictError(detail),
        429: lambda: RateLimitError(detail, (headers or {}).get("retry-after")),
    }
    factory = _map.get(status_code)
    if factory:
        return factory()
    return AgentRailError(status_code, detail)
