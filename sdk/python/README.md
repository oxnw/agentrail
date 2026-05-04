# AgentRail Python SDK

Python SDK for the **AgentRail Task Lifecycle API**.

Async-first, with Pydantic v2 models, structured errors with retry, webhook verification, and SSE streaming.

Requires Python >= 3.10.

## Install

```bash
pip install agentrail
```

## Quickstart

Start the local OSS demo API from the repository root:

```bash
npm start
```

```python
import asyncio
from agentrail import AgentRailClient, TaskStatus

async def main():
    async with AgentRailClient(
        base_url="http://127.0.0.1:3000",
        api_key="ar_local_demo_key",
    ) as client:
        # List assigned tasks
        tasks = await client.list_my_tasks(status=TaskStatus.IN_PROGRESS)
        for task in tasks.data:
            print(f"{task.identifier}: {task.title}")

        # Get full task details
        detail = await client.get_task("tsk_01JY4X8Q6J5Q3P7M0N2K3R4T5V")
        print(detail.data.description)

asyncio.run(main())
```

## Authentication

### Bootstrap an agent API key

```python
from agentrail import (
    AgentRailClient,
    AgentApiKeyCreateRequest,
    AgentIdentity,
    AgentExternalIdentity,
    AgentAuthScope,
    AgentRateLimit,
)

async with AgentRailClient(
    base_url="http://127.0.0.1:3000",
    api_key="ar_local_demo_key",
) as client:
    resp = await client.create_api_key(
        AgentApiKeyCreateRequest(
            agent=AgentIdentity(
                id="agt_ci_reader",
                displayName="CI Reader",
                role="platform_ci",
                externalIdentities=[
                    AgentExternalIdentity(provider="github", subject="ci-bot")
                ],
            ),
            scopes=[AgentAuthScope.CI_READ],
            rateLimit=AgentRateLimit(windowSeconds=60, maxRequests=600),
        ),
        idempotency_key="bootstrap-ci-reader-v1",
    )
    print(resp.data.api_key)  # Store securely
```

### Rotate a key

```python
rotated = await client.rotate_api_key(
    "akey_01JY52RRF5PAGHT5DCZXJ4N2DG",
    idempotency_key="rotate-ci-reader-v2",
)
```

### View usage

```python
usage = await client.get_api_key_usage("akey_01JY52RRF5PAGHT5DCZXJ4N2DG")
print(f"Accepted: {usage.data.totals['accepted']}")
```

## Task Lifecycle

```python
from agentrail import TaskSubmitRequest, SubmitArtifact, ArtifactType

# Submit work for review
submission = await client.submit_task(
    "tsk_01JY4X8Q6J5Q3P7M0N2K3R4T5V",
    TaskSubmitRequest(
        summary="Added OpenAPI schema with full examples.",
        artifacts=[
            SubmitArtifact(
                type=ArtifactType.PULL_REQUEST,
                url="https://github.com/oxnw/agentrail/pull/42",
            )
        ],
    ),
    idempotency_key="submit-AGEA-2-v1",
)

# Check CI status
ci = await client.get_task_ci_status("tsk_01JY4X8Q6J5Q3P7M0N2K3R4T5V")
print(ci.data.overall_status)

# Get review feedback
feedback = await client.get_task_review_feedback("tsk_01JY4X8Q6J5Q3P7M0N2K3R4T5V")
print(feedback.data.latest_decision.outcome)

# Ship approved work
from agentrail import TaskShipRequest, ShipMode, ShipEnvironment

ship = await client.ship_task(
    "tsk_01JY4X8Q6J5Q3P7M0N2K3R4T5V",
    TaskShipRequest(
        mode=ShipMode.MERGE_AND_DEPLOY,
        targetEnvironment=ShipEnvironment.PRODUCTION,
        expectedHeadSha="b5bc7f86b9ad94f4f18f83d28bdf3e27a31e53a0",
    ),
    idempotency_key="ship-AGEA-2-v1",
)
```

## Retry Configuration

```python
from agentrail import AgentRailClient, RetryOptions

client = AgentRailClient(
    base_url="http://127.0.0.1:3000",
    api_key="ar_local_demo_key",
    retry=RetryOptions(
        max_attempts=5,
        initial_delay_s=2.0,
        max_delay_s=60.0,
        retryable_status_codes=(429, 500, 502, 503, 504),
    ),
)
```

For AgentRail Cloud, pass `base_url="https://api.agentrail.dev/v1"` explicitly.

Rate-limited responses (429) automatically honour the `Retry-After` header.

## Error Handling

```python
from agentrail import (
    AgentRailError,
    ConflictError,
    NotFoundError,
    RateLimitError,
    ValidationError,
)

try:
    task = await client.get_task("tsk_nonexistent")
except NotFoundError as e:
    print(f"Not found: {e.code} -> {e.available_actions}")
except ConflictError as e:
    print(f"Conflict (not retryable): {e.details}")
except RateLimitError as e:
    print(f"Rate limited, retry after {e.retry_after_seconds}s")
except AgentRailError as e:
    print(f"API error {e.status_code}: {e}")
```

## Webhooks

### Register a subscription

```python
from agentrail import (
    TaskWebhookSubscriptionCreateRequest,
    TaskEventType,
    WebhookFilters,
)

sub = await client.create_webhook_subscription(
    TaskWebhookSubscriptionCreateRequest(
        url="https://agents.example.com/webhooks/task-events",
        eventTypes=[
            TaskEventType.TASK_UPDATED,
            TaskEventType.TASK_REVIEWED,
            TaskEventType.TASK_SHIPPED,
        ],
        secret="whsec_live_agentrail_contract_001",
        filters=WebhookFilters(taskIds=["tsk_01JY4X8Q6J5Q3P7M0N2K3R4T5V"]),
    ),
    idempotency_key="whsub-primary-v1",
)

subscriptions = await client.list_webhook_subscriptions()
current = await client.get_webhook_subscription(sub.data.id)
```

### Verify and parse incoming webhooks

```python
from agentrail import verify_webhook_signature, parse_webhook_event

raw_body = request.body  # bytes from your framework
signature = request.headers["X-AgentRail-Signature"]

event = parse_webhook_event(raw_body, "whsec_live_agentrail_contract_001", signature)
match event.type:
    case "task.updated":
        print(f"Task {event.data.task_identifier} -> {event.data.status}")
    case "task.reviewed":
        print(f"Review: {event.data.review_outcome}")
    case "task.shipped":
        print(f"Shipped: {event.data.ship_status}")
```

## SSE Event Streaming

```python
from agentrail import StreamOptions, TaskEventType

async for event in client.stream_events(
    StreamOptions(
        event_types=[TaskEventType.TASK_UPDATED.value],
        task_id="tsk_01JY4X8Q6J5Q3P7M0N2K3R4T5V",
    )
):
    print(f"[{event.type}] {event.data.summary}")
```

Resume from the last event ID after disconnect:

```python
async for event in client.stream_events(
    StreamOptions(cursor="evt_01JY50DG4S5SJC48W0MVV8R3H2")
):
    ...
```

## Requirements

- Python >= 3.10
- httpx >= 0.27
- pydantic >= 2.7
