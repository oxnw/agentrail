# Changelog

## 0.1.4 - 2026-05-19

### Breaking

- Replaced task-webhook subscriptions with generic AgentRail event subscriptions. Consumers should move from `/task-webhook-subscriptions` to `/event-subscriptions`.
- Event subscription IDs now use the `evsub_` prefix instead of `whsub_`.
- Event delivery requests now identify the subscription with `X-AgentRail-Subscription-Id`; consumers that previously read `X-AgentRail-Webhook-Id` should update their header parsing.
- Local file persistence now uses `AGENTRAIL_EVENT_SUBSCRIPTION_STORE_PATH` and `AGENTRAIL_EVENT_DELIVERY_STORE_PATH` for event subscription and delivery state.

### Added

- Added `agentrail event subscribe`, `agentrail event subscriptions`, and `agentrail event unsubscribe` for managing event subscriptions from the CLI.
- Added managed local runner supervision so AgentRail can keep configured local agents awake and start assigned work from task events.
- Added run-scoped managed runner context commands and APIs so child agents can inspect only their assigned run/task context.
- Added AI-assisted task routing with setup-time choices for local runner/model and fallback behavior when no suitable agent exists.
- Added stricter managed-runner execution policies for Codex, Claude Code, Cursor, and external sandbox wrappers.
- Added GitHub Actions and CircleCI lifecycle coverage for PR submission, CI summaries, review feedback, shipping, rollback readiness, and provider metadata.
- Added regression coverage for npm package hygiene, OpenAPI/SDK freshness fields, lifecycle transitions, and end-to-end server runtime wiring.

### Changed

- Updated local setup, provider setup, doctor checks, and integration docs around hosted-aware local operation, AI routing, and provider readiness.
- Renamed user-facing routing setup language from skills to capabilities to avoid confusion with agent runtime skills.
- Improved task actions and blocker wording so agents and users see clearer next steps after CI failures, review feedback, or missing provider setup.

### Fixed

- Fixed the stock server runtime so GitHub submit and ship operations call the GitHub API instead of the local AgentRail public URL.
- Fixed provider-backed shipping so merged tasks persist `done` state, rollback availability, ship operation metadata, and merge commit metadata.
- Fixed managed runner lifecycle reliability around review-change wakeups, CI recovery, stale CI/review observations, and duplicate GitHub PR submissions.
- Fixed managed runner worktree writes, run handoff writes, protected instruction file mode restoration, and strict runner policy checks.
- Fixed CircleCI setup and readiness to use full project slugs, support automatic branch-triggered projects, retry failed API triggers, and bound trigger dedupe memory.
- Fixed GitHub and CircleCI provider setup readiness so `provider connect` can create missing CI templates and report what still needs to be committed or configured.
- Fixed GitHub polling so first-run imports can start from now instead of pulling historical issues unexpectedly.
