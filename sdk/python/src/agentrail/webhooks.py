"""Webhook signature verification and event parsing."""

from __future__ import annotations

import hashlib
import hmac
from typing import TypedDict

from pydantic import TypeAdapter

from .models import TaskLifecycleEvent


class WebhookHeaders(TypedDict):
    x_agentrail_subscription_id: str
    x_agentrail_event_id: str
    x_agentrail_event_type: str
    x_agentrail_delivery_id: str
    x_agentrail_delivery_attempt: str
    x_agentrail_signature: str


_event_adapter: TypeAdapter[TaskLifecycleEvent] = TypeAdapter(TaskLifecycleEvent)


def verify_webhook_signature(
    raw_body: str | bytes,
    secret: str,
    signature: str,
) -> bool:
    payload = raw_body if isinstance(raw_body, bytes) else raw_body.encode()
    expected = "sha256=" + hmac.new(
        secret.encode(), payload, hashlib.sha256
    ).hexdigest()

    if len(expected) != len(signature):
        return False

    return hmac.compare_digest(expected, signature)


def parse_webhook_event(
    raw_body: str | bytes,
    secret: str,
    signature: str,
) -> TaskLifecycleEvent:
    if not verify_webhook_signature(raw_body, secret, signature):
        raise ValueError("Invalid webhook signature")
    payload = raw_body if isinstance(raw_body, str) else raw_body.decode()
    return _event_adapter.validate_json(payload)
