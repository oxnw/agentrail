# AgentRail MVP Completeness Scorecard

Version: `2026-05-06.1`
Owner: CTO
Review cadence: update when an implementation issue changes status or when
evidence changes in code, contracts, tests, or docs.

This scorecard tracks implementation completeness for the AgentRail MVP. It is
intentionally weighted around the production/live control-plane path, not the
deterministic local demo alone.

## Current Scores

| Track | Score | Meaning |
| --- | ---: | --- |
| Demo completeness | 90 / 100 | The local OSS path now includes explicit setup scaffolding plus `agentrail doctor` readiness verification. |
| Production/live control-plane completeness | 74 / 100 | Durable task storage, auth wiring, GitHub issue intake, routing, setup verification, and adapter-managed source persistence are implemented; remaining work is mostly provider breadth, cloud operations, and production hardening. |

The production/live control-plane score is the primary MVP completeness score.
The demo score is reported separately so deterministic fixture coverage is not
mistaken for live control-plane readiness.

## Capability Scorecard

| Capability | Weight | Current score | Demo completeness | Production/live evidence | Implementation issues |
| --- | ---: | ---: | --- | --- | --- |
| Public lifecycle API and SDK contract | 15 | 13 | Complete for the local lifecycle demo and SDK examples. | `docs/api/task-lifecycle.openapi.yaml`, TypeScript SDK, and Python SDK expose task list/get, submit, CI, review, events, webhooks, rollback, and ship contracts. Adapter-managed submit and task-source metadata are contract-visible and backed by tests. | [AGEA-94](/AGEA/issues/AGEA-94), [AGEA-101](/AGEA/issues/AGEA-101), [AGEA-127](/AGEA/issues/AGEA-127) |
| Explicit demo/runtime separation | 6 | 6 | Complete: deterministic demo is behind explicit demo mode. | `src/server.ts` no longer treats demo fixtures as the default production-like runtime. This prevents demo behavior from inflating live readiness. | [AGEA-96](/AGEA/issues/AGEA-96) |
| Durable live task store and per-agent queue | 15 | 11 | Local setup now uses explicit task-store state instead of hidden fixtures. | `TaskStore`, `AgentTaskQueue`, server runtime wiring, persisted provider source refs, available actions, task versions, status filtering, and authenticated per-agent filtering are implemented with restart tests. | [AGEA-97](/AGEA/issues/AGEA-97), [AGEA-100](/AGEA/issues/AGEA-100), [AGEA-127](/AGEA/issues/AGEA-127) |
| GitHub issue intake into AgentRail tasks | 12 | 9 | GitHub issue intake can create/update tasks in the local OSS runtime when configured. | `GitHubIssueIntakeAdapter`, `/providers/github/intake`, idempotent replay, sparse webhook update behavior, GitHub API issue URL parsing, and source persistence are implemented and tested. Remaining work is provider deployment/ops hardening. | [AGEA-98](/AGEA/issues/AGEA-98), [AGEA-103](/AGEA/issues/AGEA-103) |
| Routing engine and assignment persistence | 12 | 9 | Setup verification and provider intake exercise real assignment paths. | `RoutingControlPlane`, agent profile/rule stores, deterministic rule evaluation, triage fallback, assignment writes, audit lookup, idempotency replay persistence, and setup verification task creation are implemented with endpoint and store tests. Classifier fallback remains intentionally not implemented. | [AGEA-95](/AGEA/issues/AGEA-95), [AGEA-99](/AGEA/issues/AGEA-99), [AGEA-120](/AGEA/issues/AGEA-120), [AGEA-121](/AGEA/issues/AGEA-121), [AGEA-103](/AGEA/issues/AGEA-103) |
| Least-privilege agent auth and task isolation | 8 | 7 | Local setup now provisions scoped keys and verifies agent visibility through `agentrail doctor`. | `AgentAuthStore` is wired into server runtime; scoped key bootstrap, protected lifecycle routes, routing admin scopes, and cross-agent task isolation are covered by tests. | [AGEA-100](/AGEA/issues/AGEA-100), [AGEA-121](/AGEA/issues/AGEA-121) |
| Adapter-managed submit persistence and PR metadata | 10 | 8 | Artifact-mode demo submit remains available for local deterministic examples. | `GitHubSubmitAdapter` can create/reuse PRs, submit idempotency persists across restarts, PR metadata updates canonical task state, and CI/review/rollback source resolution can use persisted task source metadata. | [AGEA-94](/AGEA/issues/AGEA-94), [AGEA-101](/AGEA/issues/AGEA-101), [AGEA-127](/AGEA/issues/AGEA-127) |
| CI and review feedback adapters | 8 | 7 | Demo CI/review loop is complete for deterministic attempts. | GitHub Actions, CircleCI, and GitHub review feedback adapters exist with tests and can resolve provider context from persisted task source/submission metadata, reducing dependence on manually configured task sources. | [AGEA-101](/AGEA/issues/AGEA-101), [AGEA-127](/AGEA/issues/AGEA-127) |
| Live ship operation | 7 | 5 | Demo ship reaches `done` in the deterministic flow. | GitHub-backed ship and rollback paths exist with idempotency, failure-mode tests, and task transition persistence. Remaining work is production policy and operational hardening. | [AGEA-102](/AGEA/issues/AGEA-102) |
| Push events, webhooks, and execution visibility | 7 | 6 | Demo and tests cover compact task events. | SSE task events, webhook subscriptions, delivery retry/backoff, structured events, and durable task-change backing are present. Remaining work is broader production monitoring and labeling completeness. | [AGEA-103](/AGEA/issues/AGEA-103) |

