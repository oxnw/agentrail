# Changelog

## Unreleased

### Breaking

- Replaced task-webhook subscriptions with generic AgentRail event subscriptions. Consumers should move from `/task-webhook-subscriptions` to `/event-subscriptions`.
- Event subscription IDs now use the `evsub_` prefix instead of `whsub_`.
- Event delivery requests now identify the subscription with `X-AgentRail-Subscription-Id`; consumers that previously read `X-AgentRail-Webhook-Id` should update their header parsing.
- Local file persistence now uses `AGENTRAIL_EVENT_SUBSCRIPTION_STORE_PATH` and `AGENTRAIL_EVENT_DELIVERY_STORE_PATH` for event subscription and delivery state.

### Added

- Added `agentrail event subscribe`, `agentrail event subscriptions`, and `agentrail event unsubscribe` for managing event subscriptions from the CLI.
