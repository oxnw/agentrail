# AgentRail MVP Completeness Scorecard

Version: `2026-05-05.1`
Owner: CTO
Review cadence: update when an implementation issue changes status or when
evidence changes in code, contracts, tests, or docs.

This scorecard tracks implementation completeness for the AgentRail MVP. It is
intentionally weighted around the production/live control-plane path, not the
deterministic local demo alone.

## Current Scores

| Track | Score | Meaning |
| --- | ---: | --- |
| Demo completeness | 86 / 100 | The local OSS demo can show the issue -> PR -> CI -> review -> ship loop without hosted dependencies. |
| Production/live control-plane completeness | 45 / 100 | The live MVP still depends on durable task storage, intake, routing, auth wiring, submit persistence, and ship behavior work. |

The production/live control-plane score is the primary MVP completeness score.
The demo score is reported separately so deterministic fixture coverage is not
mistaken for live control-plane readiness.

## Capability Scorecard

| Capability | Weight | Current score | Demo completeness | Production/live evidence | Implementation issues |
| --- | ---: | ---: | --- | --- | --- |
| Public lifecycle API and SDK contract | 15 | 12 | Complete for the local lifecycle demo and SDK examples. | `docs/api/task-lifecycle.openapi.yaml`, TypeScript SDK, and Python SDK expose task list/get, submit, CI, review, events, webhooks, rollback, and ship contracts. Adapter-managed submit is now contract-visible, but live persistence still depends on follow-up work. | [AGEA-94](/AGEA/issues/AGEA-94), [AGEA-101](/AGEA/issues/AGEA-101) |
| Explicit demo/runtime separation | 6 | 6 | Complete: deterministic demo is behind explicit demo mode. | `src/server.ts` no longer treats demo fixtures as the default production-like runtime. This prevents demo behavior from inflating live readiness. | [AGEA-96](/AGEA/issues/AGEA-96) |
| Durable live task store and per-agent queue | 15 | 2 | Demo store works for the fixed local task. | Live server mode still needs persisted task records, status filtering, provider source refs, available actions, task versions, and authenticated per-agent filtering. | [AGEA-97](/AGEA/issues/AGEA-97), [AGEA-100](/AGEA/issues/AGEA-100) |
| GitHub issue intake into AgentRail tasks | 12 | 1 | Not part of the deterministic demo path. | Operator intake OpenAPI and routing docs exist, but GitHub issue webhook/sync ingestion and idempotent task upsert remain implementation work. | [AGEA-98](/AGEA/issues/AGEA-98), [AGEA-103](/AGEA/issues/AGEA-103) |
| Routing engine and assignment persistence | 12 | 3 | Demo assignment is static. | Routing architecture is documented and in review; implementation is blocked until the design is accepted. Live MVP still needs deterministic rule evaluation, triage fallback, assignment writes, and audit records. | [AGEA-95](/AGEA/issues/AGEA-95), [AGEA-99](/AGEA/issues/AGEA-99), [AGEA-103](/AGEA/issues/AGEA-103) |
| Least-privilege agent auth and task isolation | 8 | 4 | Demo mode intentionally has open local routes. | `AgentAuthStore` and auth tests exist, but the default server runtime still needs auth store construction, scoped key bootstrap, protected lifecycle routes, and cross-agent task isolation. | [AGEA-100](/AGEA/issues/AGEA-100) |
| Adapter-managed submit persistence and PR metadata | 10 | 4 | Artifact-mode demo submit works without provider credentials. | `GitHubSubmitAdapter` can create/reuse PRs and the public contract supports `mode: "adapter_managed"`, but idempotency and PR metadata must survive restart and update canonical task state. | [AGEA-94](/AGEA/issues/AGEA-94), [AGEA-101](/AGEA/issues/AGEA-101) |
| CI and review feedback adapters | 8 | 6 | Demo CI/review loop is complete for deterministic attempts. | GitHub Actions, CircleCI, and GitHub review feedback adapters exist with tests. Live readiness still depends on durable task PR metadata rather than manually configured task sources. | [AGEA-101](/AGEA/issues/AGEA-101) |
| Live ship operation | 7 | 2 | Demo ship reaches `done` in the deterministic flow. | GitHub-backed live shipping still needs policy, idempotent operation state, failure-mode handling, task transition persistence, and tests for blocked ship cases. | [AGEA-102](/AGEA/issues/AGEA-102) |
| Push events, webhooks, and execution visibility | 7 | 5 | Demo and tests cover compact task events. | SSE task events, webhook subscriptions, delivery retry/backoff, and structured events are present. Live scoring should increase only when events are backed by durable live task changes and docs are labeled current vs planned. | [AGEA-103](/AGEA/issues/AGEA-103) |

Total production/live control-plane score: **45 / 100**.

## Demo Completeness Snapshot

The demo score is intentionally separate from the live MVP score.

| Area | Score | Evidence |
| --- | ---: | --- |
| Local startup and quickstart | 18 / 20 | README, quick start, `npm run demo:server`, and Docker instructions describe the local path. |
| End-to-end lifecycle flow | 24 / 25 | Deterministic demo covers assigned task, submit, CI failure, review feedback, resubmit, CI pass, approval, and ship. |
| SDK usability | 16 / 20 | TypeScript and Python SDK docs show local base URLs and lifecycle calls. |
| Token-efficiency proof | 12 / 15 | Demo report compares compact AgentRail responses to raw GitHub-shaped payloads. |
| Runtime honesty | 10 / 10 | Demo mode is explicit after AGEA-96. |
| Current-vs-planned labeling | 6 / 10 | Docs have improved labels, but AGEA-103 remains open for contract gates and complete labeling. |

Total demo score: **86 / 100**.

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
