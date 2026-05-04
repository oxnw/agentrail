from __future__ import annotations

import hashlib
import hmac
import json
from collections import defaultdict
from typing import Awaitable, Callable

from .models import WebhookEvent, WebhookPayload


def verify_webhook_signature(payload: str | bytes, signature: str, secret: str) -> bool:
    if isinstance(payload, str):
        payload = payload.encode()
    expected = "sha256=" + hmac.new(
        secret.encode(), payload, hashlib.sha256
    ).hexdigest()
    return hmac.compare_digest(expected, signature)


def parse_webhook_payload(body: str) -> WebhookPayload:
    return WebhookPayload.model_validate(json.loads(body))


WebhookHandler = Callable[[WebhookPayload], Awaitable[None] | None]


class WebhookRouter:
    def __init__(self) -> None:
        self._handlers: dict[str, list[WebhookHandler]] = defaultdict(list)

    def on(self, event: WebhookEvent | str, handler: WebhookHandler) -> WebhookRouter:
        key = event.value if isinstance(event, WebhookEvent) else event
        self._handlers[key].append(handler)
        return self

    async def handle(self, payload: WebhookPayload) -> None:
        event_key = payload.event.value if isinstance(payload.event, WebhookEvent) else payload.event
        handlers = list(self._handlers.get(event_key, []))
        handlers.extend(self._handlers.get("*", []))
        for handler in handlers:
            result = handler(payload)
            if result is not None:
                await result
