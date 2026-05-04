# Task Lifecycle Contract Tests

## Purpose

This document defines the minimum contract gates for `docs/api/task-lifecycle.openapi.yaml` so the implementation, generated SDKs, and agent-facing behavior stay aligned, including the SSE stream and replay-buffer behavior added in `AGEA-15`.

## CI Gates

Run these gates on every pull request that changes the OpenAPI contract or any task lifecycle endpoint implementation:

1. OpenAPI validation against the canonical schema file.
Suggested command: `redocly lint docs/api/task-lifecycle.openapi.yaml`

2. Spectral lint using the repo ruleset.
Suggested command: `spectral lint docs/api/task-lifecycle.openapi.yaml -r .spectral.yaml`

3. SDK smoke generation for the two supported first-party targets.
Suggested commands:
   `openapi-generator-cli generate --generator-key task-lifecycle-typescript`
   `openapi-generator-cli generate --generator-key task-lifecycle-python`

4. Happy-path HTTP contract suite against a running API implementation seeded with deterministic fixtures.

5. SSE contract suite against a running API implementation with a controllable event outbox clock so replay-window expiry and keepalive cadence can be asserted deterministically.

## Required Seed Fixtures

Use deterministic fixtures that keep the core lifecycle and push-delivery assertions stable:

1. `task_in_progress_ready_for_submit`
   A task assigned to the caller with at least one valid artifact URL and `availableActions` including `submit`.

2. `task_in_review_ci_running`
   A submitted task with CI checks in progress and reviewer feedback available.

3. `task_approved_ci_green`
   A task whose latest review is approved and whose CI summary is fully green so the ship path can succeed.

4. `task_event_stream_live_tail`
   A connected agent stream with no resume token that can observe new lifecycle events for at least one assigned task.

5. `task_event_stream_resume_window`
   An event outbox containing at least three ordered events for the same task, all within the 72 hour replay window.

6. `task_event_stream_cursor_expired`
   A previously valid cursor or event ID whose referenced event is older than the retained replay window.

7. `task_event_stream_filtered_task`
   Two tasks emitting interleaved events so task-level filtering can be verified without losing per-task ordering.

8. `agent_auth_admin_key`
   A scoped `auth:admin` key that can create and rotate keys and read usage.

9. `agent_auth_ci_reader_key`
   A scoped `ci:read` key with a deterministic fixed-window rate limit and GitHub external identity mapping.

## Happy-Path Assertions

### `POST /agent-api-keys`

Expect `201` with `AgentApiKeyResponse` when called with a valid `Idempotency-Key` and an admin credential, except for the documented bootstrap admin case.

Assertions:

1. `data.id` matches the `akey_` shape and `data.apiKey` matches the `ar_live_` shape.
2. `data.agent.externalIdentities` preserves provider subjects used for cross-tool attribution.
3. `data.scopes` is de-duplicated and contains only declared auth scopes.
4. Retrying the same request with the same `Idempotency-Key` replays the same accepted response.

### `POST /agent-api-keys/{keyId}/rotate`

Expect `201` with `AgentApiKeyResponse`.

Assertions:

1. The replacement `data.id` and `data.apiKey` differ from the rotated key.
2. `data.rotatedFromKeyId` points to the previous key.
3. The previous key no longer authenticates protected endpoints.
4. Identity, scopes, and rate limit are preserved unless an explicitly documented additive field is changed.

### `GET /agent-api-keys/{keyId}/usage`

Expect `200` with `AgentApiKeyUsageResponse`.

Assertions:

1. `data.totals.accepted` increments after a successful protected endpoint call.
2. `data.totals.denied` increments after an insufficient-scope or rate-limit denial.
3. `byScope` and `byOperation` remain compact arrays rather than raw request logs.
4. `rateLimit.currentWindow.remaining` reflects the deterministic fixture window.

### `GET /tasks/mine`

Expect `200` with `TaskListResponse`.

Assertions:

1. `data` is an array of task summaries with `id`, `identifier`, `status`, `priority`, `updatedAt`, and `availableActions`.
2. `page.hasMore` is boolean and `page.nextCursor` is present, even when null.
3. Top-level `availableActions` is present to advertise pagination behavior.
4. `meta.tokenBudgetHint` is one of the declared enum values.

### `GET /tasks/{id}`

Expect `200` with `TaskDetailResponse`.

Assertions:

1. `data.id` matches the requested task id fixture.
2. `data.acceptanceCriteria` is a non-empty array of strings.
3. `data.links.issue` is a fully qualified URI.
4. `data.availableActions` reflects the current lifecycle state from the fixture.

### `POST /tasks/{id}/submit`

Expect `202` with `TaskSubmissionResponse` when called with a valid `Idempotency-Key`.

Assertions:

1. `data.taskId` matches the requested task id.
2. `data.status` is `in_review`.
3. `data.reviewRoute.participants` contains at least one reviewer entry with `id` and `role`.
4. Response `availableActions` advertises review follow-up rather than task mutation.

### `GET /tasks/{id}/ci-status`

Expect `200` with `TaskCiStatusResponse`.

Assertions:

1. `data.overallStatus` is one of the declared CI enums.
2. `data.summary.passed`, `failed`, and `running` are non-negative integers.
3. Every `checks[]` entry has `name` and `status`; URLs may be null but the field must exist.
4. `data.availableActions` and top-level `availableActions` are both present.

### `GET /tasks/{id}/review-feedback`

Expect `200` with `TaskReviewFeedbackResponse`.

Assertions:

1. `data.latestDecision.outcome` is one of `approved`, `changes_requested`, or `pending`.
2. `data.latestDecision.reviewer` includes both `id` and `role`.
3. Every `comments[]` entry includes `id`, `authorRole`, `body`, and `severity`.
4. `data.availableActions` reflects whether the assignee should resubmit or proceed to ship.

