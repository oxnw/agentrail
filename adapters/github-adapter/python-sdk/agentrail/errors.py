from __future__ import annotations


class AgentRailError(Exception):
    def __init__(self, status: int, error: str, code: str, available_actions: list[str]) -> None:
        super().__init__(error)
        self.status = status
        self.code = code
        self.available_actions = available_actions


class NetworkError(Exception):
    def __init__(self, message: str, cause: BaseException | None = None) -> None:
        super().__init__(message)
        self.__cause__ = cause


class TimeoutError(Exception):
    def __init__(self, url: str, timeout_s: float) -> None:
        super().__init__(f"Request to {url} timed out after {timeout_s}s")
        self.url = url
        self.timeout_s = timeout_s


def is_retryable(status: int) -> bool:
    return status == 429 or status >= 500
