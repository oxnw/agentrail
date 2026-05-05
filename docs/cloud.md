# AgentRail Cloud Boundary

AgentRail has two deliberately different surfaces:

- **AgentRail OSS** is the runnable local and self-managed product. It proves
  the agent lifecycle, preserves developer sovereignty, and gives teams a real
  API and SDK surface they can inspect, run, and extend.
- **AgentRail Cloud** is the planned managed team and fleet operations layer. It
  is not just hosting the Node server from this repository on someone else's
  VM.

Cloud is not generally available yet. Public docs should not imply hosted SLAs,
SOC2/compliance coverage, or production support commitments until those
operations exist and are explicitly launched.

## What OSS Includes

The public repository should stay useful without a hosted account:

- Local API server and explicit self-hosted bootstrap examples.
- Task lifecycle API contract and SDKs.
- Single-instance/self-managed runtime path.
- Local event streaming and webhook primitives.
- Adapter interfaces and local or manually configured provider adapters.
- Documentation for running, testing, and integrating coding agents.

This means an individual or power user can self-host AgentRail on local
hardware or a cheap VPS for a single-agent or small self-managed workflow. That
is an intentional OSS adoption path, not a failure of the Cloud business.

## How Connector Operations Differ

The agent-facing lifecycle flow should feel similar in OSS and Cloud: the
coding agent calls AgentRail, and AgentRail normalizes provider state into
compact tasks, actions, CI status, review feedback, events, and audit history.
The difference is who owns the third-party integration operations.

In local or self-managed OSS:

- The customer supplies credentials such as a personal access token,
  customer-owned GitHub App, CircleCI token, webhook secret, Linear token, or
  Jira token.
- The customer's AgentRail instance calls provider APIs from the customer's
  laptop, server, VPS, or Railway deployment.
- The customer owns public webhook exposure, TLS/DNS/tunnels, HMAC validation,
  missed-event recovery, backfills, rate-limit handling, secret rotation,
  upgrades, logs, and backup/restore.
- Provider state is usually wired through local config, environment variables,
  or a customer-managed database.

In AgentRail Cloud:

- The team connects providers through AgentRail-managed OAuth or app install
  flows.
- AgentRail operates credential storage, rotation, webhook endpoints,
  signature validation, dedupe, retries, replay/backfill, and provider API
  drift handling.
- Cloud persists task state, routing decisions, run history, event cursors,
  audit logs, dashboards, and team/workspace metadata.
- Cloud can enforce team governance through SSO/RBAC/SCIM, scoped agent keys,
  repository allowlists, retention, audit export, and compliance evidence.

OSS interacts with providers as your infrastructure using your credentials.
Cloud interacts with providers as AgentRail's managed integration on behalf of
the workspace.

## What Cloud Owns

Cloud should own the parts that are operationally expensive for teams to run
well:

- Managed GitHub, Linear, Jira, GitLab, CircleCI, and future provider
  connectors, including OAuth apps, credential rotation, webhook verification,
  backfills, rate-limit handling, and provider API drift.
- Durable shared run history, governed cross-agent memory, event replay,
  backups, and retention controls.
- Fleet routing and wakes: assignment rules, capability tags, triage fallback,
  handoffs, conflict arbitration, and routing audit history.
- Team access control: SSO/SAML/OIDC, SCIM, RBAC, least-privilege agent keys,
  audit logs, retention, and export.
- Operational dashboards for agent runs, token savings, failure modes,
  lifecycle bottlenecks, and per-agent or per-team attribution.
- Hosted reliability: high availability, queue durability, monitoring,
  incident response, backup/restore, support, and compliance evidence.

The paid value is operational leverage and governance for teams, not the
ability to start an HTTP process.

## Messaging Rules

Use these rules in public docs and launch copy:

- Say "local OSS", "self-managed OSS", or "single-instance self-hosting" when
  describing what this repository can run today.
- Say "planned AgentRail Cloud" or "future managed Cloud" until hosted Cloud is
  generally available.
- Do not use generic "team workspaces" as the main Cloud differentiator. Name
  the hard layer: managed connectors, durable run history, governed memory,
  routing and wakes, SSO/RBAC/SCIM, audit, dashboards, support, compliance, and
  hosted reliability.
- Do not describe one-click deploy or self-hosting as a Cloud-equivalent team
  control plane.
- Do not claim live provider, SLA, compliance, or production readiness unless
  the current implementation and validation gates support the claim.

## Features That Should Not Become Turnkey OSS

OSS can expose compatible APIs and local development substitutes, but durable
Cloud differentiation depends on not shipping the complete production-grade
team control plane as a turnkey OSS package:

- Multi-tenant organization/workspace service with full SSO, SCIM,
  fine-grained RBAC, audit logs, and retention policies.
- Hosted credential vaulting and managed OAuth apps for provider connectors.
- Cloud-hosted provider reconciliation, backfill, and rate-limit budgets.
- Governed cross-agent shared memory with provenance, access control,
  retention, and team-wide search.
- Fleet routing, capacity management, wake orchestration, assignment audits,
  and conflict arbitration UI/API.
- Production dashboards for run history, token savings, failure modes,
  lifecycle bottlenecks, and per-agent or team attribution.
- Compliance package: SOC2/ISO evidence, support SLAs, backup/restore
  guarantees, audit export, and vendor security review materials.

The boundary is simple: OSS proves the lifecycle and gives individuals
sovereignty. Cloud makes the same operating model reliable, governed,
observable, and cheap for teams to run.