Total production/live control-plane score: **74 / 100**.

## Demo Completeness Snapshot

The demo score is intentionally separate from the live MVP score.

| Area | Score | Evidence |
| --- | ---: | --- |
| Local startup and quickstart | 19 / 20 | README, quick start, setup CLI docs, `agentrail doctor`, and Docker instructions describe the local path. |
| End-to-end lifecycle flow | 24 / 25 | Deterministic demo covers assigned task, submit, CI failure, review feedback, resubmit, CI pass, approval, and ship. |
| SDK usability | 16 / 20 | TypeScript and Python SDK docs show local base URLs and lifecycle calls. |
| Token-efficiency proof | 12 / 15 | Demo report compares compact AgentRail responses to raw GitHub-shaped payloads. |
| Runtime honesty | 10 / 10 | Demo mode is explicit after AGEA-96. |
| Current-vs-planned labeling | 9 / 10 | README, quick start, and integration guide label current, legacy, and planned setup/runtime behavior. |

Total demo score: **90 / 100**.

## Update Process

1. Update this document in the same PR or heartbeat that materially changes one
   of the linked implementation issues.
2. Only increase a capability score when there is durable evidence: merged code,
   passing tests, OpenAPI examples, SDK surface updates, or user-facing docs.
3. For API endpoints, evidence must include request and response examples in the
   relevant OpenAPI document before scoring the endpoint as complete.
4. For live-control-plane capabilities, demo-only fixture behavior can support
   the demo score, but it cannot increase the production/live score.
5. If an issue regresses, is blocked, or reveals a larger gap, reduce the score
   in the same change and note the blocker in the evidence column.
6. Keep implementation issue links current. Closed issues remain linked as
   evidence; open issues remain linked as the next source of score movement.
7. Bump the `Version` field using `YYYY-MM-DD.N` on every score change.

## Scoring Rules

- `0`: no code or contract exists.
- `1-3`: design or partial contract exists, but the runtime cannot execute the
  capability in the target track.
- `4-6`: runtime path exists for a narrow or manually configured case, with
  missing persistence, isolation, failure handling, or docs.
- `7-9`: capability works in live-like mode with tests for common cases, but has
  known limitations.
- Full weight: capability is implemented, documented, tested, and backed by the
  correct live persistence and auth boundaries.
