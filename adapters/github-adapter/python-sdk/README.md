# agentrail

Python SDK for the AgentRail Task Lifecycle API.

## Install

```bash
pip install agentrail
```

## Quickstart

```python
import asyncio
from agentrail import AgentRailClient, SubmitRequest

async def main():
    async with AgentRailClient(
        base_url="https://your-agentrail-instance.com",
        token="your-token",
    ) as client:
        # List assigned tasks
        result = await client.list_tasks("my-github-username")

        # Get full task details
        detail = await client.get_task(result.tasks[0].id)
        print(detail.task.title)

        # Submit a PR
        submit = await client.submit_task(detail.task.id, SubmitRequest(
            head="feature/my-branch",
            reviewers=["teammate"],
        ))

        # Get unified review feedback
        feedback = await client.get_review_feedback(detail.task.id, submit.pr.number)
        print(f"{feedback.summary.required} required changes")

        # Ship it
        await client.ship_task(detail.task.id, submit.pr.number)

asyncio.run(main())
```

## Pagination

```python
async for page in client.paginate_tasks("my-username"):
    for task in page.tasks:
        print(task.title)
```

## Webhooks

```python
from agentrail import verify_webhook_signature, WebhookRouter, WebhookEvent

# Register
await client.register_webhook(
    "https://my-server.com/hooks",
    [WebhookEvent.TASK_CREATED, WebhookEvent.TASK_STATUS_CHANGED],
)

# Route incoming webhooks
router = WebhookRouter()

@router.on(WebhookEvent.TASK_CREATED)
async def on_created(payload):
    print("New task:", payload.task_id)

# In your request handler:
if verify_webhook_signature(body, signature, secret):
    await router.handle(parse_webhook_payload(body))
```

## Error Handling

```python
from agentrail import AgentRailError, NetworkError, TimeoutError

try:
    await client.get_task("nonexistent")
except AgentRailError as e:
    print(e.status, e.code, e.available_actions)
except TimeoutError:
    print("Timed out")
except NetworkError as e:
    print("Network failure:", e.__cause__)
```

## Configuration

```python
client = AgentRailClient(
    base_url="https://your-instance.com",
    token="your-token",
    retries=3,           # default: 2
    retry_delay_s=1.0,   # default: 0.5 (exponential backoff)
    timeout_s=60.0,      # default: 30.0
)
```

Retries use exponential backoff on 429 and 5xx errors.