### `POST /tasks/{id}/ship`

Expect `202` with `TaskShipResponse` when called with a valid `Idempotency-Key` and the green/approved fixture.

Assertions:

1. `data.taskId` matches the requested task id.
2. `data.operationId` is present and stable in shape across retries with the same idempotency key.
3. `data.status` is one of the declared ship operation enums.
4. `queuedAt` is a valid RFC 3339 timestamp and `availableActions` is present at both envelope levels.

## SSE Implementation Gates

Run these gates on every pull request that implements or changes `GET /task-events/stream` or the replay buffer behind it:

1. Stream connect on the live tail.
2. Resume via `Last-Event-ID` with `cursor` precedence validation.
3. Expired cursor handling against the 72 hour replay window.
4. Filtered task stream behavior with interleaved outbox traffic.

### `GET /task-events/stream` connect

Expect `200` with `text/event-stream` and the stream headers declared in the OpenAPI contract.

Assertions:

1. `Cache-Control` is `no-store`, `X-AgentRail-Replay-Window-Hours` is `72`, and `X-AgentRail-Resume-Mode` is `live` when no resume token is supplied.
2. The stream includes valid SSE frames using `id`, `event`, and `data`, and each `data` payload parses as `TaskLifecycleEventEnvelope`.
3. A keepalive comment arrives no later than the negotiated `heartbeatSeconds` plus a small transport tolerance.
4. The first delivered event represents a mutation that happened after the connection opened, proving live-tail behavior rather than implicit historical backfill.

### `GET /task-events/stream` resume via `Last-Event-ID`

Expect `200` with `text/event-stream` when the referenced event is still inside the replay window.

Assertions:

1. `Last-Event-ID` takes precedence over the `cursor` query parameter when both are supplied.
2. `X-AgentRail-Resume-Mode` is `replay_then_live`.
3. Replay starts strictly after the referenced event; the event identified by `Last-Event-ID` is not re-delivered.
4. Replayed events preserve increasing `sequence` values and monotonic `taskVersion` for each task before the stream switches to live delivery.

### `GET /task-events/stream` expired cursor

Expect `410` with `CursorExpired`.

Assertions:

1. `error.code` is `cursor_expired`.
2. `error.details.replayWindowHours` is `72`.
3. `error.details.availableActions` contains `reconnect_without_cursor`.

### `GET /task-events/stream` filtered task stream

Expect `200` with `text/event-stream` when `taskId` is provided.

Assertions:

1. Every delivered event `data.taskId` matches the requested task filter.
2. Events for other tasks may exist in the outbox, but they are never emitted on the filtered stream.
3. The filtered stream still preserves increasing `sequence` values across emitted events.
4. Event-type filtering and `taskId` filtering compose correctly when both are provided.

## Webhook Implementation Gates

Run these gates on every pull request that implements or changes the webhook subscription endpoints or delivery worker:

1. `POST /task-webhook-subscriptions` happy path.
2. `GET /task-webhook-subscriptions` and `GET /task-webhook-subscriptions/{subscriptionId}` visibility paths.
3. `DELETE /task-webhook-subscriptions/{subscriptionId}` happy path.
4. Delivery worker retry and disablement behavior.

### `POST /task-webhook-subscriptions`

Expect `201` with `TaskWebhookSubscriptionResponse` when called with a valid `Idempotency-Key`.

Assertions:

1. `data.id` matches the `whsub_` shape from the contract.
2. `data.status` is `active`.
3. `data.signingAlgorithm` is `hmac_sha256`.
4. `data.retryPolicy.maxAttempts` is `8`, `initialBackoffSeconds` is `10`, and `maxBackoffSeconds` is `3600`.
5. Retrying the same request with the same `Idempotency-Key` replays the same accepted response.

### `GET /task-webhook-subscriptions`

Expect `200` with `TaskWebhookSubscriptionListResponse`.

Assertions:

1. Active and disabled subscriptions are included for operational visibility.
2. Each listed item uses the same subscription data shape as the create/get/delete response.
3. The envelope-level `availableActions` includes `create`.

### `GET /task-webhook-subscriptions/{subscriptionId}`

Expect `200` with `TaskWebhookSubscriptionResponse`.

Assertions:

1. `data.id` matches the requested subscription.
2. `data.status` reflects the current active or disabled state.
3. Unknown subscription IDs return `404 not_found`.

### `DELETE /task-webhook-subscriptions/{subscriptionId}`

Expect `202` with `TaskWebhookSubscriptionResponse`.

Assertions:

1. `data.id` matches the requested subscription.
2. `data.status` is `disabled`.
3. `availableActions` is empty at both envelope levels.
4. Subsequent delivery worker scans do not enqueue new attempts for this subscription.

### Delivery worker

Seed one active subscription and one durable outbox event.

Assertions:

1. The first attempt sends the OpenAPI event envelope JSON and signs the raw body with `X-AgentRail-Signature`.
2. `X-AgentRail-Event-Id` remains constant across retries for the same event.
3. `X-AgentRail-Delivery-Id` changes on every attempt.
4. Retryable failures schedule attempts through the approved 8-attempt policy bounded from `10s` to `3600s`.
5. An explicit `410 Gone` disables the subscription and prevents further retries.
6. An eighth retryable failure marks the delivery terminal as exhausted.

## Out of Scope for This Gate

1. Negative-path assertions such as `404`, validation failures, and idempotency mismatches outside the duplicate/idempotent subscription flow.
2. Multi-region failover behavior for replay continuity.
3. Pagination edge cases beyond verifying the envelope contract on `GET /tasks/mine`.
